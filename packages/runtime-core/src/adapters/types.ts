import type { GraphEdge, GraphNode } from '../graph/nodes.js';

/**
 * A domain adapter populates part of the graph from a real system.
 *
 * The graph is only as good as what fills it, and nothing fills itself. An
 * adapter is whatever knows how to read one domain of a real project — a
 * source tree, a Kubernetes cluster, a policy repository, a monitoring
 * backend — and emit nodes and edges for it.
 *
 * Adapters are additive and expected to overlap: the source adapter knows a
 * module imports another, the deployment adapter knows which container runs
 * it, and neither needs to know about the other. `ProjectGraph.addNode`
 * replaces by id, so two adapters describing the same node converge rather
 * than conflict, and edges accumulate.
 */
export interface DomainAdapter {
  /** Stable identifier, recorded on ingested nodes so their origin is traceable. */
  readonly name: string;
  ingest(source: string, options?: Record<string, unknown>): Promise<IngestResult>;
}

export interface IngestResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Things the adapter could not resolve — visible rather than silently dropped. */
  readonly unresolved: readonly UnresolvedReference[];
}

export interface UnresolvedReference {
  readonly from: string;
  readonly reference: string;
  readonly reason: string;
}
