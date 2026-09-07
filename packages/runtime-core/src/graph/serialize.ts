import { ProjectGraph } from './graph.js';
import type { GraphEdge, GraphNode } from './nodes.js';

/**
 * On-disk form of a graph.
 *
 * Versioned from the first write. A graph that outlives one deployment will
 * outlive its own schema, and a stored format with no version field is one
 * that can only ever be migrated by guessing.
 */
export interface SerializedGraph {
  readonly version: 1;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly capturedAt: string;
}

export function serializeGraph(graph: ProjectGraph): SerializedGraph {
  return {
    version: 1,
    nodes: [...graph.nodes()],
    edges: [...graph.edges()],
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Rebuild a graph from its stored form.
 *
 * Nodes and edges are revalidated on the way in rather than trusted. Stored
 * data is input like any other — it may have been written by an older version
 * of the schema, edited by hand, or produced by an adapter that has since been
 * fixed — and an invalid graph fails more usefully at load than during a walk.
 */
export function deserializeGraph(input: unknown): ProjectGraph {
  if (typeof input !== 'object' || input === null) {
    throw new Error('serialized graph must be an object');
  }
  const candidate = input as Partial<SerializedGraph>;
  if (candidate.version !== 1) {
    throw new Error(`unsupported serialized graph version: ${String(candidate.version)}`);
  }
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    throw new Error('serialized graph must carry `nodes` and `edges` arrays');
  }
  return ProjectGraph.from(candidate.nodes, candidate.edges);
}
