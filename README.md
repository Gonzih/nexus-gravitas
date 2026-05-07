# nexus-temporal-storage

A Datomic-inspired temporal database for agentic systems, accessed exclusively via MCP.

Every fact is a **datom**: `[entity, attribute, value, tx_id]`. Nothing is ever updated or deleted — only new datoms are appended. Retractions add a new datom with `retracted=true`. Time-travel is native: query the DB as it was at any transaction or timestamp.

## Stack

- **TypeScript** throughout
- **PostgreSQL + pgvector** backend (connection via `DATABASE_URL` env var)
- **MCP server** as the only interface (stdio transport)

## Quick Start

```bash
npm install
npm run build

DATABASE_URL=postgres://localhost/mydb node dist/index.js
```

The server migrates the schema on startup (idempotent `CREATE IF NOT EXISTS`).

## Entity ID Conventions

Entity IDs are namespaced strings — human-readable and persistent across sessions. Agents address entities by name directly.

| Namespace     | Description                              | Example                            |
|---------------|------------------------------------------|------------------------------------|
| `project:`    | Long-lived project entities              | `project:ecoclaw`                  |
| `session:`    | Agent session contexts                   | `session:abc-123`                  |
| `task:`       | Discrete tasks / work items              | `task:implement-auth`              |
| `decision:`   | Recorded decisions with rationale        | `decision:2026-05-07:db-choice`    |
| `concept:`    | Domain knowledge entries                 | `concept:temporal-database`        |
| `user:`       | Human users                              | `user:gonzih`                      |
| `agent:`      | AI agent instances or roles              | `agent:planner`                    |
| `file:`       | File references                          | `file:src/main.ts`                 |
| `event:`      | Discrete events (UUID suffix OK)         | `event:f47ac10b-...`               |

Recommended characters: alphanumeric, `-`, `_`, `:`, `.`. Max 256 characters.

## MCP Tools

### Writes

#### `transact`
Atomically assert or retract a batch of facts.

```json
{
  "facts": [
    { "op": "assert", "entity": "project:ecoclaw", "attribute": "status", "value": "active" },
    { "op": "retract", "entity": "project:ecoclaw", "attribute": "status", "value": "planning" }
  ],
  "agent_id": "agent:planner",
  "note": "Status updated after review"
}
```

Returns: `{ "tx_id": 42, "tx_at": "2026-05-07T14:23:00Z", "count": 2 }`

### Current State Queries

#### `get`
Get current facts for an entity (latest non-retracted value per attribute).

```json
{ "entity": "project:ecoclaw" }
{ "entity": "project:ecoclaw", "attribute": "status" }
```

#### `find`
Find all entities currently having `attribute = value`.

```json
{ "attribute": "status", "value": "active" }
```

#### `query`
Filtered current-state query with optional entity pattern, attribute, and since timestamp.

```json
{ "entity_pattern": "project:%", "attribute": "status", "since": "2026-01-01T00:00:00Z" }
```

### Time-Travel Queries

#### `as_of`
Get entity state at a specific past transaction or timestamp.

```json
{ "entity": "project:ecoclaw", "tx_id": 42 }
{ "entity": "project:ecoclaw", "timestamp": "2026-03-01T00:00:00Z" }
```

#### `history`
Full timeline of all datoms (including retractions) for an entity/attribute.

```json
{ "entity": "project:ecoclaw", "attribute": "status" }
```

#### `since`
All datoms added after a given transaction.

```json
{ "tx_id": 100, "entity_pattern": "project:%" }
```

### Meta

#### `list_entities`
All distinct entity IDs, optionally filtered by attribute.

```json
{ "attribute_filter": "status" }
```

#### `list_attributes`
All distinct attributes and their usage counts.

#### `get_transaction`
Transaction metadata + all datoms written in that transaction.

```json
{ "tx_id": 42 }
```

#### `stats`
Total datoms, transactions, entities, attributes, and DB size.

## Time-Travel Examples

```
# Assert initial status
transact([{ op: "assert", entity: "project:ecoclaw", attribute: "status", value: "planning" }])
→ { tx_id: 1 }

# Later: transition to active
transact([
  { op: "retract", entity: "project:ecoclaw", attribute: "status", value: "planning" },
  { op: "assert",  entity: "project:ecoclaw", attribute: "status", value: "active" }
])
→ { tx_id: 2 }

# Current state
get({ entity: "project:ecoclaw", attribute: "status" })
→ [{ attribute: "status", value: "active", tx_id: 2 }]

# As-of tx 1 (before the update)
as_of({ entity: "project:ecoclaw", tx_id: 1, attribute: "status" })
→ [{ attribute: "status", value: "planning", tx_id: 1 }]

# Full history
history({ entity: "project:ecoclaw", attribute: "status" })
→ [
    { retracted: false, value: "planning", tx_id: 1 },
    { retracted: true,  value: "planning", tx_id: 2 },
    { retracted: false, value: "active",   tx_id: 2 }
  ]
```

## Environment Variables

| Variable       | Description                        | Required |
|----------------|------------------------------------|----------|
| `DATABASE_URL` | PostgreSQL connection string        | Yes      |

## Development

```bash
npm install
npm run build       # compile TypeScript
npm test            # run integration tests (requires DATABASE_URL)
```

## MCP Configuration

See `settings.snippet.json` for the Claude Code / MCP config snippet.
