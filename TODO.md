# TODO: Bitemporal Support

- [ ] Create branch feat/bitemporal
- [ ] src/db.ts: ADD COLUMN migrations + gravita_sources table + index
- [ ] src/gravita.ts: types (Fact, Gravit, CurrentFact, RawRows), parseGravit, parseCurrentFact
- [ ] src/gravita.ts: update all SELECT queries to include 4 new columns
- [ ] src/gravita.ts: update transact() INSERT to pass bitemporal fields
- [ ] src/gravita.ts: add GravitaSource interface + parseGravitaSource
- [ ] src/gravita.ts: add getFactsAt() and getFactsDuring()
- [ ] src/gravita.ts: add upsertSource() and getSourceTrust()
- [ ] src/gravita.ts: update getDominantFacts() to JOIN gravita_sources + factor trust
- [ ] src/gravita.ts: update getDominanceCurve() to factor source trust in current_weight
- [ ] src/mcp.ts: update FactSchema with optional bitemporal fields
- [ ] src/mcp.ts: import new functions and add 4 new MCP tools
- [ ] tests/bitemporal.test.ts: write integration tests
- [ ] npm install, run tests, fix failures
- [ ] git diff --staged review
- [ ] commit + push + PR + merge + npm version patch + publish
