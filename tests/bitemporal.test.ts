/**
 * Integration tests for bitemporal support — requires a real PostgreSQL instance.
 * Set DATABASE_URL before running: e.g. DATABASE_URL=postgres://localhost/nexus_test
 */

import {
  transact,
  getFactsAt,
  getFactsDuring,
  getSourceTrust,
  upsertSource,
  getDominantFacts,
} from '../src/gravita';
import { runMigrations, closePool, getPool } from '../src/db';

const TEST_DB_URL = process.env['DATABASE_URL'];

if (!TEST_DB_URL) {
  console.warn('DATABASE_URL not set — skipping bitemporal integration tests');
}

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('bitemporal — integration tests', () => {
  beforeAll(async () => {
    await runMigrations();
    await getPool().query(
      'TRUNCATE datoms, transactions, gravita_sources RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await closePool();
  });

  // ── transact with bitemporal fields ─────────────────────────────────────────

  describe('transact — bitemporal fields', () => {
    it('stores valid_from and valid_until on assert', async () => {
      const result = await transact(
        [
          {
            op: 'assert',
            entity: 'bitemp:alice',
            attribute: 'role',
            value: 'engineer',
            valid_from: '2023-01-01T00:00:00Z',
            valid_until: '2024-01-01T00:00:00Z',
          },
        ],
        'agent:test'
      );
      expect(result.tx_id).toBeGreaterThan(0);
      expect(result.count).toBe(1);
    });

    it('stores authored_at and source_id on assert', async () => {
      const result = await transact(
        [
          {
            op: 'assert',
            entity: 'bitemp:alice',
            attribute: 'department',
            value: 'engineering',
            authored_at: '2022-12-15T10:00:00Z',
            source_id: 'source:hr-system',
          },
        ],
        'agent:test'
      );
      expect(result.count).toBe(1);
    });

    it('works when bitemporal fields are omitted (defaults to null)', async () => {
      const result = await transact(
        [{ op: 'assert', entity: 'bitemp:bob', attribute: 'role', value: 'manager' }],
        'agent:test'
      );
      expect(result.count).toBe(1);
    });
  });

  // ── getFactsAt ───────────────────────────────────────────────────────────────

  describe('getFactsAt', () => {
    beforeAll(async () => {
      // Alice was engineer from 2023-01-01 to 2024-01-01
      // Alice was senior engineer from 2024-01-01 onwards (open-ended)
      await transact(
        [
          {
            op: 'assert',
            entity: 'bitemp:carol',
            attribute: 'title',
            value: 'engineer',
            valid_from: '2023-01-01T00:00:00Z',
            valid_until: '2024-01-01T00:00:00Z',
          },
          {
            op: 'assert',
            entity: 'bitemp:carol',
            attribute: 'title',
            value: 'senior engineer',
            valid_from: '2024-01-01T00:00:00Z',
            // no valid_until — open-ended
          },
        ],
        'agent:test'
      );
    });

    it('returns a fact whose valid interval contains the point', async () => {
      const facts = await getFactsAt('bitemp:carol', 'title', '2023-06-15T00:00:00Z');
      expect(facts.length).toBe(1);
      expect(facts[0]?.value).toBe('engineer');
    });

    it('returns the open-ended fact when queried at or after its valid_from', async () => {
      const facts = await getFactsAt('bitemp:carol', 'title', '2025-03-01T00:00:00Z');
      expect(facts.length).toBe(1);
      expect(facts[0]?.value).toBe('senior engineer');
    });

    it('returns nothing before valid_from', async () => {
      const facts = await getFactsAt('bitemp:carol', 'title', '2022-01-01T00:00:00Z');
      expect(facts.length).toBe(0);
    });

    it('returns nothing after valid_until (closed interval)', async () => {
      // engineer is valid until 2024-01-01 exactly; query AFTER that date
      const facts = await getFactsAt('bitemp:carol', 'title', '2024-06-01T00:00:00Z');
      // Only senior engineer should match (valid_from = 2024-01-01, no valid_until)
      expect(facts.every((f) => f.value === 'senior engineer')).toBe(true);
    });

    it('includes valid_from and valid_until in returned facts', async () => {
      const facts = await getFactsAt('bitemp:carol', 'title', '2023-06-15T00:00:00Z');
      expect(facts[0]?.valid_from).toBeTruthy();
      expect(facts[0]?.valid_until).toBeTruthy();
    });
  });

  // ── getFactsDuring ───────────────────────────────────────────────────────────

  describe('getFactsDuring', () => {
    beforeAll(async () => {
      // dave: fact1 valid 2023-01-01 → 2023-06-30
      //        fact2 valid 2023-07-01 → 2024-01-01
      //        fact3 valid 2024-06-01 → open
      await transact(
        [
          {
            op: 'assert',
            entity: 'bitemp:dave',
            attribute: 'location',
            value: 'NYC',
            valid_from: '2023-01-01T00:00:00Z',
            valid_until: '2023-06-30T23:59:59Z',
          },
          {
            op: 'assert',
            entity: 'bitemp:dave',
            attribute: 'location',
            value: 'LA',
            valid_from: '2023-07-01T00:00:00Z',
            valid_until: '2024-01-01T00:00:00Z',
          },
          {
            op: 'assert',
            entity: 'bitemp:dave',
            attribute: 'location',
            value: 'Chicago',
            valid_from: '2024-06-01T00:00:00Z',
          },
        ],
        'agent:test'
      );
    });

    it('returns facts that overlap the query period (Allen interval)', async () => {
      // Query 2023-04-01 → 2023-08-01 should overlap NYC (ends Jun 30) and LA (starts Jul 1)
      const facts = await getFactsDuring(
        'bitemp:dave', 'location', '2023-04-01T00:00:00Z', '2023-08-01T00:00:00Z'
      );
      const values = facts.map((f) => f.value);
      expect(values).toContain('NYC');
      expect(values).toContain('LA');
      expect(values).not.toContain('Chicago');
    });

    it('returns open-ended fact when period_end is after its valid_from', async () => {
      const facts = await getFactsDuring(
        'bitemp:dave', 'location', '2024-08-01T00:00:00Z', '2025-01-01T00:00:00Z'
      );
      expect(facts.length).toBe(1);
      expect(facts[0]?.value).toBe('Chicago');
    });

    it('returns nothing when query period has no overlap', async () => {
      const facts = await getFactsDuring(
        'bitemp:dave', 'location', '2022-01-01T00:00:00Z', '2022-12-31T00:00:00Z'
      );
      expect(facts.length).toBe(0);
    });

    it('returns facts with no valid interval (open both ends) for any period', async () => {
      // Insert a fact with no valid interval (open on both ends)
      await transact(
        [{ op: 'assert', entity: 'bitemp:eve', attribute: 'status', value: 'active' }],
        'agent:test'
      );
      const facts = await getFactsDuring(
        'bitemp:eve', 'status', '2000-01-01T00:00:00Z', '2099-12-31T00:00:00Z'
      );
      expect(facts.length).toBeGreaterThan(0);
    });
  });

  // ── upsertSource ─────────────────────────────────────────────────────────────

  describe('upsertSource', () => {
    it('creates a new source', async () => {
      const source = await upsertSource('source:crm', 'CRM System', 0.8);
      expect(source.id).toBe('source:crm');
      expect(source.name).toBe('CRM System');
      expect(source.trust_weight).toBe(0.8);
      expect(source.created_at).toBeTruthy();
    });

    it('updates an existing source', async () => {
      const updated = await upsertSource('source:crm', 'CRM System v2', 0.9);
      expect(updated.name).toBe('CRM System v2');
      expect(updated.trust_weight).toBe(0.9);
    });

    it('creates a source with default trust_weight of 1.0', async () => {
      const source = await upsertSource('source:trusted', 'Trusted Feed', 1.0);
      expect(source.trust_weight).toBe(1.0);
    });

    it('creates a source with trust_weight below 1 (distrust)', async () => {
      const source = await upsertSource('source:unreliable', 'Unreliable Feed', 0.3);
      expect(source.trust_weight).toBe(0.3);
    });
  });

  // ── getSourceTrust ───────────────────────────────────────────────────────────

  describe('getSourceTrust', () => {
    it('returns source metadata for a registered source', async () => {
      await upsertSource('source:lookup-test', 'Lookup Test Source', 0.75);
      const source = await getSourceTrust('source:lookup-test');
      expect(source).not.toBeNull();
      expect(source?.trust_weight).toBe(0.75);
    });

    it('returns null for an unregistered source', async () => {
      const result = await getSourceTrust('source:does-not-exist');
      expect(result).toBeNull();
    });
  });

  // ── getDominantFacts — source trust integration ───────────────────────────────

  describe('getDominantFacts — source trust', () => {
    beforeAll(async () => {
      // Register sources with different trust weights
      await upsertSource('source:high-trust', 'High Trust', 1.5);
      await upsertSource('source:low-trust', 'Low Trust', 0.2);

      // Assert two facts for different entities with different source trust
      await transact(
        [
          {
            op: 'assert',
            entity: 'bitemp:frank',
            attribute: 'status',
            value: 'active',
            source_id: 'source:high-trust',
          },
        ],
        'agent:test'
      );
      await transact(
        [
          {
            op: 'assert',
            entity: 'bitemp:grace',
            attribute: 'status',
            value: 'active',
            source_id: 'source:low-trust',
          },
        ],
        'agent:test'
      );
    });

    it('includes source_id and source_trust in dominant fact entries', async () => {
      const results = await getDominantFacts('bitemp:frank');
      expect(results.length).toBeGreaterThan(0);
      const fact = results.find((r) => r.attribute === 'status');
      expect(fact?.source_id).toBe('source:high-trust');
      expect(fact?.source_trust).toBe(1.5);
    });

    it('source trust = 1.0 for facts with null source_id', async () => {
      // bitemp:bob was inserted without source_id
      const results = await getDominantFacts('bitemp:bob');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.source_trust).toBe(1.0);
    });

    it('effective_weight is scaled by source trust', async () => {
      // Use threshold 0 so both facts are returned regardless of effective_weight
      const frankFacts = await getDominantFacts('bitemp:frank', 0);
      const graceFacts = await getDominantFacts('bitemp:grace', 0);

      const frankStatus = frankFacts.find((f) => f.attribute === 'status');
      const graceStatus = graceFacts.find((f) => f.attribute === 'status');

      expect(frankStatus).toBeDefined();
      expect(graceStatus).toBeDefined();

      // Both have influence_weight = 1.0 (fresh assertions), but trust differs:
      // frank source_trust = 1.5 → effective_weight ≈ 1.5
      // grace source_trust = 0.2 → effective_weight ≈ 0.2
      expect(frankStatus!.effective_weight).toBeGreaterThan(graceStatus!.effective_weight);
    });

    it('low-trust source fact is filtered out below threshold when threshold > effective_weight', async () => {
      // grace status has effective_weight ≈ 0.2; threshold 0.5 should exclude it
      const results = await getDominantFacts('bitemp:grace', 0.5);
      const statusFact = results.find((f) => f.attribute === 'status');
      expect(statusFact).toBeUndefined();
    });
  });
});
