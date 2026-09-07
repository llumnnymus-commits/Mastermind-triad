/**
 * Edge types and their propagation semantics.
 *
 * This is the part the source specification hand-waved. "If NodesChanged >
 * Threshold, trigger UserApprovalRequest" is not implementable as written,
 * because it presumes you already know which nodes a change touches — and that
 * answer depends entirely on which *direction* you walk each edge.
 *
 * Every edge is directed `from -> to` and read as a sentence:
 *
 *     login_screen --depends_on--> auth_service
 *
 * Two different questions get asked of that edge, and they have different
 * answers:
 *
 *   1. BLAST  — "auth_service is changing; what breaks?"
 *      Walk *inbound* edges (where the changed node is the `to`) back to their
 *      `from`. login_screen depends on auth_service, so login_screen is at
 *      risk. This is the direction that causes outages.
 *
 *   2. CONTEXT — "login_screen is changing; what does it rely on?"
 *      Walk *outbound* edges (where the changed node is the `from`) to their
 *      `to`. login_screen depends on auth_service, so auth_service is context
 *      the change has to respect — but changing a screen rarely breaks the
 *      service underneath it.
 *
 * Blast weights are therefore high and context weights are low for the same
 * edge type. Collapsing them into one number is the mistake that makes naive
 * impact analysis either miss real breakage or flag the entire codebase.
 *
 * Two edge roles ignore direction entirely:
 *
 *   - CONSTRAINT (`governed_by`) — a policy that governs any implicated node
 *     governs the change. Policy never decays with distance.
 *   - VERIFICATION (`verified_by`) — the tests and evals attached to any
 *     implicated node are the tests that must run. Also never decays.
 */

export const EDGE_ROLES = ['structural', 'constraint', 'verification', 'metadata'] as const;
export type EdgeRole = (typeof EDGE_ROLES)[number];

export interface EdgeSemantics {
  /** How the edge participates in impact resolution. */
  readonly role: EdgeRole;
  /**
   * Weight applied when walking inbound (the changed node is the `to`, and we
   * are discovering what depends on it and may break).
   */
  readonly blast: number;
  /**
   * Weight applied when walking outbound (the changed node is the `from`, and
   * we are discovering what it relies on).
   */
  readonly context: number;
  /** Human-readable reading of the edge, used in approval requests. */
  readonly reads: string;
}

export const EDGE_TYPES = {
  // ---- structural: these carry real breakage -----------------------------
  depends_on: {
    role: 'structural',
    blast: 1.0,
    context: 0.35,
    reads: 'depends on',
  },
  calls: {
    role: 'structural',
    blast: 0.95,
    context: 0.35,
    reads: 'calls',
  },
  implements: {
    role: 'structural',
    blast: 0.95,
    context: 0.4,
    reads: 'implements',
  },
  /**
   * Writers score high in both directions: changing the writer can corrupt the
   * data, and changing the data shape breaks the writer. Reads are asymmetric —
   * a reader breaks when the schema moves, but the schema does not break when
   * a reader changes.
   */
  writes: {
    role: 'structural',
    blast: 1.0,
    context: 0.45,
    reads: 'writes to',
  },
  reads: {
    role: 'structural',
    blast: 0.8,
    context: 0.3,
    reads: 'reads from',
  },
  renders: {
    role: 'structural',
    blast: 0.75,
    context: 0.3,
    reads: 'renders',
  },
  navigates_to: {
    role: 'structural',
    blast: 0.5,
    context: 0.25,
    reads: 'navigates to',
  },
  configures: {
    role: 'structural',
    blast: 0.85,
    context: 0.4,
    reads: 'configures',
  },
  deployed_to: {
    role: 'structural',
    blast: 0.6,
    context: 0.5,
    reads: 'is deployed to',
  },
  /**
   * Containment, not dependency — a table is *part of* a database, a component
   * is part of a screen. Near-lossless in both directions, because touching a
   * part is touching the whole: a migration on `users` is a migration on the
   * accounts database, and modelling that as `depends_on` (0.35 context)
   * understates it badly enough that data policy stops binding.
   */
  part_of: {
    role: 'structural',
    blast: 0.9,
    context: 0.95,
    reads: 'is part of',
  },
  // ---- constraint: policy binds regardless of direction or distance ------
  governed_by: {
    role: 'constraint',
    blast: 1.0,
    context: 1.0,
    reads: 'is governed by',
  },
  // ---- verification: the proof obligations attached to a node -----------
  verified_by: {
    role: 'verification',
    blast: 1.0,
    context: 1.0,
    reads: 'is verified by',
  },
  // ---- metadata: attached for the record, does not propagate onward ------
  observes: {
    role: 'metadata',
    blast: 0.2,
    context: 0.2,
    reads: 'observes',
  },
  costs: {
    role: 'metadata',
    blast: 0.15,
    context: 0.15,
    reads: 'accrues cost against',
  },
  authored_by: {
    role: 'metadata',
    blast: 0,
    context: 0,
    reads: 'was authored by',
  },
  approved_by: {
    role: 'metadata',
    blast: 0,
    context: 0,
    reads: 'was approved by',
  },
  deployed_by: {
    role: 'metadata',
    blast: 0,
    context: 0,
    reads: 'was deployed by',
  },
} as const satisfies Record<string, EdgeSemantics>;

export type EdgeType = keyof typeof EDGE_TYPES;

export const EDGE_TYPE_NAMES = Object.keys(EDGE_TYPES) as EdgeType[];

export function isEdgeType(value: string): value is EdgeType {
  return Object.prototype.hasOwnProperty.call(EDGE_TYPES, value);
}

export function semanticsOf(type: EdgeType): EdgeSemantics {
  return EDGE_TYPES[type];
}

/** Edge types whose role means "always pull this in, never decay it". */
export function isNonDecaying(type: EdgeType): boolean {
  const role = EDGE_TYPES[type].role;
  return role === 'constraint' || role === 'verification';
}
