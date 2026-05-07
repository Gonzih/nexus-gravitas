import { getPool, getClient } from './db.js';

export interface Fact {
  op: 'assert' | 'retract';
  entity: string;
  attribute: string;
  value: string;
}

export interface TransactResult {
  tx_id: number;
  tx_at: string;
  count: number;
}

export interface Datom {
  id: number;
  entity: string;
  attribute: string;
  value: string;
  value_num: number | null;
  value_ts: string | null;
  tx_id: number;
  retracted: boolean;
  created_at: string;
}

export interface CurrentFact {
  attribute: string;
  value: string;
  value_num: number | null;
  value_ts: string | null;
  tx_id: number;
  tx_at: string;
}

export interface HistoryEntry extends Datom {
  tx_at: string;
  agent_id: string | null;
  note: string | null;
}

export interface TransactionRecord {
  id: number;
  tx_at: string;
  agent_id: string | null;
  note: string | null;
}

export interface TransactionWithDatoms extends TransactionRecord {
  datoms: Datom[];
}

export interface StatsResult {
  total_datoms: number;
  total_transactions: number;
  total_entities: number;
  total_attributes: number;
  db_size: string;
}

export interface AttributeStat {
  attribute: string;
  usage_count: number;
}

// Raw row types as returned by pg (timestamps are Date objects, bigints as strings)
interface RawTxRow {
  id: string;
  tx_at: Date;
  agent_id: string | null;
  note: string | null;
}

interface RawCurrentFactRow {
  attribute: string;
  value: string;
  value_num: string | null;
  value_ts: Date | null;
  tx_id: string;
  tx_at: Date;
}

interface RawDatomRow {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  value_num: string | null;
  value_ts: Date | null;
  tx_id: string;
  retracted: boolean;
  created_at: Date;
}

interface RawHistoryRow extends RawDatomRow {
  tx_at: Date;
  agent_id: string | null;
  note: string | null;
}

function parseTx(row: RawTxRow): TransactionRecord {
  return {
    id: parseInt(row.id, 10),
    tx_at: row.tx_at instanceof Date ? row.tx_at.toISOString() : String(row.tx_at),
    agent_id: row.agent_id,
    note: row.note,
  };
}

function parseCurrentFact(row: RawCurrentFactRow): CurrentFact {
  return {
    attribute: row.attribute,
    value: row.value,
    value_num: row.value_num !== null ? parseFloat(row.value_num) : null,
    value_ts: row.value_ts instanceof Date ? row.value_ts.toISOString() : row.value_ts,
    tx_id: parseInt(row.tx_id, 10),
    tx_at: row.tx_at instanceof Date ? row.tx_at.toISOString() : String(row.tx_at),
  };
}

