import {
  GraphEdgeSchema,
  GraphNodeSchema,
  domainOf,
  type GraphEdge,
  type GraphNode,
  type NodeId,
} from './nodes.js';
import type { Domain } from './domains.js';
import type { EdgeType } from './edges.js';

/** Two edges are the same edge when they connect the same pair the same way. */
function edgeIdentity(edge: GraphEdge): string {
  return `${edge.from}|${edge.type}|${edge.to}`;
}

export interface AdjacentEdge {
  readonly edge: GraphEdge;
  /** The node on the other end of the edge from the one being queried. */
  readonly other: NodeId;
}

/**
 * The project graph.
 *
 * In-memory with maintained adjacency indices. The interface is deliberately
 * narrow — `outbound`, `inbound`, `node` — because that is the whole surface
 * impact resolution needs, and keeping it narrow is what lets the store move
 * to a persistent backend later without touching the engine.
 *
 * Every intent runs a reachability query over this, so adjacency is indexed on
 * write rather than scanned on read.
 */
export class ProjectGraph {
  readonly #nodes = new Map<NodeId, GraphNode>();
  readonly #outbound = new Map<NodeId, AdjacentEdge[]>();
  readonly #inbound = new Map<NodeId, AdjacentEdge[]>();
  readonly #edges: GraphEdge[] = [];
  readonly #edgeIndex = new Map<string, GraphEdge>();

  static from(nodes: unknown[], edges: unknown[]): ProjectGraph {
    const graph = new ProjectGraph();
    for (const node of nodes) graph.addNode(node);
    for (const edge of edges) graph.addEdge(edge);
    return graph;
  }

  /** Validates and inserts a node. Re-adding an existing id replaces it. */
  addNode(input: unknown): GraphNode {
    const node = GraphNodeSchema.parse(input);
    this.#nodes.set(node.id, node);
    if (!this.#outbound.has(node.id)) this.#outbound.set(node.id, []);
    if (!this.#inbound.has(node.id)) this.#inbound.set(node.id, []);
    return node;
  }

  /**
   * Validates and inserts an edge. Both endpoints must already exist — a graph
   * that silently accepts dangling edges produces impact results that are
   * quietly incomplete, which is worse than an error.
   *
   * An edge is identified by `(from, type, to)`, and re-adding one replaces it
   * rather than appending a second copy. Nodes have always converged this way,
   * and edges must too or the stated design does not hold: adapters are
   * expected to overlap and to be re-run, so "B depends on A" observed twice is
   * one fact observed twice, not two dependencies. Accumulating them makes a
   * re-ingest multiply the graph, and makes a structural diff report phantom
   * additions for relationships that never changed — which behavioral
   * validation reads as a change doing more than it claimed.
   */
  addEdge(input: unknown): GraphEdge {
    const edge = GraphEdgeSchema.parse(input);
    if (!this.#nodes.has(edge.from)) {
      throw new Error(`edge references unknown 'from' node: ${edge.from}`);
    }
    if (!this.#nodes.has(edge.to)) {
      throw new Error(`edge references unknown 'to' node: ${edge.to}`);
    }

    const key = edgeIdentity(edge);
    const existing = this.#edgeIndex.get(key);
    if (existing !== undefined) this.#removeEdge(existing, key);

    this.#edgeIndex.set(key, edge);
    this.#edges.push(edge);
    this.#outbound.get(edge.from)!.push({ edge, other: edge.to });
    this.#inbound.get(edge.to)!.push({ edge, other: edge.from });
    return edge;
  }

  #removeEdge(edge: GraphEdge, key: string): void {
    this.#edgeIndex.delete(key);
    const at = this.#edges.indexOf(edge);
    if (at !== -1) this.#edges.splice(at, 1);
    this.#dropAdjacent(this.#outbound, edge.from, edge);
    this.#dropAdjacent(this.#inbound, edge.to, edge);
  }

  #dropAdjacent(index: Map<NodeId, AdjacentEdge[]>, id: NodeId, edge: GraphEdge): void {
    const list = index.get(id);
    if (list === undefined) return;
    const at = list.findIndex((a) => a.edge === edge);
    if (at !== -1) list.splice(at, 1);
  }

  node(id: NodeId): GraphNode | undefined {
    return this.#nodes.get(id);
  }

  /** Throws if absent. Used where a missing node is a programming error. */
  requireNode(id: NodeId): GraphNode {
    const node = this.#nodes.get(id);
    if (node === undefined) throw new Error(`unknown node: ${id}`);
    return node;
  }

  has(id: NodeId): boolean {
    return this.#nodes.has(id);
  }

  /** Edges where `id` is the `from` — what this node relies on. */
  outbound(id: NodeId): readonly AdjacentEdge[] {
    return this.#outbound.get(id) ?? [];
  }

  /** Edges where `id` is the `to` — what relies on this node. */
  inbound(id: NodeId): readonly AdjacentEdge[] {
    return this.#inbound.get(id) ?? [];
  }

  nodes(): IterableIterator<GraphNode> {
    return this.#nodes.values();
  }

  edges(): readonly GraphEdge[] {
    return this.#edges;
  }

  nodesInDomain(domain: Domain): GraphNode[] {
    return [...this.#nodes.values()].filter((n) => domainOf(n.id) === domain);
  }

  get size(): { nodes: number; edges: number } {
    return { nodes: this.#nodes.size, edges: this.#edges.length };
  }

  /**
   * All nodes connected to `id` by a specific edge type, in either direction.
   * Used for pulling constraint and verification attachments.
   */
  neighborsByType(id: NodeId, type: EdgeType): NodeId[] {
    const out = this.outbound(id)
      .filter((a) => a.edge.type === type)
      .map((a) => a.other);
    const inb = this.inbound(id)
      .filter((a) => a.edge.type === type)
      .map((a) => a.other);
    return [...new Set([...out, ...inb])];
  }
}
