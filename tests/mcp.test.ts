/**
 * MCP server integration tests.
 * Tests that tools are registered and callable with valid/invalid inputs.
 * Requires DATABASE_URL for actual DB-backed tests.
 */

import { createMcpServer } from '../src/mcp';
import { runMigrations, closePool, getPool } from '../src/db';

const TEST_DB_URL = process.env['DATABASE_URL'];
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('MCP server', () => {
  beforeAll(async () => {
    await runMigrations();
    await getPool().query('TRUNCATE datoms, transactions RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await closePool();
  });

  it('creates an MCP server without throwing', () => {
    expect(() => createMcpServer()).not.toThrow();
  });

  describe('transact tool', () => {
    it('asserts facts and returns tx info', async () => {
      // Call the underlying handler directly via the datoms layer (MCP handler calls it)
      const { transact } = await import('../src/gravita');
      const result = await transact(
        [
          { op: 'assert', entity: 'mcp-test:entity1', attribute: 'color', value: 'red' },
          { op: 'assert', entity: 'mcp-test:entity1', attribute: 'size', value: '10' },
        ],
        'agent:mcp-test',
        'MCP test transaction'
      );
      expect(result.tx_id).toBeGreaterThan(0);
      expect(result.count).toBe(2);
    });
  });

  describe('get tool', () => {
    it('retrieves current facts for an entity', async () => {
      const { getEntity } = await import('../src/gravita');
      const facts = await getEntity('mcp-test:entity1');
      expect(facts.length).toBeGreaterThan(0);
      const colorFact = facts.find((f) => f.attribute === 'color');
      expect(colorFact?.value).toBe('red');
    });
  });

  describe('find tool', () => {
    it('finds entities with matching attribute=value', async () => {
      const { findEntities } = await import('../src/gravita');
      const entities = await findEntities('color', 'red');
      expect(entities).toContain('mcp-test:entity1');
    });
  });

  describe('query tool', () => {
    it('queries with entity pattern', async () => {
      const { queryGravita } = await import('../src/gravita');
      const results = await queryGravita('mcp-test:%');
      expect(results.some((r) => r.entity === 'mcp-test:entity1')).toBe(true);
    });
  });

  describe('as_of tool', () => {
    it('retrieves entity state at first transaction', async () => {
      const { asOf } = await import('../src/gravita');
      const firstTx = await getPool().query<{ id: string }>(
        'SELECT id FROM transactions ORDER BY id LIMIT 1'
      );
      const txId = parseInt(firstTx.rows[0]!.id, 10);
      const facts = await asOf('mcp-test:entity1', txId);
      expect(Array.isArray(facts)).toBe(true);
    });

    it('throws when no time context given', async () => {
      const { asOf } = await import('../src/gravita');
      await expect(asOf('mcp-test:entity1')).rejects.toThrow();
    });
  });

  describe('history tool', () => {
    it('returns history entries', async () => {
      const { getHistory } = await import('../src/gravita');
      const entries = await getHistory('mcp-test:entity1');
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('since tool', () => {
    it('returns datoms after given tx', async () => {
      const { sinceTransaction } = await import('../src/gravita');
      const entries = await sinceTransaction(0);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('list_entities tool', () => {
    it('returns entity list', async () => {
      const { listEntities } = await import('../src/gravita');
      const entities = await listEntities();
      expect(entities).toContain('mcp-test:entity1');
    });
  });

  describe('list_attributes tool', () => {
    it('returns attribute stats', async () => {
      const { listAttributes } = await import('../src/gravita');
      const attrs = await listAttributes();
      const attrNames = attrs.map((a) => a.attribute);
      expect(attrNames).toContain('color');
      expect(attrNames).toContain('size');
    });
  });

  describe('get_transaction tool', () => {
    it('returns tx details', async () => {
      const { getTransaction } = await import('../src/gravita');
      const firstTx = await getPool().query<{ id: string }>(
        'SELECT id FROM transactions ORDER BY id LIMIT 1'
      );
      const txId = parseInt(firstTx.rows[0]!.id, 10);
      const tx = await getTransaction(txId);
      expect(tx.id).toBe(txId);
      expect(Array.isArray(tx.gravita)).toBe(true);
    });
  });

  describe('stats tool', () => {
    it('returns statistics', async () => {
      const { getStats } = await import('../src/gravita');
      const stats = await getStats();
      expect(typeof stats.total_gravita).toBe('number');
      expect(typeof stats.db_size).toBe('string');
    });
  });

  describe('retract workflow', () => {
    it('retraction hides old fact and new assertion shows new value', async () => {
      const { transact, getEntity } = await import('../src/gravita');

      // Set initial value
      await transact([
        { op: 'assert', entity: 'mcp-test:entity2', attribute: 'status', value: 'draft' },
      ]);

      // Retract and reassert
      await transact([
        { op: 'retract', entity: 'mcp-test:entity2', attribute: 'status', value: 'draft' },
        { op: 'assert', entity: 'mcp-test:entity2', attribute: 'status', value: 'published' },
      ]);

      const facts = await getEntity('mcp-test:entity2', 'status');
      expect(facts).toHaveLength(1);
      expect(facts[0]?.value).toBe('published');
    });

    it('full history includes retraction', async () => {
      const { getHistory } = await import('../src/gravita');
      const entries = await getHistory('mcp-test:entity2', 'status');
      const retractions = entries.filter((e) => e.retracted === true);
      expect(retractions.length).toBeGreaterThan(0);
    });
  });

  describe('time-travel accuracy', () => {
    it('as_of shows past value before update', async () => {
      const { transact, asOf } = await import('../src/gravita');

      const tx1 = await transact([
        { op: 'assert', entity: 'mcp-test:timetravel', attribute: 'phase', value: 'phase1' },
      ]);

      // Small delay to ensure timestamp ordering
      await new Promise((r) => setTimeout(r, 10));

      await transact([
        { op: 'retract', entity: 'mcp-test:timetravel', attribute: 'phase', value: 'phase1' },
        { op: 'assert', entity: 'mcp-test:timetravel', attribute: 'phase', value: 'phase2' },
      ]);

      // Query as-of first transaction — should see phase1
      const pastState = await asOf('mcp-test:timetravel', tx1.tx_id);
      const phaseFact = pastState.find((f) => f.attribute === 'phase');
      expect(phaseFact?.value).toBe('phase1');
    });
  });
});
