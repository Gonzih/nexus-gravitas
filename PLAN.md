# PLAN: nexus-temporal-storage

## Task Restatement
Build a Datomic-inspired temporal database for agentic systems. Every fact is a datom [entity, attribute, value, tx_id]. Nothing is ever updated or deleted — retractions add a new datom with retracted=true. Time-travel is native. The system is accessed exclusively via MCP stdio transport.

## Approach Considered

### Option A: Use JSONB for values (research spec approach)
- Pro: flexible typed values (numbers, arrays, objects stored natively)
- Con: the task prompt specifies a flat schema with TEXT + typed columns, not JSONB

### Option B: Use the schema from the task prompt (TEXT + value_num + value_ts + value_vec)
- Pro: matches the exact schema specified in the task
- Pro: value_vec enables semantic search via pgvector
- Con: less flexible for complex values

### Option C: Hybrid — JSONB primary with typed sidecars
- Con: over-engineering beyond the spec

**Decision: Option B** — implement exactly what the task prompt specifies. The schema is clear and complete.

## Files to Touch
- `package.json` — dependencies, scripts
- `tsconfig.json` — TypeScript config
- `src/db.ts` — PostgreSQL connection + schema migration
- `src/datoms.ts` — core EAV(T) operations
- `src/mcp.ts` — MCP server wiring all tools
- `src/index.ts` — entrypoint
- `tests/datoms.test.ts` — unit/integration tests
- `tests/mcp.test.ts` — MCP tool integration tests
- `README.md` — usage docs
- `settings.snippet.json` — MCP config snippet

## MCP Tools to Implement
1. `transact(facts, agent_id?, note?)` → `{tx_id, tx_at, count}`
2. `get(entity, attribute?)` → current facts (latest non-retracted per attribute)
3. `find(attribute, value)` → entities currently having attribute=value
4. `query(entity_pattern?, attribute?, since?)` → filtered current datoms
5. `as_of(entity, tx_id?, timestamp?, attribute?)` → entity state at past point
6. `history(entity, attribute?)` → full timeline including retractions
7. `since(tx_id, entity_pattern?)` → all datoms added after tx
8. `list_entities(attribute_filter?)` → distinct entities
9. `list_attributes()` → distinct attributes + usage count
10. `get_transaction(tx_id)` → tx metadata + datoms
11. `stats()` → total counts + DB size

## Risks & Unknowns
- pgvector may not be installed in test environment — tests should handle gracefully
- DATABASE_URL env var required — tests need a real PostgreSQL instance
- `DISTINCT ON` performance at scale — indexes mitigate this
- The task says "no schema migrations needed beyond initial CREATE IF NOT EXISTS" — good, that's what we'll do
