import type { ActionClass, Intent } from '../intent/intent.js';
import type { ImpactResult } from '../impact/resolve.js';
import type { NodeId } from '../graph/nodes.js';

export const RISK_TIERS = ['low', 'elevated', 'high'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * Baseline risk per action class, before the graph is consulted.
 *
 * Risk has two independent inputs and both are needed. Deleting data is
 * dangerous even when the blast radius is small; editing config is ordinarily
 * routine but not when it lands on a live payment path. This table supplies
 * the first input; `classifyRisk` combines it with the second.
 *
 * The `low` set is exactly the reversible-repair class the runtime is allowed
 * to perform unattended: restart an unhealthy worker, roll back a failed
 * release, clear a corrupted cache, toggle a pre-approved safety flag.
 */
const ACTION_BASELINE: Record<ActionClass, RiskTier> = {
  read: 'low',
  restart: 'low',
  rollback: 'low',
  flag_toggle: 'low',
  cache_clear: 'low',
  code_change: 'elevated',
  config_change: 'elevated',
  schema_migration: 'high',
  data_delete: 'high',
  permission_change: 'high',
  secret_rotation: 'high',
  publish: 'high',
  financial_operation: 'high',
  data_collection_expansion: 'high',
  policy_change: 'high',
};

/** Action classes that destroy or expose state rather than merely altering it. */
const DESTRUCTIVE: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'schema_migration',
  'data_delete',
  'permission_change',
  'secret_rotation',
  'publish',
  'financial_operation',
  'data_collection_expansion',
]);

/**
 * Actions whose effect on a live system is transient and self-resolving.
 *
 * A blast radius means something different for these. Restarting a worker that
 * three live surfaces depend on interrupts them for seconds and then they
 * recover; migrating the schema underneath those same surfaces does not. Both
 * have identical blast radii on the graph, so the graph alone cannot separate
 * them — the action class has to. Without this, every restart on a busy path
 * escalates to an approval prompt, and the runtime loses the ability to repair
 * itself unattended, which is most of why it exists.
 */
const TRANSIENT: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'read',
  'restart',
  'rollback',
  'cache_clear',
  'flag_toggle',
]);

export interface RiskReason {
  readonly code:
    | 'action_class'
    | 'policy_requires_approval'
    | 'irreversible_node'
    | 'live_blast_radius'
    | 'magnitude'
    | 'limit_violation';
  readonly detail: string;
  readonly nodes?: readonly NodeId[];
  readonly escalatesTo: RiskTier | 'blocked';
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  /** True when the runtime must stop and obtain explicit authorization. */
  readonly requiresApproval: boolean;
  /**
   * True when the intent crosses its own declared limits. This is a refusal,
   * not an approval prompt — the change asked not to be allowed to do this.
   */
  readonly blocked: boolean;
  readonly reasons: readonly RiskReason[];
}

/**
 * Thresholds at which impact magnitude alone escalates risk, independent of
 * what the change is doing. A code change touching two adjacent components is
 * routine; the same change fanning out across a third of the graph is not,
 * even though the action class never changed.
 */
const MAGNITUDE_ELEVATED = 0.4;
const MAGNITUDE_HIGH = 0.8;

/**
 * Confidence below which a governing policy is reported but does not force an
 * approval. Matches the impact engine's limit floor for the same reason: a
 * rule that fires on every change is a rule nobody reads.
 */
const POLICY_RELEVANCE_FLOOR = 0.25;

/**
 * A policy may declare `appliesToActions`. Absent, it governs everything —
 * silence is the conservative reading for a safety rule.
 */
function policyGovernsAnyAction(declared: unknown, actions: readonly ActionClass[]): boolean {
  if (!Array.isArray(declared)) return true;
  return actions.some((a) => declared.includes(a));
}

/**
 * Decide whether an agent may proceed unattended, must ask, or is refused.
 *
 * This is the governance lock the specification names but never defines. It is
 * deliberately not a single node-count threshold: a count cannot distinguish a
 * migration on a live customer database from a copy edit that happens to fan
 * out across many screens.
 */
