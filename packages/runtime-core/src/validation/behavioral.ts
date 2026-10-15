import type { ProjectGraph } from '../graph/graph.js';
import type { NodeId } from '../graph/nodes.js';
import { diffGraphs, type GraphDiff } from '../graph/diff.js';
import type { Intent } from '../intent/intent.js';
import type { ImpactResult } from '../impact/resolve.js';
import { summarize, type CheckResult, type ValidationReport } from './types.js';

/**
 * Judges whether the change accomplished what the intent asked for.
 *
 * Behind an interface because the honest implementations differ per project —
 * a scripted assertion, a model-graded rubric, a human spot check — and the
 * runtime's handling of the verdict should not change with the method. An
 * `unclear` verdict is a first-class outcome: a judge that cannot tell must
 * not be able to launder its uncertainty into a pass.
 */
export interface BehavioralEvaluator {
  evaluateSuccessCondition(
    intent: Intent,
    context: EvaluationContext,
  ): Promise<{ verdict: 'met' | 'not_met' | 'unclear'; reasoning: string }>;
}

export interface EvaluationContext {
  readonly diff: GraphDiff;
  readonly impact: ImpactResult;
}

export interface BehavioralInput {
  /** The graph as analyzed, before the change was applied. */
  readonly before: ProjectGraph;
  /** The graph as it stands inside the mirror, after the change. */
  readonly after: ProjectGraph;
  readonly intent: Intent;
  readonly impact: ImpactResult;
  /** Projected additional operating cost per day, if the cost model produced one. */
  readonly projectedAddedDailyCostUsd?: number;
  readonly evaluator?: BehavioralEvaluator;
}

/**
 * Run behavioral validation.
 *
 * Mechanical validation answers "did anything break". This answers the
 * questions that matter for letting an agent operate unattended: did the
 * change stay inside the scope that was analyzed and approved, did it quietly
 * widen what the system can reach or expose, does it still respect the limits
 * the intent declared, and did it actually accomplish what was asked.
 *
 * Most of these are answered by diffing the graph rather than by asking a
 * model, which matters: a judge can be wrong about whether a permission was
 * added, but the edge is either in the graph or it is not.
 */
export async function runBehavioralValidation(input: BehavioralInput): Promise<ValidationReport> {
  const { before, after, intent, impact } = input;
  const diff = diffGraphs(before, after);
  const checks: CheckResult[] = [
    checkScopeAdherence(diff, impact, intent),
    checkPermissionDrift(diff),
    checkIrreversibleExposure(diff, after),
    checkForbiddenNodes(diff, intent),
    checkCostLimit(intent, input.projectedAddedDailyCostUsd),
  ];

  checks.push(await checkSuccessCondition(intent, { diff, impact }, input.evaluator));

  return summarize(intent.id, 'behavioral', checks);
}

/**
 * Did the change stay inside the slice that was analyzed?
 *
 * This is the enforceable form of "scoped mutation as law". The impact walk
 * predicted a set of nodes before anything was written; the diff shows what
 * actually moved. Anything that moved outside the predicted set is a scope
 * escape — either the change did more than it claimed, or the graph was wrong
 * about the system's shape. Both need a human, and both are invisible to a
 * test suite, which only knows whether the code it covers still works.
 *
 * Note that this works regardless of how the change was produced. An agent
 * editing source freehand cannot be *prevented* from touching an unpredicted
 * node, but it cannot hide having done so either.
 */
function checkScopeAdherence(
  diff: GraphDiff,
  impact: ImpactResult,
  intent: Intent,
): CheckResult {
  const analyzed = new Set<NodeId>(impact.implicated.map((n) => n.id));
  const touched = new Set<NodeId>([
    ...diff.changedNodes.map((c) => c.id),
    ...diff.addedNodes.map((n) => n.id),
    ...diff.removedNodes.map((n) => n.id),
  ]);
  // A newly created node cannot have been in the analyzed set; it is in scope
  // if everything it attaches to was.
  const newIds = new Set(diff.addedNodes.map((n) => n.id));
  const escaped = [...touched].filter((id) => !analyzed.has(id) && !newIds.has(id));

  const orphanEdges = diff.addedEdges.filter(
    (e) => !analyzed.has(e.from) && !newIds.has(e.from) && !analyzed.has(e.to) && !newIds.has(e.to),
  );

  if (escaped.length === 0 && orphanEdges.length === 0) {
    return {
      name: 'scope adherence',
      status: 'pass',
      detail: `all ${touched.size} touched node(s) were inside the analyzed impact set`,
    };
  }

  return {
    name: 'scope adherence',
    status: 'fail',
    detail:
      escaped.length > 0
        ? `${escaped.length} node(s) changed outside the impact set analyzed for intent ${intent.id}`
        : `${orphanEdges.length} edge(s) added between nodes outside the analyzed set`,
    nodes: escaped,
  };
}

