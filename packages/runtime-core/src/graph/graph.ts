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
   */
  addEdge(input: unknown): GraphEdge {
    const edge = GraphEdgeSchema.parse(input);
    if (!this.#nodes.has(edge.from)) {
      throw new Error(`edge references unknown 'from' node: ${edge.from}`);
    }
    if (!this.#nodes.has(edge.to)) {
      throw new Error(`edge references unknown 'to' node: ${edge.to}`);
    }
    this.#edges.push(edge);
    this.#outbound.get(edge.from)!.push({ edge, other: edge.to });
    this.#inbound.get(edge.to)!.push({ edge, other: edge.from });
    return edge;
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
