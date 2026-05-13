import { PoolClient } from 'pg';

// ─── Constants ────────────────────────────────────────────────────────────────

export const WEIGHT_INITIAL = 1.0;
export const WEIGHT_CORROBORATION_DELTA = 0.25;
export const WEIGHT_CONTRADICTION_DELTA = 0.4;
export const WEIGHT_FLOOR = 0.1;
export const WEIGHT_CEILING = 3.0;
export const DECAY_RATE = 0.995; // per hour

// ─── Decay ────────────────────────────────────────────────────────────────────

/**
 * Apply passive hourly decay to a stored weight.
 * Uses the created_at of the latest gravit for this triple as the decay clock.
 */
export function computeEffectiveWeight(
  storedWeight: number,
  lastEventAt: string
): number {
  const hoursElapsed = (Date.now() - new Date(lastEventAt).getTime()) / 3_600_000;
  const effective = storedWeight * Math.pow(DECAY_RATE, hoursElapsed);
  return Math.max(effective, WEIGHT_FLOOR);
}

// ─── Weight application (called inside an open transaction) ──────────────────

interface WeightResult {
  newDatomWeight: number;
  eventType: 'assert' | 'corroborate';
  /** Datom id of the conflicting old fact that was contradicted (if any) */
  contradictedId: number | null;
  contradictedOldWeight: number | null;
  contradictedNewWeight: number | null;
  contradictedValue: string | null;
}

/**
 * Compute the influence weight for a new assertion gravit and identify any
 * contradictions to apply to older gravita.
 *
 * Must be called BEFORE inserting the new gravit, within an open transaction.
 * Uses tx_id < currentTxId to ignore gravita from the same in-flight transaction.
 */
export async function applyWeightsOnAssert(
  client: PoolClient,
  entity: string,
  attribute: string,
  value: string,
  currentTxId: number
): Promise<WeightResult> {
  // 1. Check for existing same (entity, attribute, value) from a prior transaction
  const existingResult = await client.query<{ influence_weight: string }>(
    `SELECT influence_weight
     FROM datoms
     WHERE entity = $1 AND attribute = $2 AND value = $3
       AND retracted = false AND tx_id < $4
     ORDER BY tx_id DESC, id DESC
     LIMIT 1`,
    [entity, attribute, value, currentTxId]
  );

  if (existingResult.rows.length > 0) {
    const oldWeight = parseFloat(existingResult.rows[0]!.influence_weight);
    const newWeight = Math.min(oldWeight + WEIGHT_CORROBORATION_DELTA, WEIGHT_CEILING);
    return {
      newDatomWeight: newWeight,
      eventType: 'corroborate',
      contradictedId: null,
      contradictedOldWeight: null,
      contradictedNewWeight: null,
      contradictedValue: null,
    };
  }

  // 2. Check for contradicting fact: same (entity, attribute), different value
  const conflictResult = await client.query<{
    id: string;
    value: string;
    influence_weight: string;
  }>(
    `WITH ranked AS (
       SELECT id, value, influence_weight, retracted,
              ROW_NUMBER() OVER (PARTITION BY attribute ORDER BY tx_id DESC, id DESC) AS rn
       FROM datoms
       WHERE entity = $1 AND attribute = $2 AND tx_id < $3
     )
     SELECT id, value, influence_weight
     FROM ranked
     WHERE rn = 1 AND retracted = false AND value != $4`,
    [entity, attribute, currentTxId, value]
  );

  if (conflictResult.rows.length > 0) {
    const row = conflictResult.rows[0]!;
    const oldWeight = parseFloat(row.influence_weight);
    const newWeight = Math.max(oldWeight - WEIGHT_CONTRADICTION_DELTA, WEIGHT_FLOOR);
    return {
      newDatomWeight: WEIGHT_INITIAL,
      eventType: 'assert',
      contradictedId: parseInt(row.id, 10),
      contradictedOldWeight: oldWeight,
      contradictedNewWeight: newWeight,
      contradictedValue: row.value,
    };
  }

  // 3. Fresh assertion — no prior fact for this attribute
  return {
    newDatomWeight: WEIGHT_INITIAL,
    eventType: 'assert',
    contradictedId: null,
    contradictedOldWeight: null,
    contradictedNewWeight: null,
    contradictedValue: null,
  };
}

/**
 * Log a weight event into gravitWeightEvents (SQL table: datom_weight_events).
 */
export async function logWeightEvent(
  client: PoolClient,
  entity: string,
  attribute: string,
  value: string,
  eventType: 'assert' | 'corroborate' | 'contradict',
  weightBefore: number,
  weightAfter: number,
  txId: number,
  agentId: string | null,
  note: string | null
): Promise<void> {
  await client.query(
    `INSERT INTO datom_weight_events
       (entity, attribute, value, event_type, weight_before, weight_after, tx_id, agent_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entity, attribute, value, eventType, weightBefore, weightAfter, txId, agentId, note]
  );
}
