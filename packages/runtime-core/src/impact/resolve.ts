import type { ProjectGraph } from '../graph/graph.js';
import type { GraphNode, NodeId } from '../graph/nodes.js';
import { domainOf } from '../graph/nodes.js';
import { EDGE_TYPES, type EdgeType } from '../graph/edges.js';
import type { Intent } from '../intent/intent.js';

/** How a node came to be part of the implicated set. */
export type Relation =
  /** Named directly by the intent. */
  | 'target'
  /** Depends on something being changed — this is what breaks. */
  | 'blast'
  /** Something being changed depends on it — context the change must respect. */
  | 'context'
  /** A policy governing an implicated node. */
  | 'constraint'
  /** A test or evaluation attached to an implicated node. */
  | 'verification'
  /** Telemetry, cost, or attribution attached for the record. */
  | 'metadata';

export interface ImpactedNode {
  readonly id: NodeId;
  readonly node: GraphNode;
  readonly relation: Relation;
  /** 0–1. Confidence that this node is genuinely affected. */
  readonly score: number;
  /** Edge hops from the nearest intent target. */
  readonly depth: number;
  /** The chain of edges that implicated it, for the approval request. */
  readonly path: readonly PathStep[];
}

export interface PathStep {
  readonly from: NodeId;
  readonly type: EdgeType;
  readonly to: NodeId;
  /** Which way the edge was walked to reach the node. */
  readonly direction: 'inbound' | 'outbound';
}

export interface LimitViolation {
  readonly limit:
    | 'forbiddenNodes'
    | 'maxImplicatedNodes'
    | 'forbidIrreversible'
    | 'maxAddedDailyCostUsd';
  readonly detail: string;
  readonly nodes: readonly NodeId[];
}

export interface ImpactResult {
  readonly intentId: string;
  readonly targets: readonly NodeId[];
  /** Every implicated node, highest score first. */
  readonly implicated: readonly ImpactedNode[];
  /** Nodes that may break — the blast radius proper. */
  readonly blastRadius: readonly ImpactedNode[];
  /** Policies binding this change. Never decayed by distance. */
  readonly constraints: readonly ImpactedNode[];
  /** Tests and evals that must run for this change. */
  readonly verifications: readonly ImpactedNode[];
  /** Implicated nodes that cannot be restored after destructive change. */
  readonly irreversible: readonly ImpactedNode[];
  /** Implicated nodes currently live in production. */
  readonly live: readonly ImpactedNode[];
  /** Structural (target/blast/context) node count — the "how big is this" number. */
  readonly structuralCount: number;
  /**
   * Aggregate 0–1 magnitude: the summed structural confidence, saturating.
   * Feeds the risk gate alongside action class and policy requirements.
   */
  readonly magnitude: number;
  /** Hard limits from the intent that this change would cross. */
  readonly violations: readonly LimitViolation[];
  readonly domainsTouched: readonly string[];
}

export interface ResolveOptions {
  /** Scores below this stop the walk. Default 0.05. */
  readonly epsilon?: number;
  /** Maximum edge hops from a target. Default 6. */
  readonly maxDepth?: number;
  /**
   * Confidence below which a node is reported but does not count against the
   * intent's categorical limits. Default 0.25.
   *
   * Without a floor, `forbidIrreversible` fires on anything with a production
   * database anywhere in its transitive neighborhood — which on a real graph
   * is every change — and a limit that always fires carries no information.
   * Explicitly named `forbiddenNodes` ignore this floor: naming a node is a
   * statement that any implication of it matters.
   */
  readonly limitConfidenceFloor?: number;
}

interface Entry {
  id: NodeId;
  relation: Relation;
  score: number;
  depth: number;
  path: PathStep[];
}

/** Binary max-heap keyed on score — the walk must settle each node on its strongest path. */
class MaxHeap {
  #items: Entry[] = [];

  push(item: Entry): void {
    this.#items.push(item);
    let i = this.#items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#items[parent]!.score >= this.#items[i]!.score) break;
      [this.#items[parent], this.#items[i]] = [this.#items[i]!, this.#items[parent]!];
      i = parent;
    }
  }

