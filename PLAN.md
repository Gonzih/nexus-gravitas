# Plan: Temporal Semantic Analysis

## Task Restatement

Extend the existing EAV(T) datom model with an influence weight system that tracks how "dominant" each fact is over time. Facts start at weight 1.0, gain weight when corroborated by other agents, lose weight when contradicted, and passively decay. New MCP tools expose dominance curves, fact duration, and anomaly detection.

## Approaches Considered

### A) Mutable weight column only (no event log)
Store `influence_weight` on datoms, UPDATE it in place. Simple but no history — can't build dominance curves or detect anomalies. Rejected.

### B) Separate immutable event log + mutable weight on datoms (chosen)
- `influence_weight FLOAT DEFAULT 1.0` on datoms: holds the CURRENT stored weight (updated on contradiction)
- `datom_weight_events` table: append-only log of all weight change events (assert/corroborate/contradict)
- Passive decay: computed on read using `weight * 0.995^hours_since_last_event`, not stored
- For corroborations: insert a NEW datom at increased weight (provenance + the window function returns the latest weight as "current")
- For contradictions: insert new datom at 1.0 AND UPDATE the old conflicting datom's weight (subtract 0.4)

### C) Fully append-only weight event sourcing
Store ALL weight changes as events; compute current weight by replaying. Clean but expensive to query.
Rejected for query complexity.

## Chosen Approach: B

## Files to Touch

- `src/db.ts` — new migrations: `influence_weight` column + `datom_weight_events` table
- `src/weight.ts` — NEW: WeightEngine constants, `computeEffectiveWeight`, `applyWeightsOnAssert`
- `src/datoms.ts` — extend types with `influence_weight`, modify `transact`, add 5 new export functions
- `src/mcp.ts` — add 5 new MCP tools
- `tests/weight.test.ts` — NEW: integration tests for all new functionality
- `package.json` — bump patch version on publish

## Key Design Decisions

1. **Corroboration via new datom**: asserting same (entity, attribute, value) inserts a new datom at `old_weight + 0.25`. The window function picks the latest datom; current weight is always on the newest row.
2. **Contradiction mutates old datom**: `UPDATE datoms SET influence_weight = max(old - 0.4, 0.1)`. The old value's datom gets penalized in place.
3. **Weight check uses tx_id < currentTxId**: within a multi-fact transaction, only consider facts from PREVIOUS transactions to avoid intra-tx order confusion.
4. **Decay is on-read**: `effective_weight = stored_weight * 0.995^(hours_since_latest_datom_for_this_triple)`. `created_at` of the latest datom for (entity, attribute, value) is the "last corroboration time".
5. **datom_weight_events** tracks all events for dominance curve queries. Each event stores entity/attribute/value/event_type/weight_before/weight_after/tx_id/agent_id/created_at.

## Risks

- Multi-fact transactions with conflicting facts in the same tx need careful ordering (mitigated by tx_id < currentTxId check)
- Adding `influence_weight` to existing datoms (ALTER TABLE ... ADD COLUMN IF NOT EXISTS) sets default 1.0 for all existing rows — correct
- `RawCurrentFactRow` and `CurrentFact` types gain `influence_weight` (additive, backward-compatible)
