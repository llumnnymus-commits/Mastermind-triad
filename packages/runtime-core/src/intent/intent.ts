import { z } from 'zod';
import { NodeIdSchema } from '../graph/nodes.js';

/**
 * Where a change originated. The runtime treats these differently: an incident
 * response may auto-authorize repairs a scheduled policy sweep may not.
 */
export const INTENT_SOURCES = ['human', 'agent', 'policy_schedule', 'incident'] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];

/**
 * The action a change performs, independent of what it touches.
 *
 * Classified separately from the graph because risk has two inputs: what you
 * are doing, and what you are doing it to. Deleting is dangerous even against
 * a small blast radius; a config edit against a live payment path is dangerous
 * even though editing config is ordinarily routine.
 */
export const ACTION_CLASSES = [
  'read',
  'restart',
  'rollback',
  'flag_toggle',
  'cache_clear',
  'code_change',
  'config_change',
  'schema_migration',
  'data_delete',
  'permission_change',
  'secret_rotation',
  'publish',
  'financial_operation',
  'data_collection_expansion',
  'policy_change',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/**
 * The limits a change must not cross. These are hard bounds checked before the
 * change is allowed to proceed — not advisory notes attached to a description.
 */
export const IntentLimitsSchema = z.object({
  /** Node ids the change is forbidden to touch, whatever the impact walk finds. */
  forbiddenNodes: z.array(NodeIdSchema).default([]),
  /** Maximum additional operating cost per day this change may introduce, in USD. */
  maxAddedDailyCostUsd: z.number().nonnegative().optional(),
  /** Refuse the change if it implicates more structural nodes than this. */
  maxImplicatedNodes: z.number().int().positive().optional(),
  /** Refuse the change if it implicates any irreversible node. */
  forbidIrreversible: z.boolean().default(false),
});

export type IntentLimits = z.infer<typeof IntentLimitsSchema>;

/**
 * An intent is the unit of change. Not a diff — a diff says what bytes moved;
 * an intent says what outcome is wanted, so the runtime can check afterward
 * whether the outcome was actually achieved (behavioral validation) rather
 * than only whether the tests still pass (mechanical validation).
 */
export const IntentSchema = z.object({
  id: z.string().min(1),
  /** What the change is trying to accomplish, in plain language. */
  goal: z.string().min(1),
  /** Why it is needed — carried into the approval request and the lineage record. */
  rationale: z.string().min(1),
  source: z.enum(INTENT_SOURCES),
  /** The actor that raised it: `actor:human:...` or `actor:agent:...`. */
  raisedBy: NodeIdSchema,
  /** The nodes the change intends to modify directly. The walk starts here. */
  targets: z.array(NodeIdSchema).min(1),
  /** What the change does, independent of what it touches. */
  actions: z.array(z.enum(ACTION_CLASSES)).min(1),
  /**
   * The condition that decides whether this change worked. Behavioral
   * validation checks this; without it a deployment can only be judged on
   * "nothing crashed", which is not the same as "it did what was asked".
   */
  successCondition: z.string().min(1),
  limits: IntentLimitsSchema.default({}),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
});

export type Intent = z.infer<typeof IntentSchema>;

export function parseIntent(input: unknown): Intent {
  return IntentSchema.parse(input);
}