/** Did the change widen what the system is permitted to reach or read? */
function checkPermissionDrift(diff: GraphDiff): CheckResult {
  const sensitiveKinds = new Set(['network_permission', 'secret', 'env_var']);
  const addedSensitive = diff.addedNodes.filter((n) => sensitiveKinds.has(n.kind));
  const addedSensitiveEdges = diff.addedEdges.filter(
    (e) => e.to.startsWith('infra:network_permission') || e.to.startsWith('infra:secret'),
  );

  if (addedSensitive.length === 0 && addedSensitiveEdges.length === 0) {
    return { name: 'permission drift', status: 'pass', detail: 'no new permissions or secrets' };
  }
  return {
    name: 'permission drift',
    status: 'fail',
    detail: `change introduces ${addedSensitive.length} permission/secret node(s) and ${addedSensitiveEdges.length} new binding(s) to them`,
    nodes: [...addedSensitive.map((n) => n.id), ...addedSensitiveEdges.map((e) => e.to)],
  };
}

/** Did the change create a new write path into state that cannot be restored? */
function checkIrreversibleExposure(diff: GraphDiff, after: ProjectGraph): CheckResult {
  const newWrites = diff.addedEdges.filter((e) => {
    if (e.type !== 'writes' && e.type !== 'depends_on') return false;
    return after.node(e.to)?.irreversible === true;
  });

  if (newWrites.length === 0) {
    return {
      name: 'irreversible exposure',
      status: 'pass',
      detail: 'no new paths into irreversible state',
    };
  }
  return {
    name: 'irreversible exposure',
    status: 'fail',
    detail: `change opens ${newWrites.length} new path(s) into irreversible state`,
    nodes: newWrites.map((e) => e.to),
  };
}

function checkForbiddenNodes(diff: GraphDiff, intent: Intent): CheckResult {
  const forbidden = new Set(intent.limits.forbiddenNodes);
  if (forbidden.size === 0) {
    return { name: 'forbidden nodes', status: 'skipped', detail: 'intent declared none' };
  }
  const touched = [
    ...diff.changedNodes.map((c) => c.id),
    ...diff.addedNodes.map((n) => n.id),
    ...diff.removedNodes.map((n) => n.id),
  ].filter((id) => forbidden.has(id));

  return touched.length === 0
    ? { name: 'forbidden nodes', status: 'pass', detail: 'none touched' }
    : {
        name: 'forbidden nodes',
        status: 'fail',
        detail: `change touched ${touched.length} node(s) the intent forbade`,
        nodes: touched,
      };
}

/**
 * Operating cost is a validation gate, not a report read after the fact.
 *
 * An AI feature that passes every test and triples inference spend has not
 * succeeded — it has moved the failure from the test suite to the invoice.
 */
function checkCostLimit(intent: Intent, projected: number | undefined): CheckResult {
  const limit = intent.limits.maxAddedDailyCostUsd;
  if (limit === undefined) {
    return { name: 'cost limit', status: 'skipped', detail: 'intent declared no cost limit' };
  }
  if (projected === undefined) {
    return {
      name: 'cost limit',
      status: 'inconclusive',
      detail: `intent limits added cost to $${limit}/day but no projection was produced`,
    };
  }
  return projected <= limit
    ? {
        name: 'cost limit',
        status: 'pass',
        detail: `projected $${projected}/day against a $${limit}/day limit`,
      }
    : {
        name: 'cost limit',
        status: 'fail',
        detail: `projected $${projected}/day exceeds the $${limit}/day limit the intent declared`,
      };
}

async function checkSuccessCondition(
  intent: Intent,
  context: EvaluationContext,
  evaluator: BehavioralEvaluator | undefined,
): Promise<CheckResult> {
  if (evaluator === undefined) {
    return {
      name: 'success condition',
      status: 'inconclusive',
      detail: `no evaluator configured; "${intent.successCondition}" was not verified`,
    };
  }
  const { verdict, reasoning } = await evaluator.evaluateSuccessCondition(intent, context);
  const status = verdict === 'met' ? 'pass' : verdict === 'not_met' ? 'fail' : 'inconclusive';
  return { name: 'success condition', status, detail: reasoning };
}
