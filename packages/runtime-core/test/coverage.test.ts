import { describe, it, expect } from 'vitest';
import { ProjectGraph } from '../src/graph/graph.js';
import { resolveImpact } from '../src/impact/resolve.js';
import { parseIntent } from '../src/intent/intent.js';
import { diffGraphs } from '../src/graph/diff.js';

const intent = (targets: string[]) =>
  parseIntent({
    id: 'coverage',
    goal: 'x',
    rationale: 'x',
    source: 'human',
    raisedBy: 'actor:human:cli',
    targets,
    actions: ['code_change'],
    successCondition: 'x',
  });

/** A straight import chain: n0 <- n1 <- n2 … as ordinary as code gets. */
function chain(length: number): ProjectGraph {
  return ProjectGraph.from(
    Array.from({ length }, (_, i) => ({
      id: `code:module:n${i}`,
      kind: 'module',
      name: `n${i}`,
    })),
    Array.from({ length: length - 1 }, (_, i) => ({
      from: `code:module:n${i + 1}`,
      type: 'depends_on' as const,
      to: `code:module:n${i}`,
    })),
  );
}

describe('the walk does not silently truncate a real dependency chain', () => {
  it('reports every dependent of a deep chain, not the first handful', () => {
    // A 30-module import chain is an ordinary shape. The previous default of
    // maxDepth 6 reported 6 of 29 dependents and said nothing about it.
    const impact = resolveImpact(chain(30), intent(['code:module:n0']));
    expect(impact.blastRadius.length).toBeGreaterThanOrEqual(28);
  });

  it('is bounded by confidence rather than by an arbitrary hop count', () => {
    // Where it does stop, it stops because nothing worth finding is left.
    const impact = resolveImpact(chain(80), intent(['code:module:n0']));
    expect(impact.coverage.depthLimited).toBe(0);
    expect(impact.coverage.highestUnexplored).toBeLessThan(0.05);
  });

  it('says so when a depth limit did cut the walk short', () => {
    // The dangerous failure is not being incomplete, it is being incomplete
    // while looking complete.
    const impact = resolveImpact(chain(30), intent(['code:module:n0']), { maxDepth: 6 });
    expect(impact.coverage.complete).toBe(false);
    expect(impact.coverage.depthLimited).toBeGreaterThan(0);
    // And reports that it stopped while still highly confident.
    expect(impact.coverage.highestUnexplored).toBeGreaterThan(0.5);
  });

  it('reports a fully explored graph as complete', () => {
    const impact = resolveImpact(chain(4), intent(['code:module:n0']));
    expect(impact.coverage.complete).toBe(true);
    expect(impact.coverage.depthLimited).toBe(0);
  });
});

describe('the walk terminates on shapes real code actually has', () => {
  it('survives a circular import', () => {
    const cyclic = ProjectGraph.from(
      [
        { id: 'code:module:a', kind: 'module', name: 'a' },
        { id: 'code:module:b', kind: 'module', name: 'b' },
      ],
      [
        { from: 'code:module:a', type: 'depends_on', to: 'code:module:b' },
        { from: 'code:module:b', type: 'depends_on', to: 'code:module:a' },
      ],
    );
    const impact = resolveImpact(cyclic, intent(['code:module:a']));
    expect(impact.implicated.map((n) => n.id).sort()).toEqual(['code:module:a', 'code:module:b']);
  });

  it('survives a self-edge', () => {
    const selfish = ProjectGraph.from(
      [{ id: 'code:module:s', kind: 'module', name: 's' }],
      [{ from: 'code:module:s', type: 'depends_on', to: 'code:module:s' }],
    );
    const impact = resolveImpact(selfish, intent(['code:module:s']));
    expect(impact.implicated).toHaveLength(1);
  });

  it('handles a node with no edges at all', () => {
    const lone = ProjectGraph.from(
      [{ id: 'code:module:lonely', kind: 'module', name: 'lonely' }],
      [],
    );
    const impact = resolveImpact(lone, intent(['code:module:lonely']));
    expect(impact.blastRadius).toEqual([]);
    expect(impact.magnitude).toBe(0);
    expect(impact.coverage.complete).toBe(true);
  });
});

describe('observing the same relationship twice is one relationship', () => {
  const two = () =>
    ProjectGraph.from(
      [
        { id: 'code:module:x', kind: 'module', name: 'x' },
        { id: 'code:module:y', kind: 'module', name: 'y' },
      ],
      [],
    );

  it('converges rather than accumulating when an adapter re-runs', () => {
    // Adapters are documented as additive, expected to overlap, and re-run on
    // every invocation. Nodes have always converged by id; edges must too, or
    // a re-ingest multiplies the graph.
    const graph = two();
    for (let i = 0; i < 3; i++) {
      graph.addEdge({ from: 'code:module:y', type: 'depends_on', to: 'code:module:x' });
    }
    expect(graph.size.edges).toBe(1);
    expect(graph.inbound('code:module:x')).toHaveLength(1);
    expect(graph.outbound('code:module:y')).toHaveLength(1);
  });

  it('keeps the newest attributes when the same edge is observed again', () => {
    const graph = two();
    graph.addEdge({
      from: 'code:module:y',
      type: 'depends_on',
      to: 'code:module:x',
      attributes: { specifier: './x.js' },
    });
    graph.addEdge({
      from: 'code:module:y',
      type: 'depends_on',
      to: 'code:module:x',
      attributes: { specifier: './x.ts' },
    });
    expect(graph.edges()).toHaveLength(1);
    expect(graph.edges()[0]!.attributes['specifier']).toBe('./x.ts');
  });

  it('still distinguishes two different relationships between the same pair', () => {
    const graph = two();
    graph.addEdge({ from: 'code:module:y', type: 'depends_on', to: 'code:module:x' });
    graph.addEdge({ from: 'code:module:y', type: 'writes', to: 'code:module:x' });
    expect(graph.size.edges).toBe(2);
  });

  it('does not report a phantom change when a graph is simply re-ingested', () => {
    // This is what the accumulation actually cost: behavioral validation reads
    // added edges as a change doing more than it claimed.
    const before = two();
    before.addEdge({ from: 'code:module:y', type: 'depends_on', to: 'code:module:x' });

    const after = two();
    for (let i = 0; i < 3; i++) {
      after.addEdge({ from: 'code:module:y', type: 'depends_on', to: 'code:module:x' });
    }

    expect(diffGraphs(before, after).addedEdges).toEqual([]);
  });
});

describe('an incomplete walk reaches the human who approves', () => {
  it('says so in the approval request rather than presenting a short list as whole', async () => {
    const { classifyRisk } = await import('../src/policy/risk.js');
    const { buildApprovalRequest } = await import('../src/policy/approval.js');

    const graph = chain(30);
    const i = intent(['code:module:n0']);
    const impact = resolveImpact(graph, i, { maxDepth: 6 });
    const request = buildApprovalRequest(graph, i, impact, classifyRisk(i, impact));

    expect(request.risks.some((r) => r.includes('did not finish'))).toBe(true);
  });

  it('says nothing about coverage when the walk was complete', async () => {
    const { classifyRisk } = await import('../src/policy/risk.js');
    const { buildApprovalRequest } = await import('../src/policy/approval.js');

    const graph = chain(4);
    const i = intent(['code:module:n0']);
    const impact = resolveImpact(graph, i);
    const request = buildApprovalRequest(graph, i, impact, classifyRisk(i, impact));

    expect(request.risks.some((r) => r.includes('did not finish'))).toBe(false);
  });
});
