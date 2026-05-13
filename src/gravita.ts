import { getPool, getClient } from './db.js';
import {
  WEIGHT_INITIAL,
  WEIGHT_CORROBORATION_DELTA,
  applyWeightsOnAssert,
  logWeightEvent,
  computeEffectiveWeight,
  WEIGHT_FLOOR,
  WEIGHT_CEILING,
  WEIGHT_CONTRADICTION_DELTA,
} from './weight.js';

export interface Fact {
  op: 'assert' | 'retract';
  entity: string;
  attribute: string;
  value: string;
  /** ISO 8601: when this fact starts being true in the world (null = open-ended start) */
  valid_from?: string;
  /** ISO 8601: when this fact stops being true in the world (null = open-ended end) */
  valid_until?: string;
  /** ISO 8601: when the source system originally recorded this fact */
  authored_at?: string;
  /** Identifier of the source system that asserted this fact */
  source_id?: string;
}

export interface TransactResult {
  tx_id: number;
  tx_at: string;
  count: number;
}

export interface Gravit {
  id: number;
  entity: string;
  attribute: string;
  value: string;
  value_num: number | null;
  value_ts: string | null;
  tx_id: number;
  retracted: boolean;
  created_at: string;
  influence_weight: number;
  valid_from: string | null;
  valid_until: string | null;
  authored_at: string | null;
  source_id: string | null;
}

export interface CurrentFact {
  attribute: string;
  value: string;
  value_num: number | null;
  value_ts: string | null;
  tx_id: number;
  tx_at: string;
  influence_weight: number;
  valid_from: string | null;
  valid_until: string | null;
  authored_at: string | null;
  source_id: string | null;
}

export interface HistoryEntry extends Gravit {
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

export interface TransactionWithGravita extends TransactionRecord {
  gravita: Gravit[];
}

export interface StatsResult {
  total_gravita: number;
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
  influence_weight: string;
  valid_from: Date | null;
  valid_until: Date | null;
  authored_at: Date | null;
  source_id: string | null;
}

interface RawGravitRow {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  value_num: string | null;
  value_ts: Date | null;
  tx_id: string;
  retracted: boolean;
  created_at: Date;
  influence_weight: string;
  valid_from: Date | null;
  valid_until: Date | null;
  authored_at: Date | null;
  source_id: string | null;
}

interface RawHistoryRow extends RawGravitRow {
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
    influence_weight: parseFloat(row.influence_weight),
    valid_from: row.valid_from instanceof Date ? row.valid_from.toISOString() : row.valid_from ?? null,
    valid_until: row.valid_until instanceof Date ? row.valid_until.toISOString() : row.valid_until ?? null,
    authored_at: row.authored_at instanceof Date ? row.authored_at.toISOString() : row.authored_at ?? null,
    source_id: row.source_id ?? null,
  };
}

function parseGravit(row: RawGravitRow): Gravit {
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
    influence_weight: parseFloat(row.influence_weight),
    valid_from: row.valid_from instanceof Date ? row.valid_from.toISOString() : row.valid_from ?? null,
    valid_until: row.valid_until instanceof Date ? row.valid_until.toISOString() : row.valid_until ?? null,
    authored_at: row.authored_at instanceof Date ? row.authored_at.toISOString() : row.authored_at ?? null,
    source_id: row.source_id ?? null,
  };
}

