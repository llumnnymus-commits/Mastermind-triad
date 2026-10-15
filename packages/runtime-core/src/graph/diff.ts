import type { ProjectGraph } from './graph.js';
import type { GraphEdge, GraphNode, NodeId } from './nodes.js';
import type { EdgeType } from './edges.js';

export interface EdgeKey {
  readonly from: NodeId;
  readonly type: EdgeType;
  readonly to: NodeId;
}

export interface GraphDiff {
  readonly addedNodes: readonly GraphNode[];
  readonly removedNodes: readonly GraphNode[];
  readonly changedNodes: readonly NodeChange[];
  readonly addedEdges: readonly GraphEdge[];
  readonly removedEdges: readonly GraphEdge[];
}

export interface NodeChange {
  readonly id: NodeId;
  readonly before: GraphNode;
  readonly after: GraphNode;
  readonly fields: readonly string[];
}

/**
 * Structural diff between a baseline graph and the graph after a change.
 *
 * Behavioral validation needs this rather than a source diff. "Did this change
 * introduce a new path to the payment service" and "did the blast radius grow"
 * are questions about the graph's shape; a textual diff of the files that
 * produced it cannot answer either, because the edge that matters may be three
 * generated modules away from any line that visibly moved.
 */
export function diffGraphs(before: ProjectGraph, after: ProjectGraph): GraphDiff {
  const beforeNodes = new Map([...before.nodes()].map((n) => [n.id, n]));
  const afterNodes = new Map([...after.nodes()].map((n) => [n.id, n]));

  const addedNodes = [...afterNodes.values()].filter((n) => !beforeNodes.has(n.id));
  const removedNodes = [...beforeNodes.values()].filter((n) => !afterNodes.has(n.id));

  const changedNodes: NodeChange[] = [];
  for (const [id, afterNode] of afterNodes) {
    const beforeNode = beforeNodes.get(id);
    if (beforeNode === undefined) continue;
    const fields = changedFields(beforeNode, afterNode);
    if (fields.length > 0) changedNodes.push({ id, before: beforeNode, after: afterNode, fields });
  }

  const beforeEdges = new Set(before.edges().map(edgeKey));
  const afterEdges = new Set(after.edges().map(edgeKey));
  const addedEdges = after.edges().filter((e) => !beforeEdges.has(edgeKey(e)));
  const removedEdges = before.edges().filter((e) => !afterEdges.has(edgeKey(e)));

  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges };
}

export function edgeKey(edge: GraphEdge | EdgeKey): string {
  return `${edge.from}|${edge.type}|${edge.to}`;
}

function changedFields(before: GraphNode, after: GraphNode): string[] {
  const fields: string[] = [];
  if (before.name !== after.name) fields.push('name');
  if (before.kind !== after.kind) fields.push('kind');
  if (before.live !== after.live) fields.push('live');
  if (before.irreversible !== after.irreversible) fields.push('irreversible');
  if (JSON.stringify(before.attributes) !== JSON.stringify(after.attributes)) {
    fields.push('attributes');
  }
  return fields;
}
