import type { ProjectGraph } from '../graph/graph.js';
import type { GraphNode, NodeId } from '../graph/nodes.js';
import type { Intent } from '../intent/intent.js';
import type { ImpactResult, ImpactedNode } from '../impact/resolve.js';

/**
 * How a node is brought into the isolated environment.
 *
 * The specification calls for "an isolated environment that mirrors the
 * relevant application state" — relevant being the operative word. Mirroring
 * everything is a staging environment, which is expensive, slow, and drifts.
 * Mirroring nothing is a unit test, which cannot observe integration breakage.
 * The impact walk already computed which slice matters; this turns that slice
 * into a materialization decision per node.
 */
export const MATERIALIZATION = ['real', 'copy', 'stub', 'excluded'] as const;
export type Materialization = (typeof MATERIALIZATION)[number];

export interface MaterializedNode {
  readonly id: NodeId;
  readonly name: string;
  readonly mode: Materialization;
  /** Why this mode was chosen — surfaced in the plan, not inferred by a reader. */
  readonly reason: string;
  readonly confidence: number;
}

export interface MirrorPlan {
  readonly intentId: string;
  readonly nodes: readonly MaterializedNode[];
  /** Nodes whose data must be snapshot-restored before the mirror can run. */
  readonly snapshotsRequired: readonly NodeId[];
  /** Third-party surfaces that must be stubbed — never called for real from a mirror. */
  readonly externalStubs: readonly NodeId[];
  /** Policy nodes carried into the environment as configuration constraints. */
  readonly constraints: readonly NodeId[];
  /** Tests and evaluations to run inside the mirror. */
  readonly verificationPlan: readonly NodeId[];
  /** Violated safety invariants. A non-empty list means the plan must not run. */
  readonly safetyViolations: readonly string[];
}

export interface MirrorOptions {
  /**
   * Confidence at or above which a node in the blast radius is materialized
   * for real rather than stubbed. Default 0.5.
   *
   * Below this a node is included as a stub: present enough that wiring
   * resolves, cheap enough that the mirror stays fast. The cost of guessing
   * wrong here is asymmetric — a stub that should have been real hides
   * integration breakage — so the threshold sits at the midpoint rather than
   * optimizing for mirror size.
   */
  readonly realThreshold?: number;
}

/** Node kinds that are never instantiated inside a mirror. */
const NEVER_MATERIALIZED = new Set([
  'deploy_target',
  'compute_resource',
  'domain',
  'network_permission',
  'secret',
]);

/**
 * Plan the isolated environment for an intent.
 *
 * The invariant that matters more than any sizing decision: a mirror is never
 * pointed at live irreversible state. A node that is both `live` and
 * `irreversible` — a production database, a payment ledger — is materialized
 * as a restored copy or not at all, whatever its confidence. Getting this
 * wrong means a validation run mutates production, which is the exact failure
 * the isolation step exists to prevent, so it is enforced here and asserted in
 * `safetyViolations` rather than left to the executor to remember.
 */
export function planMirror(
  graph: ProjectGraph,
  intent: Intent,
  impact: ImpactResult,
  options: MirrorOptions = {},
): MirrorPlan {
  const realThreshold = options.realThreshold ?? 0.5;
  const nodes: MaterializedNode[] = [];
  const snapshotsRequired: NodeId[] = [];
  const externalStubs: NodeId[] = [];

  for (const impacted of impact.implicated) {
    if (impacted.relation === 'constraint' || impacted.relation === 'verification') continue;
    if (impacted.id.startsWith('actor:')) continue;

    const decision = decide(impacted, intent, realThreshold);
    nodes.push({
      id: impacted.id,
      name: impacted.node.name,
      mode: decision.mode,
      reason: decision.reason,
      confidence: impacted.score,
    });

    if (decision.mode === 'copy') snapshotsRequired.push(impacted.id);
    if (decision.mode === 'stub' && impacted.node.kind === 'external_service') {
      externalStubs.push(impacted.id);
    }
  }

  return {
    intentId: intent.id,
    nodes,
    snapshotsRequired,
    externalStubs,
    constraints: impact.constraints.map((c) => c.id),
    verificationPlan: impact.verifications.map((v) => v.id),
    safetyViolations: checkSafety(graph, nodes),
  };
}

function decide(
  impacted: ImpactedNode,
  intent: Intent,
  realThreshold: number,
): { mode: Materialization; reason: string } {
  const node = impacted.node;

  if (NEVER_MATERIALIZED.has(node.kind)) {
    return {
      mode: 'excluded',
      reason: `${node.kind} belongs to the host environment; the mirror provides its own`,
    };
  }

  // The invariant. Live irreversible state is copied or left out, never bound
  // to for real, regardless of how central it is to the change.
  if (node.live && node.irreversible) {
    return {
      mode: 'copy',
      reason: 'live and irreversible — restored from snapshot so validation cannot touch production',
    };
  }

  // Third parties are never called for real from a mirror: it costs money,
  // mutates state outside the blast radius, and makes runs non-repeatable.
  if (node.kind === 'external_service') {
    return { mode: 'stub', reason: 'third-party surface — stubbed to keep the run repeatable' };
  }

  if (intent.targets.includes(impacted.id)) {
    return { mode: 'real', reason: 'named directly by the intent' };
  }

  if (impacted.relation === 'blast') {
    return impacted.score >= realThreshold
      ? {
          mode: 'real',
          reason: `in the blast radius at ${impacted.score} — materialized so breakage is observable`,
        }
      : {
          mode: 'stub',
          reason: `in the blast radius at ${impacted.score}, below the ${realThreshold} threshold`,
        };
  }

  return {
    mode: 'stub',
    reason: 'context the change relies on — present so wiring resolves, not exercised',
  };
}

/**
 * Safety invariants checked after planning rather than trusted during it.
 *
 * These are the assertions worth failing a run over: they describe states in
 * which a validation pass could damage something it was supposed to be
 * isolated from.
 */
function checkSafety(graph: ProjectGraph, nodes: readonly MaterializedNode[]): string[] {
  const violations: string[] = [];

  for (const planned of nodes) {
    if (planned.mode !== 'real') continue;
    const node: GraphNode = graph.requireNode(planned.id);
    if (node.live && node.irreversible) {
      violations.push(
        `${planned.id} is live and irreversible but planned as 'real' — the mirror would bind to production state`,
      );
    }
    if (node.kind === 'external_service') {
      violations.push(`${planned.id} is a third-party service but planned as 'real'`);
    }
  }

  if (nodes.length > 0 && nodes.every((n) => n.mode !== 'real')) {
    violations.push('no node is materialized for real — the mirror would validate nothing');
  }

  return violations;
}
