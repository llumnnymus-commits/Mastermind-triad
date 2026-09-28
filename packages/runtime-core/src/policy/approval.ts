import type { ProjectGraph } from '../graph/graph.js';
import type { NodeId } from '../graph/nodes.js';
import type { Intent } from '../intent/intent.js';
import type { ImpactResult, ImpactedNode } from '../impact/resolve.js';
import { EDGE_TYPES } from '../graph/edges.js';
import type { RiskAssessment } from './risk.js';

/**
 * The approval request.
 *
 * Every field is derived from the graph rather than summarized from the
 * agent's own account of what it is about to do. An approval prompt that says
 * "the agent would like to modify the database" is not authorization — the
 * person approving cannot see what is actually at stake. These are the
 * questions the specification requires be answerable before a consequential
 * action proceeds.
 */
export interface ApprovalRequest {
  readonly intentId: string;
  /** What will happen. */
  readonly operation: string;
  /** Why the runtime is recommending it. */
  readonly rationale: string;
  /** How the runtime intends to confirm it worked. */
  readonly successCondition: string;
  /** What systems are affected, worst-first, with the reason each is implicated. */
  readonly affectedSystems: readonly AffectedSystem[];
  /** Which people and agents are accountable or affected. */
  readonly affectedActors: readonly NodeId[];
  /** What data is in scope. */
  readonly dataInvolved: readonly NodeId[];
  /** What could go wrong, in plain language. */
  readonly risks: readonly string[];
  /** Whether the change can be undone, and how. */
  readonly reversibility: Reversibility;
  /** The policies that bind this change. */
  readonly governingPolicies: readonly NodeId[];
  /** The tests and evaluations that will be run before promotion. */
  readonly verificationPlan: readonly NodeId[];
  /** Present when the intent crossed its own declared limits. */
  readonly blockedBy: readonly string[];
}

export interface AffectedSystem {
  readonly id: NodeId;
  readonly name: string;
  readonly relation: string;
  readonly confidence: number;
  readonly live: boolean;
  /** Plain-language reading of the path that implicated it. */
  readonly why: string;
}

export interface Reversibility {
  readonly reversible: boolean;
  readonly detail: string;
  readonly irreversibleNodes: readonly NodeId[];
}

/**
 * Build the approval request from the graph, the intent, and the impact walk.
 *
 * Nothing here is generated prose about the change — every claim traces to a
 * node or an edge that can be inspected.
 */
export function buildApprovalRequest(
  graph: ProjectGraph,
  intent: Intent,
  impact: ImpactResult,
  risk: RiskAssessment,
): ApprovalRequest {
  const affectedSystems = impact.implicated
    .filter((n) => n.relation === 'target' || n.relation === 'blast')
    .map((n) => toAffectedSystem(n));

  const dataInvolved = impact.implicated
    .filter((n) => {
      const kind = n.node.kind;
      return (
        kind === 'database' || kind === 'table' || kind === 'schema' || kind === 'cache'
      );
    })
    .map((n) => n.id);

  const affectedActors = [
    intent.raisedBy,
    ...impact.implicated.filter((n) => n.id.startsWith('actor:')).map((n) => n.id),
  ].filter((id, i, all) => all.indexOf(id) === i);

  return {
    intentId: intent.id,
    operation: describeOperation(intent),
    rationale: intent.rationale,
    successCondition: intent.successCondition,
    affectedSystems,
    affectedActors,
    dataInvolved,
    risks: describeRisks(risk, impact),
    reversibility: describeReversibility(impact),
    governingPolicies: impact.constraints.map((c) => c.id),
    verificationPlan: impact.verifications.map((v) => v.id),
    blockedBy: impact.violations.map((v) => v.detail),
  };
}

function toAffectedSystem(node: ImpactedNode): AffectedSystem {
  return {
    id: node.id,
    name: node.node.name,
    relation: node.relation,
    confidence: node.score,
    live: node.node.live,
    why: explainPath(node),
  };
}

/**
 * Render the edge chain that implicated a node as a sentence.
 *
 * `login_screen depends on auth_service` reads correctly in both directions
 * because each edge type carries its own reading; a generic "connected to"
 * would lose the distinction between a screen that calls a service and a
 * service that writes to a table.
 */
export function explainPath(node: ImpactedNode): string {
  if (node.path.length === 0) return 'named directly by the intent';
  const parts = node.path.map((step) => {
    const reads = EDGE_TYPES[step.type].reads;
    return `${short(step.from)} ${reads} ${short(step.to)}`;
  });
  return parts.join('; ');
}

function short(id: NodeId): string {
  const segments = id.split(':');
  return segments[2] ?? id;
}

function describeOperation(intent: Intent): string {
  const actions = intent.actions.join(', ');
  const targets = intent.targets.map(short).join(', ');
  return `${actions} on ${targets} — ${intent.goal}`;
}

function describeRisks(risk: RiskAssessment, impact: ImpactResult): string[] {
  const risks = risk.reasons.map((r) => r.detail);
  if (impact.blastRadius.length > 0) {
    const worst = impact.blastRadius[0]!;
    risks.push(
      `if this is wrong, ${worst.node.name} is the most likely casualty (confidence ${worst.score})`,
    );
  }
  if (impact.verifications.length === 0) {
    risks.push('no tests or evaluations are attached to any implicated node — failure would be silent');
  }
  if (!impact.coverage.complete) {
    // Someone deciding whether to authorize this is entitled to know the list
    // they are looking at is short.
    risks.push(
      `the impact walk did not finish: ${impact.coverage.depthLimited} node(s) were left unexplored at confidence up to ${impact.coverage.highestUnexplored}, so the affected list below is incomplete`,
    );
  }
  return risks;
}

function describeReversibility(impact: ImpactResult): Reversibility {
  const irreversibleNodes = impact.irreversible.map((n) => n.id);
  if (irreversibleNodes.length === 0) {
    return {
      reversible: true,
      detail: 'no irreversible nodes implicated; rollback to the prior deployment restores state',
      irreversibleNodes,
    };
  }
  return {
    reversible: false,
    detail: `${irreversibleNodes.length} implicated node(s) cannot be restored by rollback: ${irreversibleNodes
      .map(short)
      .join(', ')}`,
    irreversibleNodes,
  };
}
