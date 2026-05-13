import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  transact,
  getEntity,
  findEntities,
  queryGravita,
  asOf,
  getHistory,
  sinceTransaction,
  listEntities,
  listAttributes,
  getTransaction,
  getStats,
  corroborateExplicit,
  getDominanceCurve,
  getDominantFacts,
  detectAnomalies,
  getFactDuration,
} from './gravita.js';

const FactSchema = z.object({
  op: z.enum(['assert', 'retract']),
  entity: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string(),
});

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'nexus-gravitas',
    version: '1.0.0',
  });

  // ─── transact ───────────────────────────────────────────────────────────────
  server.tool(
    'transact',
    'Atomically assert or retract a batch of facts. All succeed or none do.',
    {
      facts: z.array(FactSchema).min(1).describe(
        'Array of facts: { op: "assert"|"retract", entity, attribute, value }'
      ),
      agent_id: z.string().optional().describe('Agent identifier for provenance'),
      note: z.string().optional().describe('Human-readable note for this transaction'),
    },
    async ({ facts, agent_id, note }) => {
      const result = await transact(facts, agent_id, note);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ─── get ────────────────────────────────────────────────────────────────────
  server.tool(
    'get',
    'Get current facts for an entity — latest non-retracted value per attribute.',
    {
      entity: z.string().min(1).describe('Entity ID, e.g. "project:ecoclaw"'),
      attribute: z
        .string()
        .optional()
        .describe('Optional: restrict to this attribute'),
    },
    async ({ entity, attribute }) => {
      const facts = await getEntity(entity, attribute);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(facts, null, 2),
          },
        ],
      };
    }
  );

  // ─── find ───────────────────────────────────────────────────────────────────
  server.tool(
    'find',
    'Find all entities currently having attribute = value.',
    {
      attribute: z.string().min(1).describe('Attribute name to match'),
      value: z.string().describe('Value to match (exact)'),
    },
    async ({ attribute, value }) => {
      const entities = await findEntities(attribute, value);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entities, null, 2),
          },
        ],
      };
    }
  );

  // ─── query ──────────────────────────────────────────────────────────────────
  server.tool(
    'query',
    'Query current state gravita with optional entity pattern, attribute, and since filters.',
    {
      entity_pattern: z
        .string()
        .optional()
        .describe('SQL LIKE pattern for entity, e.g. "project:%"'),
      attribute: z.string().optional().describe('Filter to this attribute'),
      since: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp — only gravita from transactions at or after this time'),
    },
    async ({ entity_pattern, attribute, since }) => {
      const results = await queryGravita(entity_pattern, attribute, since);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  // ─── as_of ──────────────────────────────────────────────────────────────────
  server.tool(
    'as_of',
    'Get the state of an entity at a specific past transaction or timestamp.',
    {
      entity: z.string().min(1).describe('Entity ID'),
      tx_id: z.number().int().optional().describe('Transaction ID to query as-of'),
      timestamp: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp to query as-of (used if tx_id not provided)'),
      attribute: z.string().optional().describe('Optional: restrict to this attribute'),
    },
    async ({ entity, tx_id, timestamp, attribute }) => {
      const facts = await asOf(entity, tx_id, timestamp, attribute);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(facts, null, 2),
          },
        ],
      };
    }
  );

  // ─── history ────────────────────────────────────────────────────────────────
  server.tool(
    'history',
    'Get the full timeline of all gravita (including retractions) for an entity/attribute.',
    {
      entity: z.string().min(1).describe('Entity ID'),
      attribute: z
        .string()
        .optional()
        .describe('Optional: restrict history to this attribute'),
    },
    async ({ entity, attribute }) => {
      const entries = await getHistory(entity, attribute);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entries, null, 2),
          },
        ],
      };
    }
  );

  // ─── since ──────────────────────────────────────────────────────────────────
  server.tool(
    'since',
    'Get all gravita added after a given transaction ID.',
    {
      tx_id: z.number().int().describe('Return gravita with tx_id > this value'),
      entity_pattern: z
        .string()
        .optional()
        .describe('SQL LIKE pattern to filter entities'),
    },
    async ({ tx_id, entity_pattern }) => {
      const entries = await sinceTransaction(tx_id, entity_pattern);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entries, null, 2),
          },
        ],
      };
    }
  );

  // ─── list_entities ──────────────────────────────────────────────────────────
  server.tool(
    'list_entities',
    'List all distinct entity IDs in the database.',
    {
      attribute_filter: z
        .string()
        .optional()
        .describe('Optional: only include entities that have this attribute'),
    },
    async ({ attribute_filter }) => {
      const entities = await listEntities(attribute_filter);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entities, null, 2),
          },
        ],
      };
    }
  );

  // ─── list_attributes ────────────────────────────────────────────────────────
  server.tool(
    'list_attributes',
    'List all distinct attributes and their usage counts.',
    {},
    async () => {
      const attrs = await listAttributes();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(attrs, null, 2),
          },
        ],
      };
    }
  );

  // ─── get_transaction ────────────────────────────────────────────────────────
  server.tool(
    'get_transaction',
    'Get transaction metadata and all gravita written in that transaction.',
    {
      tx_id: z.number().int().describe('Transaction ID to retrieve'),
    },
    async ({ tx_id }) => {
      const tx = await getTransaction(tx_id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(tx, null, 2),
          },
        ],
      };
    }
  );

  // ─── stats ──────────────────────────────────────────────────────────────────
  server.tool(
    'stats',
    'Get database statistics: total gravita, transactions, entities, attributes, and DB size.',
    {},
    async () => {
      const s = await getStats();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(s, null, 2),
          },
        ],
      };
    }
  );

  // ─── corroborate ────────────────────────────────────────────────────────────
  server.tool(
    'corroborate',
    'Explicitly corroborate a fact — increases its influence weight and resets its decay clock.',
    {
      entity: z.string().min(1).describe('Entity ID'),
      attribute: z.string().min(1).describe('Attribute name'),
      value: z.string().describe('Value to corroborate (exact match)'),
      agent_id: z.string().min(1).describe('Agent ID of the corroborating agent'),
      note: z.string().optional().describe('Optional note explaining the corroboration'),
    },
    async ({ entity, attribute, value, agent_id, note }) => {
      const result = await corroborateExplicit(entity, attribute, value, agent_id, note);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── get_dominance_curve ────────────────────────────────────────────────────
  server.tool(
    'get_dominance_curve',
    'Return the full influence weight history and lifecycle phase for a fact (assert → dominance → decay → superseded).',
    {
      entity: z.string().min(1).describe('Entity ID'),
      attribute: z.string().optional().describe('Optional: restrict to this attribute'),
      value: z.string().optional().describe('Optional: restrict to this exact value'),
    },
    async ({ entity, attribute, value }) => {
      const result = await getDominanceCurve(entity, attribute, value);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── get_dominant_facts ─────────────────────────────────────────────────────
  server.tool(
    'get_dominant_facts',
    'Return the currently dominant facts for an entity (or globally), ranked by effective influence weight.',
    {
      entity: z.string().optional().describe('Optional: restrict to this entity'),
      threshold: z
        .number()
        .min(0)
        .max(3)
        .optional()
        .describe('Minimum effective weight to consider dominant (default 0.7)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Maximum number of results (default 50)'),
      as_of: z
        .string()
        .optional()
        .describe('ISO 8601 timestamp — return dominant facts as of this time'),
    },
    async ({ entity, threshold, limit, as_of }) => {
      const result = await getDominantFacts(entity, threshold, limit, as_of);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── detect_anomalies ───────────────────────────────────────────────────────
  server.tool(
    'detect_anomalies',
    'Detect facts with anomalous weight trajectories: fast_ascent (suspicious rapid corroboration), isolated_assertion (unconfirmed high-weight fact), fast_decay (contradicted quickly).',
    {
      entity: z.string().optional().describe('Optional: restrict anomaly scan to this entity'),
      window_hours: z
        .number()
        .min(1)
        .optional()
        .describe('Look-back window in hours (default 24)'),
    },
    async ({ entity, window_hours }) => {
      const result = await detectAnomalies(entity, window_hours);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── get_fact_duration ──────────────────────────────────────────────────────
  server.tool(
    'get_fact_duration',
    'Return the effective duration of a fact — the period during which it was dominant (weight above threshold).',
    {
      entity: z.string().min(1).describe('Entity ID'),
      attribute: z.string().min(1).describe('Attribute name'),
      value: z.string().describe('Exact value'),
      dominance_threshold: z
        .number()
        .min(0)
        .max(3)
        .optional()
        .describe('Weight threshold for dominance (default 0.7)'),
    },
    async ({ entity, attribute, value, dominance_threshold }) => {
      const result = await getFactDuration(entity, attribute, value, dominance_threshold);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