  pop(): Entry | undefined {
    if (this.#items.length === 0) return undefined;
    const top = this.#items[0]!;
    const last = this.#items.pop()!;
    if (this.#items.length > 0) {
      this.#items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < this.#items.length && this.#items[l]!.score > this.#items[best]!.score) best = l;
        if (r < this.#items.length && this.#items[r]!.score > this.#items[best]!.score) best = r;
        if (best === i) break;
        [this.#items[best], this.#items[i]] = [this.#items[i]!, this.#items[best]!];
        i = best;
      }
    }
    return top;
  }

  get size(): number {
    return this.#items.length;
  }
}

/**
 * Resolve an intent against the graph into the set of nodes it implicates.
 *
 * The walk is a max-product relaxation: a node's score is the strongest path
 * that reaches it, not the first path found. That matters because a node
 * reachable both through a weak `navigates_to` chain and a direct `depends_on`
 * edge is genuinely at the higher risk, and settling it on whichever path the
 * queue happened to reach first would understate the blast radius.
 *
 * Structural edges propagate onward and decay. Constraint (`governed_by`) and
 * verification (`verified_by`) edges attach at full weight to every implicated
 * node but do not propagate further — a policy binds the change, but the other
 * things that policy governs are not themselves affected by it.
 */
export function resolveImpact(
  graph: ProjectGraph,
  intent: Intent,
  options: ResolveOptions = {},
): ImpactResult {
  const epsilon = options.epsilon ?? 0.05;
  const maxDepth = options.maxDepth ?? 6;

  const settled = new Map<NodeId, Entry>();
  const heap = new MaxHeap();

  for (const target of intent.targets) {
    if (!graph.has(target)) {
      throw new Error(`intent ${intent.id} targets unknown node: ${target}`);
    }
    heap.push({ id: target, relation: 'target', score: 1, depth: 0, path: [] });
  }

  while (heap.size > 0) {
    const current = heap.pop()!;
    const existing = settled.get(current.id);
    if (existing !== undefined && existing.score >= current.score) continue;
    settled.set(current.id, current);

    // Constraints and verifications attach to implicated nodes and are
    // terminal — they bind the change, they do not spread it.
    //
    // The two are deliberately asymmetric:
    //
    //   - A CONSTRAINT inherits the score of the node it governs. The
    //     `governed_by` hop itself costs nothing (policy is not diluted by
    //     being one edge away), but a policy attached to a node that is barely
    //     implicated is barely relevant. Attaching every reachable policy at
    //     full weight makes a data-retention rule bind a worker restart, which
    //     is how a governance gate becomes noise everyone learns to click past.
    //
    //   - A VERIFICATION attaches at full weight regardless. The asymmetry is
    //     intentional: running a test that turns out to be unnecessary costs
    //     seconds, and skipping one that was necessary costs an outage.
    if (current.relation !== 'constraint' && current.relation !== 'verification') {
      for (const type of ['governed_by', 'verified_by'] as const) {
        const relation: Relation = type === 'governed_by' ? 'constraint' : 'verification';
        const score = relation === 'constraint' ? current.score : 1;
        for (const attached of graph.neighborsByType(current.id, type)) {
          const prior = settled.get(attached);
          if (prior !== undefined && prior.score >= score) continue;
          heap.push({
            id: attached,
            relation,
            score,
            depth: current.depth + 1,
            path: [
              ...current.path,
              { from: current.id, type, to: attached, direction: 'outbound' },
            ],
          });
        }
      }
    }

    if (current.depth >= maxDepth) continue;
    // Constraints and verifications are terminal — do not walk onward from them.
    if (current.relation === 'constraint' || current.relation === 'verification') continue;

    // BLAST: walk inbound. These nodes depend on what is changing; they break.
    for (const { edge, other } of graph.inbound(current.id)) {
      const semantics = EDGE_TYPES[edge.type];
      if (semantics.role !== 'structural' && semantics.role !== 'metadata') continue;
      const score = current.score * semantics.blast;
      if (score < epsilon) continue;
      const relation: Relation = semantics.role === 'metadata' ? 'metadata' : 'blast';
      heap.push({
        id: other,
        relation,
        score,
        depth: current.depth + 1,
        path: [
          ...current.path,
          { from: other, type: edge.type, to: current.id, direction: 'inbound' },
        ],
      });
    }

    // CONTEXT: walk outbound. What this node relies on; it must be respected,
    // but changing a dependent rarely breaks its dependency.
    for (const { edge, other } of graph.outbound(current.id)) {
      const semantics = EDGE_TYPES[edge.type];
      if (semantics.role !== 'structural' && semantics.role !== 'metadata') continue;
      const score = current.score * semantics.context;
      if (score < epsilon) continue;
      const relation: Relation = semantics.role === 'metadata' ? 'metadata' : 'context';
      heap.push({
        id: other,
        relation,
        score,
        depth: current.depth + 1,
        path: [
          ...current.path,
          { from: current.id, type: edge.type, to: other, direction: 'outbound' },
        ],
      });
    }
  }

  // Targets stay targets even if reached again by another path.
  for (const target of intent.targets) {
    const entry = settled.get(target);
    if (entry !== undefined) settled.set(target, { ...entry, relation: 'target', score: 1, depth: 0 });
  }

  const implicated: ImpactedNode[] = [...settled.values()]
    .map((entry) => ({
      id: entry.id,
      node: graph.requireNode(entry.id),
      relation: entry.relation,
      score: round(entry.score),
      depth: entry.depth,
      path: entry.path,
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const structural = implicated.filter(
    (n) => n.relation === 'target' || n.relation === 'blast' || n.relation === 'context',
  );
  const blastRadius = implicated.filter((n) => n.relation === 'blast');
  const constraints = implicated.filter((n) => n.relation === 'constraint');
  const verifications = implicated.filter((n) => n.relation === 'verification');
  const irreversible = structural.filter((n) => n.node.irreversible);
  const live = structural.filter((n) => n.node.live);

  const violations = checkLimits(
    intent,
    structural,
    irreversible,
    options.limitConfidenceFloor ?? 0.25,
  );
  const domainsTouched = [...new Set(implicated.map((n) => domainOf(n.id)))].sort();

  return {
    intentId: intent.id,
    targets: intent.targets,
    implicated,
    blastRadius,
    constraints,
    verifications,
    irreversible,
    live,
    structuralCount: structural.length,
    magnitude: magnitudeOf(structural),
    violations,
    domainsTouched,
  };
}

/**
 * Saturating aggregate of structural confidence.
 *
 * A plain node count treats a certainly-broken database and a marginally
 * related screen as equal, and a plain sum grows without bound on large
 * graphs. Summing confidence and saturating keeps the number comparable
 * across projects of different sizes: ~4 fully-implicated nodes reaches 0.63,
 * ~10 reaches 0.92.
 */
function magnitudeOf(structural: readonly ImpactedNode[]): number {
  const weighted = structural
    .filter((n) => n.relation !== 'target')
    .reduce((sum, n) => sum + n.score, 0);
  return round(1 - Math.exp(-weighted / 4));
}

function checkLimits(
  intent: Intent,
  structural: readonly ImpactedNode[],
  irreversible: readonly ImpactedNode[],
  floor: number,
): LimitViolation[] {
  const violations: LimitViolation[] = [];

  // Explicitly named nodes ignore the floor — naming one is a statement that
  // any implication of it, however faint, is disqualifying.
  const structuralIds = new Set(structural.map((n) => n.id));
  const forbidden = intent.limits.forbiddenNodes.filter((id) => structuralIds.has(id));
  if (forbidden.length > 0) {
    violations.push({
      limit: 'forbiddenNodes',
      detail: `change implicates ${forbidden.length} node(s) the intent forbids touching`,
      nodes: forbidden,
    });
  }

  const meaningful = structural.filter((n) => n.score >= floor);

  const max = intent.limits.maxImplicatedNodes;
  if (max !== undefined && meaningful.length > max) {
    violations.push({
      limit: 'maxImplicatedNodes',
      detail: `implicates ${meaningful.length} structural nodes above confidence ${floor}, limit is ${max}`,
      nodes: meaningful.map((n) => n.id),
    });
  }

  const meaningfulIrreversible = irreversible.filter((n) => n.score >= floor);
  if (intent.limits.forbidIrreversible && meaningfulIrreversible.length > 0) {
    violations.push({
      limit: 'forbidIrreversible',
      detail: `implicates ${meaningfulIrreversible.length} irreversible node(s)`,
      nodes: meaningfulIrreversible.map((n) => n.id),
    });
  }

  return violations;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