function parseDatom(row: RawDatomRow): Datom {
  return {
    id: parseInt(row.id, 10),
    entity: row.entity,
    attribute: row.attribute,
    value: row.value,
    value_num: row.value_num !== null ? parseFloat(row.value_num) : null,
    value_ts: row.value_ts instanceof Date ? row.value_ts.toISOString() : row.value_ts,
    tx_id: parseInt(row.tx_id, 10),
    retracted: row.retracted,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function parseHistoryEntry(row: RawHistoryRow): HistoryEntry {
  return {
    ...parseDatom(row),
    tx_at: row.tx_at instanceof Date ? row.tx_at.toISOString() : String(row.tx_at),
    agent_id: row.agent_id,
    note: row.note,
  };
}

/** Transact a batch of facts atomically. */
export async function transact(
  facts: Fact[],
  agent_id?: string,
  note?: string
): Promise<TransactResult> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const txResult = await client.query<RawTxRow>(
      'INSERT INTO transactions (agent_id, note) VALUES ($1, $2) RETURNING id, tx_at, agent_id, note',
      [agent_id ?? null, note ?? null]
    );

    const txRow = txResult.rows[0];
    if (!txRow) throw new Error('Failed to create transaction');
    const txId = parseInt(txRow.id, 10);
    const txAt = txRow.tx_at instanceof Date ? txRow.tx_at.toISOString() : String(txRow.tx_at);

    let count = 0;
    for (const fact of facts) {
      const numVal = tryParseNumber(fact.value);
      const tsVal = tryParseTimestamp(fact.value);
      const retracted = fact.op === 'retract';

      await client.query(
        `INSERT INTO datoms (entity, attribute, value, value_num, value_ts, tx_id, retracted)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [fact.entity, fact.attribute, fact.value, numVal, tsVal, txId, retracted]
      );
      count++;
    }

    await client.query('COMMIT');
    return { tx_id: txId, tx_at: txAt, count };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Get current facts for an entity (latest non-retracted value per attribute). */
export async function getEntity(
  entity: string,
  attribute?: string
): Promise<CurrentFact[]> {
  const params: unknown[] = [entity];
  let attrFilter = '';
  if (attribute !== undefined) {
    params.push(attribute);
    attrFilter = `AND d.attribute = $${params.length}`;
  }

  // Within the same tx_id, a higher datom id means it was inserted later.
  // For a retract+assert in one tx, the assert has a higher id and wins rn=1.
  const sql = `
    WITH ranked AS (
      SELECT
        d.attribute,
        d.value,
        d.value_num,
        d.value_ts,
        d.tx_id,
        d.retracted,
        t.tx_at,
        ROW_NUMBER() OVER (PARTITION BY d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      WHERE d.entity = $1
      ${attrFilter}
    )
    SELECT attribute, value, value_num, value_ts, tx_id, tx_at
    FROM ranked
    WHERE rn = 1 AND retracted = false
    ORDER BY attribute
  `;

  const result = await getPool().query<RawCurrentFactRow>(sql, params);
  return result.rows.map(parseCurrentFact);
}

/** Find all entities currently having attribute=value. */
export async function findEntities(
  attribute: string,
  value: string
): Promise<string[]> {
  const sql = `
    WITH ranked AS (
      SELECT
        entity,
        value,
        retracted,
        ROW_NUMBER() OVER (PARTITION BY entity ORDER BY tx_id DESC, id DESC) AS rn
      FROM datoms
      WHERE attribute = $1
    )
    SELECT DISTINCT entity
    FROM ranked
    WHERE rn = 1 AND retracted = false AND value = $2
    ORDER BY entity
  `;

  const result = await getPool().query<{ entity: string }>(sql, [attribute, value]);
  return result.rows.map((r) => r.entity);
}

/** Query current state with optional filters. */
export async function queryDatoms(
  entity_pattern?: string,
  attribute?: string,
  since?: string
): Promise<(CurrentFact & { entity: string })[]> {
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (entity_pattern !== undefined) {
    params.push(entity_pattern);
    conditions.push(`d.entity LIKE $${params.length}`);
  }
  if (attribute !== undefined) {
    params.push(attribute);
    conditions.push(`d.attribute = $${params.length}`);
  }
  if (since !== undefined) {
    params.push(since);
    conditions.push(`t.tx_at >= $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  const sql = `
    WITH ranked AS (
      SELECT
        d.entity,
        d.attribute,
        d.value,
        d.value_num,
        d.value_ts,
        d.tx_id,
        d.retracted,
        t.tx_at,
        ROW_NUMBER() OVER (PARTITION BY d.entity, d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      WHERE true
      ${whereClause}
    )
    SELECT entity, attribute, value, value_num, value_ts, tx_id, tx_at
    FROM ranked
    WHERE rn = 1 AND retracted = false
    ORDER BY entity, attribute
  `;

  const result = await getPool().query<RawCurrentFactRow & { entity: string }>(sql, params);
  return result.rows.map((row) => ({
    entity: row.entity,
    ...parseCurrentFact(row),
  }));
}

/** Get state of entity at a specific point in time. */
export async function asOf(
  entity: string,
  tx_id?: number,
  timestamp?: string,
  attribute?: string
): Promise<CurrentFact[]> {
  if (tx_id === undefined && timestamp === undefined) {
    throw new Error('Either tx_id or timestamp must be provided');
  }

  const params: unknown[] = [entity];
  let timeFilter: string;

  if (tx_id !== undefined) {
    params.push(tx_id);
    timeFilter = `AND d.tx_id <= $${params.length}`;
  } else {
    params.push(timestamp!);
    timeFilter = `AND t.tx_at <= $${params.length}`;
  }

  let attrFilter = '';
  if (attribute !== undefined) {
    params.push(attribute);
    attrFilter = `AND d.attribute = $${params.length}`;
  }

  const sql = `
    WITH ranked AS (
      SELECT
        d.attribute,
        d.value,
        d.value_num,
        d.value_ts,
        d.tx_id,
        d.retracted,
        t.tx_at,
        ROW_NUMBER() OVER (PARTITION BY d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      WHERE d.entity = $1
      ${timeFilter}
      ${attrFilter}
    )
    SELECT attribute, value, value_num, value_ts, tx_id, tx_at
    FROM ranked
    WHERE rn = 1 AND retracted = false
    ORDER BY attribute
  `;

  const result = await getPool().query<RawCurrentFactRow>(sql, params);
  return result.rows.map(parseCurrentFact);
}

/** Get full history of all datoms (including retractions) for entity/attribute. */
export async function getHistory(
  entity: string,
  attribute?: string
): Promise<HistoryEntry[]> {
  const params: unknown[] = [entity];
  let attrFilter = '';
  if (attribute !== undefined) {
    params.push(attribute);
    attrFilter = `AND d.attribute = $${params.length}`;
  }

  const sql = `
    SELECT
      d.id,
      d.entity,
      d.attribute,
      d.value,
      d.value_num,
      d.value_ts,
      d.tx_id,
      d.retracted,
      d.created_at,
      t.tx_at,
      t.agent_id,
      t.note
    FROM datoms d
    JOIN transactions t ON d.tx_id = t.id
    WHERE d.entity = $1
    ${attrFilter}
    ORDER BY d.tx_id ASC, d.id ASC
  `;

  const result = await getPool().query<RawHistoryRow>(sql, params);
  return result.rows.map(parseHistoryEntry);
}

/** Get all datoms added after a given transaction. */
export async function sinceTransaction(
  tx_id: number,
  entity_pattern?: string
): Promise<HistoryEntry[]> {
  const params: unknown[] = [tx_id];
  let entityFilter = '';
  if (entity_pattern !== undefined) {
    params.push(entity_pattern);
    entityFilter = `AND d.entity LIKE $${params.length}`;
  }

  const sql = `
    SELECT
      d.id,
      d.entity,
      d.attribute,
      d.value,
      d.value_num,
      d.value_ts,
      d.tx_id,
      d.retracted,
      d.created_at,
      t.tx_at,
      t.agent_id,
      t.note
    FROM datoms d
    JOIN transactions t ON d.tx_id = t.id
    WHERE d.tx_id > $1
    ${entityFilter}
    ORDER BY d.tx_id ASC, d.id ASC
  `;

  const result = await getPool().query<RawHistoryRow>(sql, params);
  return result.rows.map(parseHistoryEntry);
}

/** List distinct entities in DB. */
export async function listEntities(attribute_filter?: string): Promise<string[]> {
  const params: unknown[] = [];
  let filter = '';
  if (attribute_filter !== undefined) {
    params.push(attribute_filter);
    filter = `WHERE attribute = $1`;
  }

  const sql = `SELECT DISTINCT entity FROM datoms ${filter} ORDER BY entity`;
  const result = await getPool().query<{ entity: string }>(sql, params);
  return result.rows.map((r) => r.entity);
}

/** List distinct attributes and their usage count. */
export async function listAttributes(): Promise<AttributeStat[]> {
  const sql = `
    SELECT attribute, COUNT(*) AS usage_count
    FROM datoms
    GROUP BY attribute
    ORDER BY usage_count DESC, attribute
  `;
  const result = await getPool().query<{ attribute: string; usage_count: string }>(sql);
  return result.rows.map((r) => ({
    attribute: r.attribute,
    usage_count: parseInt(r.usage_count, 10),
  }));
}

/** Get transaction metadata + all datoms in that tx. */
export async function getTransaction(tx_id: number): Promise<TransactionWithDatoms> {
  const txResult = await getPool().query<RawTxRow>(
    'SELECT id, tx_at, agent_id, note FROM transactions WHERE id = $1',
    [tx_id]
  );
  if (txResult.rows.length === 0) {
    throw new Error(`Transaction ${tx_id} not found`);
  }
  const tx = parseTx(txResult.rows[0]!);

  const datomResult = await getPool().query<RawDatomRow>(
    `SELECT id, entity, attribute, value, value_num, value_ts, tx_id, retracted, created_at
     FROM datoms WHERE tx_id = $1 ORDER BY id`,
    [tx_id]
  );

  return {
    ...tx,
    datoms: datomResult.rows.map(parseDatom),
  };
}

/** Get database statistics. */
export async function getStats(): Promise<StatsResult> {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM datoms)::bigint AS total_datoms,
      (SELECT COUNT(*) FROM transactions)::bigint AS total_transactions,
      (SELECT COUNT(DISTINCT entity) FROM datoms)::bigint AS total_entities,
      (SELECT COUNT(DISTINCT attribute) FROM datoms)::bigint AS total_attributes,
      pg_size_pretty(pg_database_size(current_database())) AS db_size
  `;
  const result = await getPool().query<{
    total_datoms: string;
    total_transactions: string;
    total_entities: string;
    total_attributes: string;
    db_size: string;
  }>(sql);
  const r = result.rows[0]!;
  return {
    total_datoms: parseInt(r.total_datoms, 10),
    total_transactions: parseInt(r.total_transactions, 10),
    total_entities: parseInt(r.total_entities, 10),
    total_attributes: parseInt(r.total_attributes, 10),
    db_size: r.db_size,
  };
}

// Helpers

function tryParseNumber(value: string): number | null {
  const n = Number(value);
  if (!isNaN(n) && value.trim() !== '') return n;
  return null;
}

function tryParseTimestamp(value: string): string | null {
  // Basic ISO 8601 heuristic
  if (/^\d{4}-\d{2}-\d{2}(T|\s)/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
