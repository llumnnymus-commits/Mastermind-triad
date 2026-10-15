import { z } from 'zod';
import { ACTION_CLASSES } from '@lbr/runtime-core';

/**
 * A declared policy.
 *
 * Policy is the one domain that cannot be discovered by reading a repository.
 * Code, tests, and infrastructure are all observable — a retention rule, an
 * approval requirement, a spending limit are decisions someone made, and a
 * system that infers them is guessing about exactly the things it is least
 * entitled to guess about. So they are declared, in a file that lives with the
 * project and changes under review like anything else.
 */
export const PolicyRuleSchema = z
  .object({
    /** Slug used to build the node id: `policy:<kind>:<id>`. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_.-]+$/, 'policy id must be lowercase alphanumeric, dot, dash or underscore'),
    kind: z.enum([
      'safety_rule',
      'retention_rule',
      'approval_requirement',
      'audit_requirement',
      'financial_limit',
      'consent_boundary',
    ]),
    name: z.string().min(1),
    /** Why the rule exists. Carried into the approval request a human reads. */
    rationale: z.string().optional(),
    /**
     * Whether this rule stops an agent and asks. A rule can bind a change —
     * appear in its constraint set, be recorded in lineage — without demanding
     * approval; requiring approval is a stronger claim and is stated
     * separately rather than inferred from the rule existing.
     */
    requiresApproval: z.boolean().default(false),
    /**
     * Action classes the rule governs. Omitted means all of them, which is the
     * conservative reading for a safety rule — a rule that forgot to say what
     * it covers should bind more, not less.
     */
    appliesToActions: z.array(z.enum(ACTION_CLASSES)).optional(),
    /**
     * What the rule governs: node-id prefixes, exact ids, or source paths.
     *
     * Prefixes rather than globs — `service:database:` covers every database
     * without a pattern language nobody can predict the edge cases of.
     *
     * Source paths are accepted because node ids are derived from the path
     * relative to whatever directory was ingested, so `code:module:src_auth`
     * becomes `code:module:packages_api_src_auth` when the ingest starts one
     * level up. A rule written against ids therefore binds or silently stops
     * binding depending on how the tool was invoked, which is the opposite of
     * what a policy is for. A selector containing `/` is matched against each
     * node's own recorded path instead, and survives the move.
     *
     * A rule governing nothing is a configuration error, not a no-op, and is
     * reported as unresolved.
     */
    governs: z.array(z.string().min(1)).min(1),
    /** Free-form fields carried onto the node, e.g. retentionDays. */
    attributes: z.record(z.unknown()).default({}),
  })
  .strict();

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyFileSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(PolicyRuleSchema),
  })
  .strict();

export type PolicyFile = z.infer<typeof PolicyFileSchema>;
