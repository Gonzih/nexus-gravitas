# nexus-gravitas

Gravitas — temporal semantic memory for agentic systems.

> Gravitas takes its name from the GSV *Gravitas* in Iain M. Banks' *Excession* — a Culture Mind carrying the accumulated weight of knowledge it can barely contain.

A **gravit** is the atomic unit of weighted, time-bound knowledge: `[entity, attribute, value, tx_id]`. Nothing is ever updated or deleted — only new gravita are appended. Retractions add a new gravit with `retracted=true`. Time-travel is native: query the DB as it was at any transaction or timestamp.

Every gravit carries an **influence weight** that tracks how dominant a fact is over time. Facts start at weight 1.0, gain weight when corroborated by other agents, lose weight when contradicted, and passively decay. Dominance curves, fact duration, and anomaly detection expose this lifecycle.

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

#### `corroborate`
Explicitly corroborate a fact — increases its influence weight and resets its decay clock.

```json
{
  "entity": "project:ecoclaw",
  "attribute": "status",
  "value": "active",
  "agent_id": "agent:reviewer",
  "note": "Confirmed active in standup"
}
```

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
Full timeline of all gravita (including retractions) for an entity/attribute.

```json
{ "entity": "project:ecoclaw", "attribute": "status" }
```

#### `since`
All gravita added after a given transaction.

```json
{ "tx_id": 100, "entity_pattern": "project:%" }
```

### Semantic Weight / Dominance

#### `get_dominance_curve`
Return the full influence weight history and lifecycle phase for a fact (assert → dominance → decay → superseded).

```json
{ "entity": "project:ecoclaw", "attribute": "status", "value": "active" }
```

#### `get_dominant_facts`
Return the currently dominant facts for an entity (or globally), ranked by effective influence weight.

```json
{ "entity": "project:ecoclaw", "threshold": 0.7, "limit": 20 }
```

#### `detect_anomalies`
Detect facts with anomalous weight trajectories: fast_ascent (suspicious rapid corroboration), isolated_assertion (unconfirmed high-weight fact), fast_decay (contradicted quickly).

```json
{ "entity": "project:ecoclaw", "window_hours": 24 }
```

#### `get_fact_duration`
Return the effective duration of a fact — the period during which it was dominant (weight above threshold).

```json
{ "entity": "project:ecoclaw", "attribute": "status", "value": "active" }
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
Transaction metadata + all gravita written in that transaction.

```json
{ "tx_id": 42 }
```

#### `stats`
Total gravita, transactions, entities, attributes, and DB size.

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
