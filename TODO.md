# TODO: nexus-temporal-storage

- [ ] Create git branch feat/initial-build
- [ ] Initialize package.json with dependencies
- [ ] Create tsconfig.json
- [ ] Implement src/db.ts (PostgreSQL connection + schema migration)
- [ ] Implement src/datoms.ts (core EAV(T) operations)
- [ ] Implement src/mcp.ts (MCP server with all 11 tools)
- [ ] Implement src/index.ts (entrypoint)
- [ ] Write tests/datoms.test.ts (full coverage)
- [ ] Write tests/mcp.test.ts (MCP tool integration tests)
- [ ] Write README.md
- [ ] Write settings.snippet.json
- [ ] Run npm run build (verify it passes)
- [ ] Run tests (verify all pass)
- [ ] git diff --staged review
- [ ] git commit
- [ ] git push
- [ ] gh pr create
- [ ] gh pr merge --squash --auto
