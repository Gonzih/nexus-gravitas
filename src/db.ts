import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      console.error('DATABASE_URL environment variable is required');
      process.exit(1);
    }
    pool = new Pool({ connectionString: databaseUrl });
    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err);
    });
  }
  return pool;
}

export async function getClient(): Promise<PoolClient> {
  return getPool().connect();
}

export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export async function runMigrations(): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Enable pgvector if available; ignore error if not installed
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {
      console.warn('pgvector extension not available — vector search disabled');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          BIGSERIAL PRIMARY KEY,
        tx_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        agent_id    TEXT,
        note        TEXT
      )
    `);

    // Check if pgvector is available before using vector type
    const vectorAvailable = await checkVectorAvailable(client);

    if (vectorAvailable) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS datoms (
          id          BIGSERIAL PRIMARY KEY,
          entity      TEXT NOT NULL,
          attribute   TEXT NOT NULL,
          value       TEXT NOT NULL,
          value_num   DOUBLE PRECISION,
          value_ts    TIMESTAMPTZ,
          value_vec   vector(384),
          tx_id       BIGINT NOT NULL REFERENCES transactions(id),
          retracted   BOOLEAN NOT NULL DEFAULT false,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS datoms_vec_idx
          ON datoms USING hnsw (value_vec vector_cosine_ops)
          WHERE value_vec IS NOT NULL
      `);
    } else {
      await client.query(`
        CREATE TABLE IF NOT EXISTS datoms (
          id          BIGSERIAL PRIMARY KEY,
          entity      TEXT NOT NULL,
          attribute   TEXT NOT NULL,
          value       TEXT NOT NULL,
          value_num   DOUBLE PRECISION,
          value_ts    TIMESTAMPTZ,
          tx_id       BIGINT NOT NULL REFERENCES transactions(id),
          retracted   BOOLEAN NOT NULL DEFAULT false,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS datoms_eavt ON datoms (entity, attribute, tx_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS datoms_aevt ON datoms (attribute, entity, tx_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS datoms_avet ON datoms (attribute, value, tx_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS datoms_txid ON datoms (tx_id)
    `);

    // Influence weight for semantic analysis
    await client.query(`
      ALTER TABLE datoms ADD COLUMN IF NOT EXISTS influence_weight FLOAT NOT NULL DEFAULT 1.0
    `);

    // Weight event log for dominance curves and anomaly detection
    await client.query(`
      CREATE TABLE IF NOT EXISTS datom_weight_events (
        id           BIGSERIAL PRIMARY KEY,
        entity       TEXT NOT NULL,
        attribute    TEXT NOT NULL,
        value        TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        weight_before FLOAT NOT NULL,
        weight_after  FLOAT NOT NULL,
        tx_id        BIGINT REFERENCES transactions(id),
        agent_id     TEXT,
        note         TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS dwe_eavidx ON datom_weight_events (entity, attribute, value, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS dwe_eidx ON datom_weight_events (entity, created_at)
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function checkVectorAvailable(client: PoolClient): Promise<boolean> {
  try {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) FROM pg_extension WHERE extname = 'vector'"
    );
    return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
