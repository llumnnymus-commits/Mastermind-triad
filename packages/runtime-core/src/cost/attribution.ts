import type { ProjectGraph } from '../graph/graph.js';
import type { NodeId } from '../graph/nodes.js';

/**
 * What an operation actually spent.
 *
 * Recorded per invocation and tagged with the graph node that caused it, which
 * is the entire point. An invoice says the model spend tripled. This says
 * which feature tripled it, and — through the graph — which of its retrievals,
 * retries, or tool loops did the tripling.
 */
export interface CostEvent {
  /** The graph node this spend is attributed to. */
  readonly nodeId: NodeId;
  readonly category: CostCategory;
  readonly usd: number;
  readonly at: string;
  /** Optional detail: token counts, retry depth, tool-loop iterations. */
  readonly detail?: Record<string, number>;
}

export const COST_CATEGORIES = [
  'model_inference',
  'retrieval',
  'tool_call',
  'browser_automation',
  'compute',
  'storage',
  'bandwidth',
  'external_api',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface NodeCost {
  readonly nodeId: NodeId;
  readonly name: string;
  /** Spend attributed directly to this node. */
  readonly directUsd: number;
  /**
   * Direct spend plus everything this node causes downstream.
   *
   * A screen that costs nothing to render but triggers an agent loop behind it
   * is not a cheap screen, and a per-node ledger that only counts direct spend
   * will keep insisting it is.
   */
  readonly rolledUpUsd: number;
  /** Direct spend broken down by category. */
  readonly byCategory: Readonly<Record<string, number>>;
  /**
   * Rolled-up spend by category — what the node costs including everything it
   * causes. This, not the direct breakdown, is what names the lever: a screen
   * spending a dollar on compute while triggering sixty on inference has an
   * inference problem, and a recommendation built from its direct spend would
   * send someone to resize a container.
   */
  readonly rolledUpByCategory: Readonly<Record<string, number>>;
  readonly eventCount: number;
}

export interface CostReport {
  readonly totalUsd: number;
  readonly perNode: readonly NodeCost[];
  /**
   * Where to actually look, worst first.
   *
   * Ranked by rolled-up cost but excluding pure conduits — nodes with no
   * direct spend of their own. Ranking on roll-up alone just surfaces whatever
   * sits furthest upstream: a UI module that spends nothing inherits the cost
   * of everything beneath it and tops the list, which answers "what is the
   * root of this subgraph" when the question was "where is the money going".
   */
  readonly hotspots: readonly NodeCost[];
  readonly byCategory: Readonly<Record<string, number>>;
}

/**
 * Roll cost events up through the graph.
 *
 * Attribution follows outbound structural edges: if a screen calls a service
 * that spends on inference, that spend belongs to the screen too, because the
 * screen is why it happened. Costs are not divided among callers — each caller
 * carries the full downstream cost it triggers, since the question being asked
 * is "what would we save by changing this", not "how do we split the bill".
 */
export function attributeCosts(
  graph: ProjectGraph,
  events: readonly CostEvent[],
  options: { maxDepth?: number } = {},
): CostReport {
  const maxDepth = options.maxDepth ?? 6;

  const direct = new Map<NodeId, number>();
  const byNodeCategory = new Map<NodeId, Map<string, number>>();
  const counts = new Map<NodeId, number>();
  const byCategory = new Map<string, number>();
  let totalUsd = 0;

  for (const event of events) {
    if (!graph.has(event.nodeId)) continue;
    direct.set(event.nodeId, (direct.get(event.nodeId) ?? 0) + event.usd);
    counts.set(event.nodeId, (counts.get(event.nodeId) ?? 0) + 1);
    byCategory.set(event.category, (byCategory.get(event.category) ?? 0) + event.usd);
    const perCat = byNodeCategory.get(event.nodeId) ?? new Map<string, number>();
    perCat.set(event.category, (perCat.get(event.category) ?? 0) + event.usd);
    byNodeCategory.set(event.nodeId, perCat);
    totalUsd += event.usd;
  }

  const perNode: NodeCost[] = [];
  for (const node of graph.nodes()) {
    const directUsd = direct.get(node.id) ?? 0;
    const rolled = rollUp(graph, node.id, direct, byNodeCategory, maxDepth);
    if (directUsd === 0 && rolled.total === 0) continue;
    perNode.push({
      nodeId: node.id,
      name: node.name,
      directUsd: round(directUsd),
      rolledUpUsd: round(rolled.total),
      byCategory: Object.fromEntries(byNodeCategory.get(node.id) ?? []),
      rolledUpByCategory: Object.fromEntries(
        [...rolled.byCategory].map(([k, v]) => [k, round(v)]),
      ),
      eventCount: counts.get(node.id) ?? 0,
    });
  }

  perNode.sort((a, b) => b.rolledUpUsd - a.rolledUpUsd || a.nodeId.localeCompare(b.nodeId));

  return {
    totalUsd: round(totalUsd),
    perNode,
    hotspots: perNode.filter((n) => n.directUsd > 0).slice(0, 5),
    byCategory: Object.fromEntries([...byCategory].map(([k, v]) => [k, round(v)])),
  };
}

/** Spend at this node plus everything reachable through outbound structural edges. */
function rollUp(
  graph: ProjectGraph,
  start: NodeId,
  direct: Map<NodeId, number>,
  byNodeCategory: Map<NodeId, Map<string, number>>,
  maxDepth: number,
): { total: number; byCategory: Map<string, number> } {
  const seen = new Set<NodeId>([start]);
  const byCategory = new Map<string, number>();
  let total = 0;
  let frontier: NodeId[] = [start];

  const absorb = (id: NodeId): void => {
    total += direct.get(id) ?? 0;
    for (const [category, usd] of byNodeCategory.get(id) ?? []) {
      byCategory.set(category, (byCategory.get(category) ?? 0) + usd);
    }
  };
  absorb(start);

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      for (const { edge, other } of graph.outbound(id)) {
        if (edge.type === 'governed_by' || edge.type === 'verified_by') continue;
        if (seen.has(other)) continue;
        seen.add(other);
        absorb(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  return { total, byCategory };
}

/**
 * Whether a feature earns what it costs.
 *
 * The specification's case: an AI feature can look successful on engagement
 * while losing money at scale, because one conversation fans out into many
 * model calls, large contexts, repeated retrieval, and retries. Engagement
 * alone cannot distinguish that from a feature worth its spend, so the verdict
 * needs the value side stated explicitly.
 */
export interface ValueSignal {
  readonly nodeId: NodeId;
  /** Revenue or measurable value attributable to this node per day, in USD. */
  readonly dailyValueUsd: number;
  /** Optional non-monetary outcomes that justify spend on their own. */
  readonly taskCompletionRate?: number;
  readonly retentionEffect?: number;
}

export type SustainabilityVerdict = 'sustainable' | 'marginal' | 'unsustainable' | 'unknown';

export interface SustainabilityAssessment {
  readonly nodeId: NodeId;
  readonly verdict: SustainabilityVerdict;
  readonly dailyCostUsd: number;
  readonly dailyValueUsd: number;
  readonly ratio: number;
  readonly recommendation: string;
}

export function assessSustainability(
  cost: NodeCost,
  value: ValueSignal | undefined,
  dayCount = 1,
): SustainabilityAssessment {
  const dailyCostUsd = round(cost.rolledUpUsd / Math.max(dayCount, 1));

  if (value === undefined) {
    return {
      nodeId: cost.nodeId,
      verdict: 'unknown',
      dailyCostUsd,
      dailyValueUsd: 0,
      ratio: 0,
      recommendation:
        'no value signal is attributed to this node — cost is measurable and benefit is not, which is not the same as the benefit being zero',
    };
  }

  const ratio =
    value.dailyValueUsd === 0 || dailyCostUsd === 0
      ? 0
      : Math.round((value.dailyValueUsd / dailyCostUsd) * 100) / 100;
  const verdict: SustainabilityVerdict =
    ratio >= 3 ? 'sustainable' : ratio >= 1 ? 'marginal' : 'unsustainable';

  return {
    nodeId: cost.nodeId,
    verdict,
    dailyCostUsd,
    dailyValueUsd: round(value.dailyValueUsd),
    ratio,
    recommendation: recommend(verdict, cost),
  };
}

/**
 * What to do about it.
 *
 * Deliberately specific rather than "reduce cost": the graph knows the shape of
 * the spend, so the recommendation names the mechanism. An arbitrary cost cut
 * applied to a feature that is expensive for a good reason is how a working
 * product gets degraded to hit a number.
 */
function recommend(verdict: SustainabilityVerdict, cost: NodeCost): string {
  if (verdict === 'sustainable') return 'earns its operating cost; no action needed';

  const categories = Object.entries(cost.rolledUpByCategory).sort((a, b) => b[1] - a[1]);
  const dominant = categories[0]?.[0];

  const lever: Record<string, string> = {
    model_inference:
      'inference dominates — check for an oversized model, unbounded context, or retries before assuming the feature is the problem',
    retrieval: 'retrieval dominates — check for duplicate queries and missing caching',
    tool_call: 'tool calls dominate — check for an agent loop that is not terminating early',
    browser_automation:
      'browser automation dominates — check for redundant page loads and missing session reuse',
    compute: 'compute dominates — check for an overly broad deployment configuration',
  };

  const detail = dominant !== undefined ? ` ${lever[dominant] ?? `${dominant} dominates the spend`}` : '';
  return verdict === 'marginal'
    ? `covers its cost but with little margin;${detail}`
    : `costs more than it returns; consider a lighter model, usage limits, tiered access, or a different implementation.${detail}`;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
