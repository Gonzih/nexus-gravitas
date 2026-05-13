# Plan: Bitemporal Support for nexus-gravitas

## Task Restatement
Add three independent time axes to every gravit:
1. `valid_from` / `valid_until` — when the fact held in the world (nullable = open-ended)
2. `authored_at` — when the source originally recorded it
3. `tx` — already exists (transaction time: when it entered our system)

Plus a `gravita_sources` table for source trust, which feeds into effective weight computation.

## Approach

**Chosen: Additive, migration-safe schema extension with TypeScript propagation**

- `ALTER TABLE datoms ADD COLUMN IF NOT EXISTS` for all new columns — safe for existing data
- New `gravita_sources` table with no FK from `datoms.source_id` — insert order flexible
- Extend `Fact` interface with optional fields so `transact()` accepts and passes them through
- New functions in `gravita.ts`: `getFactsAt`, `getFactsDuring`, `upsertSource`, `getSourceTrust`
- Update `getDominantFacts` and `getDominanceCurve` to LEFT JOIN `gravita_sources` and multiply trust
- New MCP tools: `get_facts_at`, `get_facts_during`, `get_source_trust`, `upsert_source`

Alternatives considered:
- Separate "valid_time" table: more normalized but more complex joins, no benefit here
- FK constraint on source_id: more integrity but prevents inserting facts before registering source

## Files to Touch
- `src/db.ts` — ALTER TABLE migrations + CREATE gravita_sources + index
- `src/gravita.ts` — type extensions, parse updates, new functions, updated queries
- `src/mcp.ts` — new tools, updated FactSchema
- `tests/bitemporal.test.ts` — new integration test file

## Risks
- All existing SELECT queries that return Gravit/CurrentFact/HistoryEntry need 4 new columns; missing one causes TypeScript mismatch or runtime undefined
- `getDominantFacts` sorts by `influence_weight DESC` in SQL before source trust is applied in TS; ordering is approximate — acceptable
- Test isolation: new test file must truncate `gravita_sources` in beforeAll