function parseHistoryEntry(row: RawHistoryRow): HistoryEntry {
  return {
    ...parseGravit(row),
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

      if (fact.op === 'assert') {
        // Compute weight and detect corroboration/contradiction
        const weightResult = await applyWeightsOnAssert(
          client,
          fact.entity,
          fact.attribute,
          fact.value,
          txId
        );

        await client.query(
          `INSERT INTO datoms (entity, attribute, value, value_num, value_ts, tx_id, retracted, influence_weight, valid_from, valid_until, authored_at, source_id)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11)`,
          [
            fact.entity, fact.attribute, fact.value, numVal, tsVal, txId,
            weightResult.newDatomWeight,
            fact.valid_from ?? null, fact.valid_until ?? null,
            fact.authored_at ?? null, fact.source_id ?? null,
          ]
        );

        // Apply contradiction to old gravit
        if (weightResult.contradictedId !== null) {
          await client.query(
            `UPDATE datoms SET influence_weight = $1 WHERE id = $2`,
            [weightResult.contradictedNewWeight, weightResult.contradictedId]
          );
          await logWeightEvent(
            client,
            fact.entity,
            fact.attribute,
            weightResult.contradictedValue!,
            'contradict',
            weightResult.contradictedOldWeight!,
            weightResult.contradictedNewWeight!,
            txId,
            agent_id ?? null,
            note ?? null
          );
        }

        // Log weight event for the new assertion or corroboration
        await logWeightEvent(
          client,
          fact.entity,
          fact.attribute,
          fact.value,
          weightResult.eventType,
          weightResult.eventType === 'corroborate'
            ? weightResult.newDatomWeight - WEIGHT_CORROBORATION_DELTA
            : WEIGHT_INITIAL,
          weightResult.newDatomWeight,
          txId,
          agent_id ?? null,
          note ?? null
        );
      } else {
        // Retract: insert with default weight (1.0), no weight logic needed
        await client.query(
          `INSERT INTO datoms (entity, attribute, value, value_num, value_ts, tx_id, retracted, valid_from, valid_until, authored_at, source_id)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10)`,
          [
            fact.entity, fact.attribute, fact.value, numVal, tsVal, txId,
            fact.valid_from ?? null, fact.valid_until ?? null,
            fact.authored_at ?? null, fact.source_id ?? null,
          ]
        );
      }
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

  // Within the same tx_id, a higher gravit id means it was inserted later.
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
        d.influence_weight,
        d.valid_from,
        d.valid_until,
        d.authored_at,
        d.source_id,
        t.tx_at,
        ROW_NUMBER() OVER (PARTITION BY d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      WHERE d.entity = $1
      ${attrFilter}
    )
    SELECT attribute, value, value_num, value_ts, tx_id, tx_at, influence_weight,
           valid_from, valid_until, authored_at, source_id
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
export async function queryGravita(
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
        d.influence_weight,
        d.valid_from,
        d.valid_until,
        d.authored_at,
        d.source_id,
        t.tx_at,
        ROW_NUMBER() OVER (PARTITION BY d.entity, d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      WHERE true
      ${whereClause}
    )
    SELECT entity, attribute, value, value_num, value_ts, tx_id, tx_at, influence_weight,
           valid_from, valid_until, authored_at, source_id
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
        d.influence_weight,
        d.valid_from,
        d.valid_until,
        d.authored_at,
        d.source_id,
        t.tx_at,
        ROW_NUMBER() OVER (PARTITION BY d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      WHERE d.entity = $1
      ${timeFilter}
      ${attrFilter}
    )
    SELECT attribute, value, value_num, value_ts, tx_id, tx_at, influence_weight,
           valid_from, valid_until, authored_at, source_id
    FROM ranked
    WHERE rn = 1 AND retracted = false
    ORDER BY attribute
  `;

  const result = await getPool().query<RawCurrentFactRow>(sql, params);
  return result.rows.map(parseCurrentFact);
}

/** Get full history of all gravita (including retractions) for entity/attribute. */
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
      d.influence_weight,
      d.valid_from,
      d.valid_until,
      d.authored_at,
      d.source_id,
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

/** Get all gravita added after a given transaction. */
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
      d.influence_weight,
      d.valid_from,
      d.valid_until,
      d.authored_at,
      d.source_id,
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

/** Get transaction metadata + all gravita in that tx. */
export async function getTransaction(tx_id: number): Promise<TransactionWithGravita> {
  const txResult = await getPool().query<RawTxRow>(
    'SELECT id, tx_at, agent_id, note FROM transactions WHERE id = $1',
    [tx_id]
  );
  if (txResult.rows.length === 0) {
    throw new Error(`Transaction ${tx_id} not found`);
  }
  const tx = parseTx(txResult.rows[0]!);

  const gravitResult = await getPool().query<RawGravitRow>(
    `SELECT id, entity, attribute, value, value_num, value_ts, tx_id, retracted, created_at, influence_weight,
            valid_from, valid_until, authored_at, source_id
     FROM datoms WHERE tx_id = $1 ORDER BY id`,
    [tx_id]
  );

  return {
    ...tx,
    gravita: gravitResult.rows.map(parseGravit),
  };
}

/** Get database statistics. */
export async function getStats(): Promise<StatsResult> {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM datoms)::bigint AS total_gravita,
      (SELECT COUNT(*) FROM transactions)::bigint AS total_transactions,
      (SELECT COUNT(DISTINCT entity) FROM datoms)::bigint AS total_entities,
      (SELECT COUNT(DISTINCT attribute) FROM datoms)::bigint AS total_attributes,
      pg_size_pretty(pg_database_size(current_database())) AS db_size
  `;
  const result = await getPool().query<{
    total_gravita: string;
    total_transactions: string;
    total_entities: string;
    total_attributes: string;
    db_size: string;
  }>(sql);
  const r = result.rows[0]!;
  return {
    total_gravita: parseInt(r.total_gravita, 10),
    total_transactions: parseInt(r.total_transactions, 10),
    total_entities: parseInt(r.total_entities, 10),
    total_attributes: parseInt(r.total_attributes, 10),
    db_size: r.db_size,
  };
}

// ─── Semantic analysis types ─────────────────────────────────────────────────

export interface WeightEventRecord {
  id: number;
  entity: string;
  attribute: string;
  value: string;
  event_type: 'assert' | 'corroborate' | 'contradict';
  weight_before: number;
  weight_after: number;
  tx_id: number | null;
  agent_id: string | null;
  note: string | null;
  created_at: string;
}

export type LifecyclePhase = 'ascent' | 'dominance' | 'decay' | 'superseded';

export interface DominanceCurveResult {
  entity: string;
  attribute: string;
  value: string;
  lifecycle: {
    phase: LifecyclePhase;
    current_weight: number;
    peak_weight: number;
    peak_tx: number | null;
    peak_at: string | null;
    first_asserted_tx: number | null;
    first_asserted_at: string | null;
    last_corroboration_tx: number | null;
    contradiction_tx: number | null;
  };
  curve: Array<{
    tx_id: number | null;
    at: string;
    weight: number;
    event: 'assert' | 'corroborate' | 'contradict';
  }>;
}

export interface DominantFactEntry {
  entity: string;
  attribute: string;
  value: string;
  influence_weight: number;
  effective_weight: number;
  tx_id: number;
  tx_at: string;
  phase: LifecyclePhase;
  source_id: string | null;
  source_trust: number;
}

export interface AnomalyEntry {
  entity: string;
  attribute: string;
  value: string;
  anomaly_type: 'fast_ascent' | 'fast_decay' | 'isolated_assertion';
  severity: 'low' | 'medium' | 'high';
  description: string;
  first_asserted_at: string;
  current_weight: number;
  corroboration_count: number;
}

export interface FactDurationResult {
  entity: string;
  attribute: string;
  value: string;
  asserted_at: string;
  dominant_from: string | null;
  dominant_until: string | null;
  duration_seconds: number | null;
  is_currently_dominant: boolean;
  superseded_by: { value: string; tx_id: number; at: string } | null;
}

// Raw weight event row from pg
interface RawWeightEventRow {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  event_type: string;
  weight_before: string;
  weight_after: string;
  tx_id: string | null;
  agent_id: string | null;
  note: string | null;
  created_at: Date;
}

function parseWeightEvent(row: RawWeightEventRow): WeightEventRecord {
  return {
    id: parseInt(row.id, 10),
    entity: row.entity,
    attribute: row.attribute,
    value: row.value,
    event_type: row.event_type as WeightEventRecord['event_type'],
    weight_before: parseFloat(row.weight_before),
    weight_after: parseFloat(row.weight_after),
    tx_id: row.tx_id !== null ? parseInt(row.tx_id, 10) : null,
    agent_id: row.agent_id,
    note: row.note,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Determine lifecycle phase from current state */
function classifyPhase(
  currentWeight: number,
  peakWeight: number,
  isSuperseded: boolean,
  lastEventType: string | null
): LifecyclePhase {
  if (isSuperseded) return 'superseded';
  if (currentWeight < peakWeight * 0.8) return 'decay';
  if (lastEventType === 'corroborate') return 'ascent';
  return 'dominance';
}

// ─── New exported functions ───────────────────────────────────────────────────

/**
 * Explicitly corroborate a fact — increases its influence weight and resets
 * the decay clock by inserting a new gravit with the increased weight.
 */
export async function corroborateExplicit(
  entity: string,
  attribute: string,
  value: string,
  agent_id: string,
  note?: string
): Promise<{ entity: string; attribute: string; value: string; old_weight: number; new_weight: number }> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Get current weight from latest non-retracted gravit for this triple
    const existing = await client.query<{ influence_weight: string }>(
      `SELECT influence_weight
       FROM datoms
       WHERE entity = $1 AND attribute = $2 AND value = $3 AND retracted = false
       ORDER BY tx_id DESC, id DESC
       LIMIT 1`,
      [entity, attribute, value]
    );
    if (existing.rows.length === 0) {
      throw new Error(`Fact not found: [${entity}, ${attribute}, ${value}]`);
    }

    const oldWeight = parseFloat(existing.rows[0]!.influence_weight);
    const newWeight = Math.min(oldWeight + WEIGHT_CORROBORATION_DELTA, WEIGHT_CEILING);

    // Create a new transaction for provenance
    const txResult = await client.query<RawTxRow>(
      'INSERT INTO transactions (agent_id, note) VALUES ($1, $2) RETURNING id, tx_at, agent_id, note',
      [agent_id, note ?? null]
    );
    const txRow = txResult.rows[0]!;
    const txId = parseInt(txRow.id, 10);

    // Insert new gravit with updated weight (keeps provenance of who corroborated)
    const numVal = tryParseNumber(value);
    const tsVal = tryParseTimestamp(value);
    await client.query(
      `INSERT INTO datoms (entity, attribute, value, value_num, value_ts, tx_id, retracted, influence_weight)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
      [entity, attribute, value, numVal, tsVal, txId, newWeight]
    );

    await logWeightEvent(
      client, entity, attribute, value,
      'corroborate', oldWeight, newWeight,
      txId, agent_id, note ?? null
    );

    await client.query('COMMIT');
    return { entity, attribute, value, old_weight: oldWeight, new_weight: newWeight };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Return the full influence weight history and lifecycle phase for a fact
 * (or all facts for an entity/attribute combination).
 */
export async function getDominanceCurve(
  entity: string,
  attribute?: string,
  value?: string
): Promise<DominanceCurveResult[]> {
  // Get distinct (entity, attribute, value) triples to build curves for
  const params: unknown[] = [entity];
  let attrFilter = '';
  let valFilter = '';
  if (attribute !== undefined) {
    params.push(attribute);
    attrFilter = `AND attribute = $${params.length}`;
  }
  if (value !== undefined) {
    params.push(value);
    valFilter = `AND value = $${params.length}`;
  }

  // gravitWeightEvents (SQL table: datom_weight_events)
  const triplesResult = await getPool().query<{ entity: string; attribute: string; value: string }>(
    `SELECT DISTINCT entity, attribute, value
     FROM datom_weight_events
     WHERE entity = $1 ${attrFilter} ${valFilter}
     ORDER BY attribute, value`,
    params
  );

  const results: DominanceCurveResult[] = [];

  for (const triple of triplesResult.rows) {
    // gravitWeightEvents (SQL table: datom_weight_events)
    const eventsResult = await getPool().query<RawWeightEventRow>(
      `SELECT id, entity, attribute, value, event_type, weight_before, weight_after,
              tx_id, agent_id, note, created_at
       FROM datom_weight_events
       WHERE entity = $1 AND attribute = $2 AND value = $3
       ORDER BY created_at ASC, id ASC`,
      [triple.entity, triple.attribute, triple.value]
    );
    const events = eventsResult.rows.map(parseWeightEvent);

    // Latest gravit for this triple to get stored weight, its created_at, and source trust
    const latestGravit = await getPool().query<{
      influence_weight: string;
      created_at: Date;
      tx_id: string;
      source_trust: string;
    }>(
      `SELECT d.influence_weight, d.created_at, d.tx_id,
              COALESCE(s.trust_weight, 1.0) AS source_trust
       FROM datoms d
       LEFT JOIN gravita_sources s ON d.source_id = s.id
       WHERE d.entity = $1 AND d.attribute = $2 AND d.value = $3 AND d.retracted = false
       ORDER BY d.tx_id DESC, d.id DESC
       LIMIT 1`,
      [triple.entity, triple.attribute, triple.value]
    );

    const storedWeight = latestGravit.rows.length > 0
      ? parseFloat(latestGravit.rows[0]!.influence_weight)
      : WEIGHT_FLOOR;
    const sourceTrust = latestGravit.rows.length > 0
      ? parseFloat(latestGravit.rows[0]!.source_trust)
      : 1.0;
    const lastEventAt = latestGravit.rows.length > 0
      ? (latestGravit.rows[0]!.created_at instanceof Date
        ? latestGravit.rows[0]!.created_at.toISOString()
        : String(latestGravit.rows[0]!.created_at))
      : new Date().toISOString();

    const currentWeight = computeEffectiveWeight(storedWeight, lastEventAt) * sourceTrust;

    // Compute peak weight from events
    let peakWeight = WEIGHT_INITIAL;
    let peakAt: string | null = null;
    let peakTx: number | null = null;
    for (const ev of events) {
      if (ev.weight_after > peakWeight) {
        peakWeight = ev.weight_after;
        peakAt = ev.created_at;
        peakTx = ev.tx_id;
      }
    }

    const assertEvent = events.find((e) => e.event_type === 'assert');
    const lastCorrobEvent = [...events].reverse().find((e) => e.event_type === 'corroborate');
    const contradictEvent = events.find((e) => e.event_type === 'contradict');

    // Check if superseded: is there a DIFFERENT value currently active for (entity, attribute)?
    const supersededCheck = await getPool().query<{ value: string }>(
      `WITH ranked AS (
         SELECT value, retracted,
                ROW_NUMBER() OVER (PARTITION BY attribute ORDER BY tx_id DESC, id DESC) AS rn
         FROM datoms
         WHERE entity = $1 AND attribute = $2
       )
       SELECT value FROM ranked WHERE rn = 1 AND retracted = false AND value != $3`,
      [triple.entity, triple.attribute, triple.value]
    );
    const isSuperseded = supersededCheck.rows.length > 0;

    const lastEventType = events.length > 0 ? events[events.length - 1]!.event_type : null;
    const phase = classifyPhase(currentWeight, peakWeight, isSuperseded, lastEventType);

    results.push({
      entity: triple.entity,
      attribute: triple.attribute,
      value: triple.value,
      lifecycle: {
        phase,
        current_weight: Math.round(currentWeight * 10000) / 10000,
        peak_weight: peakWeight,
        peak_tx: peakTx,
        peak_at: peakAt,
        first_asserted_tx: assertEvent?.tx_id ?? null,
        first_asserted_at: assertEvent?.created_at ?? null,
        last_corroboration_tx: lastCorrobEvent?.tx_id ?? null,
        contradiction_tx: contradictEvent?.tx_id ?? null,
      },
      curve: events.map((e) => ({
        tx_id: e.tx_id,
        at: e.created_at,
        weight: e.weight_after,
        event: e.event_type,
      })),
    });
  }

  return results;
}

/**
 * Return the currently dominant facts for an entity (or globally),
 * ranked by effective influence weight above a threshold.
 */
export async function getDominantFacts(
  entity?: string,
  threshold = 0.7,
  limit = 50,
  as_of?: string
): Promise<DominantFactEntry[]> {
  const params: unknown[] = [];
  let entityFilter = '';
  let timeFilter = '';

  if (entity !== undefined) {
    params.push(entity);
    entityFilter = `AND d.entity = $${params.length}`;
  }
  if (as_of !== undefined) {
    params.push(as_of);
    timeFilter = `AND t.tx_at <= $${params.length}`;
  }

  const sql = `
    WITH ranked AS (
      SELECT
        d.entity,
        d.attribute,
        d.value,
        d.influence_weight,
        d.created_at,
        d.tx_id,
        d.retracted,
        d.source_id,
        t.tx_at,
        COALESCE(s.trust_weight, 1.0) AS source_trust,
        ROW_NUMBER() OVER (PARTITION BY d.entity, d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
      FROM datoms d
      JOIN transactions t ON d.tx_id = t.id
      LEFT JOIN gravita_sources s ON d.source_id = s.id
      WHERE true
      ${entityFilter}
      ${timeFilter}
    )
    SELECT entity, attribute, value, influence_weight, created_at, tx_id, tx_at, source_id, source_trust
    FROM ranked
    WHERE rn = 1 AND retracted = false
    ORDER BY influence_weight DESC
  `;

  const result = await getPool().query<{
    entity: string;
    attribute: string;
    value: string;
    influence_weight: string;
    created_at: Date;
    tx_id: string;
    tx_at: Date;
    source_id: string | null;
    source_trust: string;
  }>(sql, params);

  const entries: DominantFactEntry[] = [];
  for (const row of result.rows) {
    const storedWeight = parseFloat(row.influence_weight);
    const sourceTrust = parseFloat(row.source_trust);
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    const effectiveWeight = computeEffectiveWeight(storedWeight, createdAt) * sourceTrust;

    if (effectiveWeight < threshold) continue;

    // Determine phase (simplified: no cross-query for supersede check in bulk)
    let phase: LifecyclePhase = 'dominance';
    if (effectiveWeight < storedWeight * sourceTrust * 0.8) phase = 'decay';

    entries.push({
      entity: row.entity,
      attribute: row.attribute,
      value: row.value,
      influence_weight: storedWeight,
      effective_weight: Math.round(effectiveWeight * 10000) / 10000,
      tx_id: parseInt(row.tx_id, 10),
      tx_at: row.tx_at instanceof Date ? row.tx_at.toISOString() : String(row.tx_at),
      phase,
      source_id: row.source_id,
      source_trust: sourceTrust,
    });

    if (entries.length >= limit) break;
  }

  return entries;
}

/**
 * Detect facts with anomalous weight trajectories:
 * fast_ascent, isolated_assertion, fast_decay.
 */
export async function detectAnomalies(
  entity?: string,
  window_hours = 24
): Promise<{ anomalies: AnomalyEntry[] }> {
  const params: unknown[] = [];
  let entityFilter = '';
  if (entity !== undefined) {
    params.push(entity);
    entityFilter = `AND entity = $${params.length}`;
  }

  // Get all weight events within the window
  params.push(window_hours);
  const windowFilter = `AND created_at >= now() - ($${params.length} || ' hours')::interval`;

  // gravitWeightEvents (SQL table: datom_weight_events)
  const eventsResult = await getPool().query<RawWeightEventRow>(
    `SELECT id, entity, attribute, value, event_type, weight_before, weight_after,
            tx_id, agent_id, note, created_at
     FROM datom_weight_events
     WHERE true ${entityFilter} ${windowFilter}
     ORDER BY entity, attribute, value, created_at ASC`,
    params
  );

  const events = eventsResult.rows.map(parseWeightEvent);

  // Group by (entity, attribute, value)
  const byTriple = new Map<string, WeightEventRecord[]>();
  for (const ev of events) {
    const key = `${ev.entity}\0${ev.attribute}\0${ev.value}`;
    const arr = byTriple.get(key);
    if (arr) {
      arr.push(ev);
    } else {
      byTriple.set(key, [ev]);
    }
  }

  const anomalies: AnomalyEntry[] = [];

  for (const [key, evs] of byTriple) {
    const [tripleEntity, tripleAttribute, tripleValue] = key.split('\0') as [string, string, string];
    const assertEv = evs.find((e) => e.event_type === 'assert');
    const corrobEvs = evs.filter((e) => e.event_type === 'corroborate');
    const contradictEvs = evs.filter((e) => e.event_type === 'contradict');

    // Get current stored weight from latest gravit
    const latestGravit = await getPool().query<{ influence_weight: string; created_at: Date }>(
      `SELECT influence_weight, created_at
       FROM datoms
       WHERE entity = $1 AND attribute = $2 AND value = $3 AND retracted = false
       ORDER BY tx_id DESC, id DESC LIMIT 1`,
      [tripleEntity, tripleAttribute, tripleValue]
    );
    const storedWeight = latestGravit.rows.length > 0
      ? parseFloat(latestGravit.rows[0]!.influence_weight)
      : WEIGHT_FLOOR;
    const lastAt = latestGravit.rows.length > 0
      ? (latestGravit.rows[0]!.created_at instanceof Date
        ? latestGravit.rows[0]!.created_at.toISOString()
        : String(latestGravit.rows[0]!.created_at))
      : new Date().toISOString();
    const currentWeight = computeEffectiveWeight(storedWeight, lastAt);
    const firstAssertedAt = assertEv?.created_at ?? evs[0]!.created_at;

    // Fast ascent: reached weight >= 1.5 (2+ corroborations) all within 1 hour of assertion
    if (storedWeight >= 1.5 && assertEv) {
      const assertTime = new Date(assertEv.created_at).getTime();
      const allCorrobWithin1h = corrobEvs.every(
        (e) => new Date(e.created_at).getTime() - assertTime < 3_600_000
      );
      if (allCorrobWithin1h && corrobEvs.length >= 1) {
        const severity: AnomalyEntry['severity'] =
          storedWeight > 2.5 ? 'high' : storedWeight > 2.0 ? 'medium' : 'low';
        anomalies.push({
          entity: tripleEntity,
          attribute: tripleAttribute,
          value: tripleValue,
          anomaly_type: 'fast_ascent',
          severity,
          description: `Weight reached ${storedWeight.toFixed(2)} via ${corrobEvs.length} corroboration(s) within 1 hour of assertion`,
          first_asserted_at: firstAssertedAt,
          current_weight: Math.round(currentWeight * 10000) / 10000,
          corroboration_count: corrobEvs.length,
        });
      }
    }

    // Isolated assertion: asserted > 24h ago, no corroborations, weight still high (> 0.7)
    if (
      assertEv &&
      corrobEvs.length === 0 &&
      currentWeight > 0.7 &&
      Date.now() - new Date(assertEv.created_at).getTime() > 24 * 3_600_000
    ) {
      anomalies.push({
        entity: tripleEntity,
        attribute: tripleAttribute,
        value: tripleValue,
        anomaly_type: 'isolated_assertion',
        severity: 'medium',
        description: `Single-agent assertion with no corroboration after 24+ hours`,
        first_asserted_at: firstAssertedAt,
        current_weight: Math.round(currentWeight * 10000) / 10000,
        corroboration_count: 0,
      });
    }

    // Fast decay: a contradiction event reduced weight > 50% within 1 hour
    for (const contradictEv of contradictEvs) {
      const pctDrop = (contradictEv.weight_before - contradictEv.weight_after) / contradictEv.weight_before;
      if (pctDrop > 0.5) {
        const assertTime = assertEv ? new Date(assertEv.created_at).getTime() : 0;
        const contradictTime = new Date(contradictEv.created_at).getTime();
        const hoursToContradict = (contradictTime - assertTime) / 3_600_000;
        const severity: AnomalyEntry['severity'] = hoursToContradict < 0.5 ? 'high' : 'medium';
        anomalies.push({
          entity: tripleEntity,
          attribute: tripleAttribute,
          value: tripleValue,
          anomaly_type: 'fast_decay',
          severity,
          description: `Weight dropped ${(pctDrop * 100).toFixed(0)}% due to contradiction (${contradictEv.weight_before.toFixed(2)} → ${contradictEv.weight_after.toFixed(2)})`,
          first_asserted_at: firstAssertedAt,
          current_weight: Math.round(currentWeight * 10000) / 10000,
          corroboration_count: corrobEvs.length,
        });
      }
    }
  }

  return { anomalies };
}

/**
 * Return the effective duration of a fact — the period during which it
 * was dominant (weight above threshold).
 */
export async function getFactDuration(
  entity: string,
  attribute: string,
  value: string,
  dominance_threshold = 0.7
): Promise<FactDurationResult> {
  // Get first assertion event for this triple from gravitWeightEvents (SQL: datom_weight_events)
  const assertResult = await getPool().query<RawWeightEventRow>(
    `SELECT id, entity, attribute, value, event_type, weight_before, weight_after,
            tx_id, agent_id, note, created_at
     FROM datom_weight_events
     WHERE entity = $1 AND attribute = $2 AND value = $3 AND event_type = 'assert'
     ORDER BY created_at ASC
     LIMIT 1`,
    [entity, attribute, value]
  );

  if (assertResult.rows.length === 0) {
    throw new Error(`No assertion found for [${entity}, ${attribute}, ${value}]`);
  }

  const firstAssert = parseWeightEvent(assertResult.rows[0]!);
  const assertedAt = firstAssert.created_at;

  // Get latest gravit for current stored weight and created_at (decay clock)
  const latestGravit = await getPool().query<{
    influence_weight: string;
    created_at: Date;
    tx_id: string;
  }>(
    `SELECT influence_weight, created_at, tx_id
     FROM datoms
     WHERE entity = $1 AND attribute = $2 AND value = $3 AND retracted = false
     ORDER BY tx_id DESC, id DESC
     LIMIT 1`,
    [entity, attribute, value]
  );

  const storedWeight = latestGravit.rows.length > 0
    ? parseFloat(latestGravit.rows[0]!.influence_weight)
    : WEIGHT_FLOOR;
  const lastEventAt = latestGravit.rows.length > 0
    ? (latestGravit.rows[0]!.created_at instanceof Date
      ? latestGravit.rows[0]!.created_at.toISOString()
      : String(latestGravit.rows[0]!.created_at))
    : assertedAt;

  const currentEffectiveWeight = computeEffectiveWeight(storedWeight, lastEventAt);
  const isCurrentlyDominant = currentEffectiveWeight >= dominance_threshold;

  // dominant_from: when weight first crossed threshold
  // Since initial weight is 1.0 and default threshold is 0.7, it's dominant from assertion
  const dominantFrom = firstAssert.weight_after >= dominance_threshold ? assertedAt : null;

  // dominant_until: if still dominant, null; else compute when weight crossed below threshold
  let dominantUntil: string | null = null;
  if (!isCurrentlyDominant && dominantFrom !== null) {
    // Find when decay brings stored_weight below threshold from last event
    // solve: stored_weight * 0.995^hours < threshold
    // hours = log(threshold / stored_weight) / log(0.995)
    if (storedWeight > dominance_threshold) {
      const hoursToThreshold =
        Math.log(dominance_threshold / storedWeight) / Math.log(0.995);
      const crossTime = new Date(lastEventAt).getTime() + hoursToThreshold * 3_600_000;
      dominantUntil = new Date(crossTime).toISOString();
    } else {
      // Weight was already at or below threshold from last stored event
      dominantUntil = lastEventAt;
    }
  }

  // duration_seconds
  let durationSeconds: number | null = null;
  if (dominantFrom !== null) {
    const endTime = dominantUntil ? new Date(dominantUntil).getTime() : Date.now();
    durationSeconds = Math.round((endTime - new Date(dominantFrom).getTime()) / 1000);
  }

  // superseded_by: find a different value currently active for (entity, attribute)
  const supersededResult = await getPool().query<{ value: string; tx_id: string; tx_at: Date }>(
    `WITH ranked AS (
       SELECT d.value, d.tx_id, d.retracted,
              t.tx_at,
              ROW_NUMBER() OVER (PARTITION BY d.attribute ORDER BY d.tx_id DESC, d.id DESC) AS rn
       FROM datoms d
       JOIN transactions t ON d.tx_id = t.id
       WHERE d.entity = $1 AND d.attribute = $2
     )
     SELECT value, tx_id, tx_at FROM ranked WHERE rn = 1 AND retracted = false AND value != $3`,
    [entity, attribute, value]
  );

  const supersededBy = supersededResult.rows.length > 0
    ? {
        value: supersededResult.rows[0]!.value,
        tx_id: parseInt(supersededResult.rows[0]!.tx_id, 10),
        at: supersededResult.rows[0]!.tx_at instanceof Date
          ? supersededResult.rows[0]!.tx_at.toISOString()
          : String(supersededResult.rows[0]!.tx_at),
      }
    : null;

  return {
    entity,
    attribute,
    value,
    asserted_at: assertedAt,
    dominant_from: dominantFrom,
    dominant_until: dominantUntil,
    duration_seconds: durationSeconds,
    is_currently_dominant: isCurrentlyDominant,
    superseded_by: supersededBy,
  };
}

// ─── Bitemporal queries ───────────────────────────────────────────────────────

/**
 * Return all non-retracted gravita for (entity, attribute) whose valid interval
 * contains `point_in_time`. Null valid_from means "valid from beginning of time";
 * null valid_until means "valid indefinitely".
 */
export async function getFactsAt(
  entity: string,
  attribute: string,
  point_in_time: string
): Promise<HistoryEntry[]> {
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
      d.influence_weight,
      d.valid_from,
      d.valid_until,
      d.authored_at,
      d.source_id,
      t.tx_at,
      t.agent_id,
      t.note
    FROM datoms d
    JOIN transactions t ON d.tx_id = t.id
    WHERE d.entity = $1
      AND d.attribute = $2
      AND d.retracted = false
      AND (d.valid_from IS NULL OR d.valid_from <= $3::timestamptz)
      AND (d.valid_until IS NULL OR d.valid_until >= $3::timestamptz)
    ORDER BY d.tx_id ASC, d.id ASC
  `;
  const result = await getPool().query<RawHistoryRow>(sql, [entity, attribute, point_in_time]);
  return result.rows.map(parseHistoryEntry);
}

/**
 * Return all non-retracted gravita for (entity, attribute) whose valid interval
 * overlaps the query period [period_start, period_end] (Allen interval overlap).
 * A fact overlaps if it starts before or at period_end AND ends after or at period_start.
 */
export async function getFactsDuring(
  entity: string,
  attribute: string,
  period_start: string,
  period_end: string
): Promise<HistoryEntry[]> {
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
      d.influence_weight,
      d.valid_from,
      d.valid_until,
      d.authored_at,
      d.source_id,
      t.tx_at,
      t.agent_id,
      t.note
    FROM datoms d
    JOIN transactions t ON d.tx_id = t.id
    WHERE d.entity = $1
      AND d.attribute = $2
      AND d.retracted = false
      AND (d.valid_from IS NULL OR d.valid_from <= $4::timestamptz)
      AND (d.valid_until IS NULL OR d.valid_until >= $3::timestamptz)
    ORDER BY d.tx_id ASC, d.id ASC
  `;
  const result = await getPool().query<RawHistoryRow>(sql, [entity, attribute, period_start, period_end]);
  return result.rows.map(parseHistoryEntry);
}

// ─── Source trust ─────────────────────────────────────────────────────────────

export interface GravitaSource {
  id: string;
  name: string;
  trust_weight: number;
  created_at: string;
}

interface RawGravitaSourceRow {
  id: string;
  name: string;
  trust_weight: string;
  created_at: Date;
}

function parseGravitaSource(row: RawGravitaSourceRow): GravitaSource {
  return {
    id: row.id,
    name: row.name,
    trust_weight: parseFloat(row.trust_weight),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Return the trust metadata for a source, or null if not registered. */
export async function getSourceTrust(source_id: string): Promise<GravitaSource | null> {
  const result = await getPool().query<RawGravitaSourceRow>(
    `SELECT id, name, trust_weight, created_at FROM gravita_sources WHERE id = $1`,
    [source_id]
  );
  if (result.rows.length === 0) return null;
  return parseGravitaSource(result.rows[0]!);
}

/** Create or update a source registry entry. */
export async function upsertSource(
  id: string,
  name: string,
  trust_weight: number
): Promise<GravitaSource> {
  const result = await getPool().query<RawGravitaSourceRow>(
    `INSERT INTO gravita_sources (id, name, trust_weight)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, trust_weight = EXCLUDED.trust_weight
     RETURNING id, name, trust_weight, created_at`,
    [id, name, trust_weight]
  );
  return parseGravitaSource(result.rows[0]!);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
