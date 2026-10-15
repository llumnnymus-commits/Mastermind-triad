import { z } from 'zod';
import { DOMAINS, NODE_KINDS, domainOfKind, type Domain } from './domains.js';
import { EDGE_TYPE_NAMES, type EdgeType } from './edges.js';

/**
 * Node identity is `domain:kind:slug` — e.g. `service:database:accounts`.
 *
 * Structured ids are load-bearing rather than cosmetic: the impact engine and
 * the risk classifier both need to reason about a node's domain and kind
 * without a lookup, and lineage records stay readable when replayed months
 * later.
 */
export const NodeIdSchema = z
  .string()
  .regex(
    /^[a-z_]+:[a-z_]+:[a-z0-9_.-]+$/,
    'node id must be `domain:kind:slug` (lowercase, e.g. `service:database:accounts`)',
  );

export type NodeId = z.infer<typeof NodeIdSchema>;

const allKinds = DOMAINS.flatMap((d) => NODE_KINDS[d] as readonly string[]);

/**
 * Every node carries the operational attributes the runtime needs regardless
 * of domain. Domain-specific detail lives in `attributes`, which stays open —
 * a `database` node wants `engine` and `region`; a `screen` node does not.
 */
export const GraphNodeSchema = z
  .object({
    id: NodeIdSchema,
    kind: z.enum(allKinds as [string, ...string[]]),
    name: z.string().min(1),
    /**
     * True when the node cannot be restored after destructive change — a
     * production database, a published artifact, a moved payment. Drives risk
     * classification directly.
     */
    irreversible: z.boolean().default(false),
    /**
     * Whether the node is live in production. A change implicating running
     * nodes is a different risk proposition than one confined to a draft.
     */
    live: z.boolean().default(false),
    /** Free-form domain-specific detail. */
    attributes: z.record(z.unknown()).default({}),
  })
  .superRefine((node, ctx) => {
    const declared = node.id.split(':');
    const domain = declared[0];
    const kind = declared[1];
    const kindDomain = domainOfKind(node.kind);

    if (kindDomain === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown node kind '${node.kind}'`,
        path: ['kind'],
      });
      return;
    }
    if (domain !== kindDomain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id domain '${domain}' does not match domain '${kindDomain}' of kind '${node.kind}'`,
        path: ['id'],
      });
    }
    if (kind !== node.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id kind '${kind}' does not match kind '${node.kind}'`,
        path: ['id'],
      });
    }
  });

export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: NodeIdSchema,
  type: z.enum(EDGE_TYPE_NAMES as [EdgeType, ...EdgeType[]]),
  to: NodeIdSchema,
  attributes: z.record(z.unknown()).default({}),
});

export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export function domainOf(id: NodeId): Domain {
  return id.split(':')[0] as Domain;
}

export function makeNodeId(domain: Domain, kind: string, slug: string): NodeId {
  return `${domain}:${kind}:${slug}`;
}
