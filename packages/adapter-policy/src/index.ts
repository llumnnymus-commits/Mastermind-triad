import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  DomainAdapter,
  GraphEdge,
  GraphNode,
  IngestResult,
  ProjectGraph,
  UnresolvedReference,
} from '@lbr/runtime-core';
import { PolicyFileSchema, type PolicyFile, type PolicyRule } from './schema.js';

export * from './schema.js';

export const DEFAULT_POLICY_PATH = '.lbr/policy.json';

export interface PolicyAdapterOptions {
  /** Path to the policy file, relative to the ingested directory. */
  readonly policyPath?: string;
  /**
   * The graph to attach policy to. Required: a policy node with nothing to
   * govern is inert, so the adapter needs to see the nodes it is binding.
   */
  readonly graph: ProjectGraph;
}

/**
 * Populates the policy domain from a declared file, and wires each rule to
 * what it governs.
 *
 * This is what makes the authority gate real on a real project. Until a
 * project declares policy, the gate has only the action class and the shape of
 * the graph to work with — enough to notice that a change is large, not enough
 * to know that the data it touches is governed by a retention rule somebody
 * agreed to.
 */
export class PolicyAdapter implements DomainAdapter {
  readonly name = 'policy';
  readonly #graph: ProjectGraph;
  readonly #policyPath: string;

  constructor(options: PolicyAdapterOptions) {
    this.#graph = options.graph;
    this.#policyPath = options.policyPath ?? DEFAULT_POLICY_PATH;
  }

  async ingest(source: string): Promise<IngestResult> {
    if (isAbsolute(this.#policyPath)) {
      throw new Error(`policyPath must be relative to the ingested directory: ${this.#policyPath}`);
    }
    const file = await this.#locate(resolve(source));
    if (file === undefined) {
      // A project with no policy file is the normal case, not an error. It
      // means nothing is declared, and the gate falls back to action class and
      // graph shape — which is exactly what it should do.
      return { nodes: [], edges: [], unresolved: [] };
    }

    return this.ingestPolicy(parsePolicy(await readFile(file, 'utf8'), file));
  }

  /** Build nodes and edges from an already-parsed policy. */
  ingestPolicy(policy: PolicyFile): IngestResult {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const unresolved: UnresolvedReference[] = [];
    const seen = new Set<string>();

    for (const rule of policy.rules) {
      const id = `policy:${rule.kind}:${rule.id}`;
      if (seen.has(id)) {
        unresolved.push({
          from: this.#policyPath,
          reference: rule.id,
          reason: `duplicate policy id '${rule.id}' for kind '${rule.kind}'`,
        });
        continue;
      }
      seen.add(id);

      nodes.push({
        id,
        kind: rule.kind,
        name: rule.name,
        live: false,
        irreversible: false,
        attributes: {
          ...rule.attributes,
          adapter: this.name,
          requiresApproval: rule.requiresApproval,
          ...(rule.appliesToActions === undefined
            ? {}
            : { appliesToActions: rule.appliesToActions }),
          ...(rule.rationale === undefined ? {} : { rationale: rule.rationale }),
        },
      });

      const governed = this.#resolveGoverned(rule);
      if (governed.length === 0) {
        // Silence here would be the worst outcome: a rule that matches nothing
        // looks identical to a rule being obeyed. Someone who wrote a policy
        // and got no enforcement should be told the policy is inert, not left
        // to infer it from a clean report.
        unresolved.push({
          from: this.#policyPath,
          reference: rule.governs.join(', '),
          reason: `policy '${rule.id}' governs nothing in the graph — it is declared but inert`,
        });
        continue;
      }

      for (const target of governed) {
        edges.push({ from: target, type: 'governed_by', to: id, attributes: {} });
      }
    }

    return { nodes, edges, unresolved };
  }

  /**
   * Find the policy file for a directory.
   *
   * Policy is declared for a project, but a project is routinely ingested one
   * package at a time — so the file is looked for in the given directory and
   * then upward, the way essentially every tool locates its configuration. The
   * walk stops at the repository root rather than continuing to `/`, so
   * ingesting a directory can never pick up somebody else's policy from an
   * unrelated ancestor.
   */
  async #locate(from: string): Promise<string | undefined> {
    let current = from;
    for (;;) {
      const candidate = join(current, this.#policyPath);
      if (await exists(candidate)) return candidate;
      // A repository boundary is where the search stops, whether or not it
      // held a policy file.
      if (await exists(join(current, '.git'))) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  #resolveGoverned(rule: PolicyRule): string[] {
    const matched = new Set<string>();
    for (const node of this.#graph.nodes()) {
      // Policy governing policy is a rabbit hole with no floor, and nothing in
      // the impact walk would do anything useful with it.
      if (node.id.startsWith('policy:')) continue;
      if (rule.governs.some((selector) => matches(node, selector))) matched.add(node.id);
    }
    return [...matched].sort();
  }
}

/**
 * Does a selector name this node?
 *
 * A selector containing `/` is a source path and is matched against the node's
 * recorded path, so the rule survives being ingested from a different root. Any
 * other selector is a node id or an id prefix.
 */
function matches(node: GraphNode, selector: string): boolean {
  if (selector.includes('/')) {
    const path = node.attributes['path'];
    if (typeof path !== 'string') return false;
    // Suffix match on a segment boundary: `src/auth.ts` governs
    // `packages/api/src/auth.ts` but never `other/notsrc/auth.ts`.
    return path === selector || path.endsWith(`/${selector}`);
  }
  return node.id === selector || node.id.startsWith(selector);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse and validate a policy file.
 *
 * Failure is loud. A malformed policy file means the declared constraints are
 * not in force, and a runtime that silently continued with an empty policy set
 * would be running unguarded while looking governed — the worst of the
 * available outcomes.
 */
export function parsePolicy(raw: string, sourceLabel = 'policy'): PolicyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${(error as Error).message}`);
  }

  const result = PolicyFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${sourceLabel} is not a valid policy file:\n${issues}`);
  }
  return result.data;
}