export function classifyRisk(intent: Intent, impact: ImpactResult): RiskAssessment {
  const reasons: RiskReason[] = [];

  for (const action of intent.actions) {
    const baseline = ACTION_BASELINE[action];
    if (baseline !== 'low') {
      reasons.push({
        code: 'action_class',
        detail: `action '${action}' is classified ${baseline} risk`,
        escalatesTo: baseline,
      });
    }
  }

  // A policy node in the constraint set can demand approval on its own
  // authority. This is how a data-retention rule or a financial limit binds a
  // change that would otherwise look routine.
  //
  // Two filters keep that from becoming noise. A policy binds only when it
  // governs one of the actions actually being performed (a retention rule has
  // no opinion about a worker restart), and only when the node it governs is
  // implicated with real confidence rather than reachable in principle.
  const approvalPolicies = impact.constraints.filter(
    (c) =>
      c.node.attributes['requiresApproval'] === true &&
      c.score >= POLICY_RELEVANCE_FLOOR &&
      policyGovernsAnyAction(c.node.attributes['appliesToActions'], intent.actions),
  );
  if (approvalPolicies.length > 0) {
    reasons.push({
      code: 'policy_requires_approval',
      detail:
        approvalPolicies.length === 1
          ? `governing policy '${approvalPolicies[0]!.node.name}' requires explicit approval`
          : `${approvalPolicies.length} governing policies require explicit approval`,
      nodes: approvalPolicies.map((p) => p.id),
      escalatesTo: 'high',
    });
  }

  // Graph reach measures how far a *change* propagates. A wholly transient
  // action changes nothing — it interrupts and then recovers — so its reach is
  // not a risk signal, however central the node it touches. Skipping these
  // three reasons is what preserves the runtime's ability to repair itself
  // unattended; a policy can still override by naming the action class in its
  // own `appliesToActions`, and declared intent limits still bind.
  const allTransient = intent.actions.every((a) => TRANSIENT.has(a));
  if (!allTransient) {
    const destructive = intent.actions.some((a) => DESTRUCTIVE.has(a));
    if (impact.irreversible.length > 0) {
      reasons.push({
        code: 'irreversible_node',
        detail: destructive
          ? `destructive action implicates ${impact.irreversible.length} irreversible node(s)`
          : `implicates ${impact.irreversible.length} irreversible node(s)`,
        nodes: impact.irreversible.map((n) => n.id),
        escalatesTo: destructive ? 'high' : 'elevated',
      });
    }

    const liveBlast = impact.blastRadius.filter((n) => n.node.live);
    if (liveBlast.length > 0) {
      reasons.push({
        code: 'live_blast_radius',
        detail: `${liveBlast.length} live node(s) are in the blast radius`,
        nodes: liveBlast.map((n) => n.id),
        escalatesTo: liveBlast.length >= 3 ? 'high' : 'elevated',
      });
    }

    if (impact.magnitude >= MAGNITUDE_HIGH) {
      reasons.push({
        code: 'magnitude',
        detail: `impact magnitude ${impact.magnitude} at or above ${MAGNITUDE_HIGH}`,
        escalatesTo: 'high',
      });
    } else if (impact.magnitude >= MAGNITUDE_ELEVATED) {
      reasons.push({
        code: 'magnitude',
        detail: `impact magnitude ${impact.magnitude} at or above ${MAGNITUDE_ELEVATED}`,
        escalatesTo: 'elevated',
      });
    }
  }

  for (const violation of impact.violations) {
    reasons.push({
      code: 'limit_violation',
      detail: violation.detail,
      nodes: violation.nodes,
      escalatesTo: 'blocked',
    });
  }

  const blocked = reasons.some((r) => r.escalatesTo === 'blocked');
  const tier = highestTier(reasons);

  return {
    tier,
    requiresApproval: blocked || tier === 'high',
    blocked,
    reasons,
  };
}

function highestTier(reasons: readonly RiskReason[]): RiskTier {
  let tier: RiskTier = 'low';
  for (const reason of reasons) {
    if (reason.escalatesTo === 'blocked' || reason.escalatesTo === 'high') return 'high';
    if (reason.escalatesTo === 'elevated') tier = 'elevated';
  }
  return tier;
}

export function baselineRiskOf(action: ActionClass): RiskTier {
  return ACTION_BASELINE[action];
}
