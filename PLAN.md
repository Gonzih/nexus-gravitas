# Plan: Rename datom → gravit, Package → nexus-gravitas

## Task Restatement

Rename all terminology from datom/datoms/Datom to gravit/gravita/Gravit throughout
the codebase. Rename package from nexus-temporal-storage to nexus-gravitas.
The system is now named "Gravitas" — after the GSV in Iain M. Banks' *Excession*.

## Naming Rules

- `datom` → `gravit`
- `datoms` → `gravita`
- `Datom` (TypeScript type) → `Gravit`
- `RawDatomRow` → `RawGravitRow`
- `TransactionWithDatoms` → `TransactionWithGravita`
- SQL table `datoms` → KEEP AS-IS (safe migration), add SQL comment
- SQL table `datom_weight_events` → KEEP AS-IS, add TS alias comment
- `nexus-temporal-storage` → `nexus-gravitas`

## Files to Touch

- `src/datoms.ts` → rename to `src/gravita.ts` (all type/function/variable renames)
- `src/mcp.ts` — import path, function names, tool descriptions, server name
- `src/db.ts` — comments only, add `-- gravita (formerly datoms)` SQL comment
- `src/weight.ts` — comments only
- `tests/datoms.test.ts` → rename to `tests/gravita.test.ts`
- `tests/mcp.test.ts` — import path update
- `tests/weight.test.ts` — import path update, describe text
- `README.md` — full rewrite with new title, subtitle, Banks quote
- `package.json` — name, description
- `settings.snippet.json` — package name reference

## Approach

Direct file-by-file rename. No abstraction needed — pure find-replace with judgment.

## Risks

- `total_datoms` field in StatsResult and SQL alias: rename to `total_gravita`
- `datoms` field in TransactionWithDatoms: rename to `gravita` in TransactionWithGravita
- All callers of these APIs must be updated (mcp.ts returns JSON, so field names change)
- Build must pass after rename — no forgotten import paths
