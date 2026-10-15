import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGraph, resolveImpact, classifyRisk, parseIntent } from '@lbr/runtime-core';
import { PolicyAdapter, parsePolicy } from '../src/index.js';

/** A small real-shaped graph: a service that writes to a production table. */
function appGraph(): ProjectGraph {
  return ProjectGraph.from(
    [
      { id: 'service:api:billing', kind: 'api', name: 'Billing service', live: true },
      {
        id: 'service:table:invoices',
        kind: 'table',
        name: 'invoices',
        live: true,
        irreversible: true,
      },
      { id: 'surface:screen:checkout', kind: 'screen', name: 'Checkout', live: true },
    ],
    [
      { from: 'service:api:billing', type: 'writes', to: 'service:table:invoices' },
      { from: 'surface:screen:checkout', type: 'depends_on', to: 'service:api:billing' },
    ],
  );
}

const retentionPolicy = {
  version: 1,
  rules: [
    {
      id: 'invoice_retention',
      kind: 'retention_rule',
      name: 'Invoice retention',
      rationale: 'Finance requires seven years of invoice history',
      requiresApproval: true,
      appliesToActions: ['schema_migration', 'data_delete'],
      governs: ['service:table:'],
      attributes: { retentionYears: 7 },
    },
  ],
};

async function withPolicyFile<T>(
  contents: unknown,
  fn: (dir: string) => Promise<T>,
  path = '.lbr/policy.json',
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'lbr-policy-'));
  try {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('ingesting declared policy', () => {
  it('creates a policy node and wires it to what it governs', async () => {
    const graph = appGraph();
    const result = await withPolicyFile(retentionPolicy, (dir) =>
      new PolicyAdapter({ graph }).ingest(dir),
    );

    expect(result.nodes.map((n) => n.id)).toEqual(['policy:retention_rule:invoice_retention']);
    expect(result.edges).toEqual([
      {
        from: 'service:table:invoices',
        type: 'governed_by',
        to: 'policy:retention_rule:invoice_retention',
        attributes: {},
      },
    ]);
  });

  it('carries the fields the authority gate reads', async () => {
    const graph = appGraph();
    const result = await withPolicyFile(retentionPolicy, (dir) =>
      new PolicyAdapter({ graph }).ingest(dir),
    );
    const node = result.nodes[0]!;
    expect(node.attributes['requiresApproval']).toBe(true);
    expect(node.attributes['appliesToActions']).toEqual(['schema_migration', 'data_delete']);
    expect(node.attributes['retentionYears']).toBe(7);
  });

  it('treats a project with no policy file as declaring nothing, not as an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lbr-nopolicy-'));
    try {
      const result = await new PolicyAdapter({ graph: appGraph() }).ingest(dir);
      expect(result.nodes).toEqual([]);
      expect(result.unresolved).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a rule that governs nothing rather than accepting it silently', async () => {
    // A rule matching nothing looks exactly like a rule being obeyed. Someone
    // who wrote a policy and got no enforcement should be told it is inert.
    const graph = appGraph();
    const result = await withPolicyFile(
      {
        version: 1,
        rules: [
          {
            id: 'ghost',
            kind: 'safety_rule',
            name: 'Governs a service that does not exist',
            governs: ['service:api:nonexistent'],
          },
        ],
      },
      (dir) => new PolicyAdapter({ graph }).ingest(dir),
    );

    expect(result.edges).toEqual([]);
    expect(result.unresolved[0]!.reason).toContain('inert');
  });

  it('matches by id prefix so one rule covers a class of node', async () => {
    const graph = appGraph();
    graph.addNode({ id: 'service:table:payments', kind: 'table', name: 'payments', live: true });
    const result = await withPolicyFile(retentionPolicy, (dir) =>
      new PolicyAdapter({ graph }).ingest(dir),
    );
    expect(result.edges.map((e) => e.from).sort()).toEqual([
      'service:table:invoices',
      'service:table:payments',
    ]);
  });

  it('does not let policy govern policy', async () => {
    // Policy governing policy is a rabbit hole with no floor, and the impact
    // walk would do nothing useful with it. A rule aimed at the policy domain
    // therefore matches nothing and is reported inert.
    const graph = appGraph();
    graph.addNode({ id: 'policy:safety_rule:existing', kind: 'safety_rule', name: 'Existing' });
    const result = await withPolicyFile(
      {
        version: 1,
        rules: [{ id: 'meta', kind: 'audit_requirement', name: 'Audit the rules', governs: ['policy:'] }],
      },
      (dir) => new PolicyAdapter({ graph }).ingest(dir),
    );
    expect(result.edges).toEqual([]);
    expect(result.unresolved.some((u) => u.reason.includes('inert'))).toBe(true);
  });

  it('flags a duplicate rule instead of silently keeping one', async () => {
    const graph = appGraph();
    const result = await withPolicyFile(
      { version: 1, rules: [retentionPolicy.rules[0], retentionPolicy.rules[0]] },
      (dir) => new PolicyAdapter({ graph }).ingest(dir),
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.unresolved.some((u) => u.reason.includes('duplicate'))).toBe(true);
  });
});

describe('a malformed policy file fails loudly', () => {
  it('rejects invalid JSON rather than continuing unguarded', () => {
    // Continuing with an empty policy set would run unguarded while looking
    // governed, which is the worst of the available outcomes.
    expect(() => parsePolicy('{ not json', 'policy.json')).toThrow(/not valid JSON/);
  });

  it('rejects an unknown policy kind', () => {
    expect(() =>
      parsePolicy(
        JSON.stringify({
          version: 1,
          rules: [{ id: 'x', kind: 'vibes', name: 'Vibes', governs: ['a'] }],
        }),
      ),
    ).toThrow(/valid policy file/);
  });

  it('rejects a rule that governs nothing at all', () => {
    expect(() =>
      parsePolicy(
        JSON.stringify({
          version: 1,
          rules: [{ id: 'x', kind: 'safety_rule', name: 'X', governs: [] }],
        }),
      ),
    ).toThrow();
  });

  it('rejects an unknown action class rather than ignoring it', () => {
    expect(() =>
      parsePolicy(
        JSON.stringify({
          version: 1,
          rules: [
            {
              id: 'x',
              kind: 'safety_rule',
              name: 'X',
              governs: ['a'],
              appliesToActions: ['teleport'],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it('rejects an unknown top-level field, which is usually a typo in a rule name', () => {
    expect(() =>
      parsePolicy(JSON.stringify({ version: 1, rules: [], extra: true })),
    ).toThrow();
  });
});

describe('declared policy actually changes the verdict', () => {
  function assess(graph: ProjectGraph, actions: string[]) {
    const intent = parseIntent({
      id: 'i_policy',
      goal: 'Change the invoices table',
      rationale: 'test',
      source: 'agent',
      raisedBy: 'actor:agent:repair_agent',
      targets: ['service:table:invoices'],
      actions,
      successCondition: 'works',
    });
    const impact = resolveImpact(graph, intent);
    return classifyRisk(intent, impact);
  }

  it('binds an ingested rule to a real change', async () => {
    const graph = appGraph();
    const result = await withPolicyFile(retentionPolicy, (dir) =>
      new PolicyAdapter({ graph }).ingest(dir),
    );
    for (const node of result.nodes) graph.addNode(node);
    for (const edge of result.edges) graph.addEdge(edge);

    const risk = assess(graph, ['data_delete']);
    expect(risk.requiresApproval).toBe(true);
    expect(risk.reasons.map((r) => r.code)).toContain('policy_requires_approval');
  });

  it('leaves an action the rule does not govern alone', async () => {
    const graph = appGraph();
    const result = await withPolicyFile(retentionPolicy, (dir) =>
      new PolicyAdapter({ graph }).ingest(dir),
    );
    for (const node of result.nodes) graph.addNode(node);
    for (const edge of result.edges) graph.addEdge(edge);

    // The retention rule governs migrations and deletions. It has no opinion
    // about restarting something.
    const risk = assess(graph, ['restart']);
    expect(risk.reasons.map((r) => r.code)).not.toContain('policy_requires_approval');
  });

  it('is the difference between a governed project and an ungoverned one', async () => {
    const ungoverned = classifyRisk(
      parseIntent({
        id: 'i_bare',
        goal: 'Delete invoice rows',
        rationale: 'test',
        source: 'agent',
        raisedBy: 'actor:agent:repair_agent',
        targets: ['service:table:invoices'],
        actions: ['data_delete'],
        successCondition: 'works',
      }),
      resolveImpact(
        appGraph(),
        parseIntent({
          id: 'i_bare',
          goal: 'Delete invoice rows',
          rationale: 'test',
          source: 'agent',
          raisedBy: 'actor:agent:repair_agent',
          targets: ['service:table:invoices'],
          actions: ['data_delete'],
          successCondition: 'works',
        }),
      ),
    );
    expect(ungoverned.reasons.map((r) => r.code)).not.toContain('policy_requires_approval');
  });
});

describe('locating the policy file', () => {
  it('finds policy declared above the directory being ingested', async () => {
    // A project declares policy once; it is routinely ingested one package at
    // a time.
    const root = await mkdtemp(join(tmpdir(), 'lbr-monorepo-'));
    try {
      await mkdir(join(root, '.lbr'), { recursive: true });
      await writeFile(join(root, '.lbr', 'policy.json'), JSON.stringify(retentionPolicy));
      const pkg = join(root, 'packages', 'billing');
      await mkdir(pkg, { recursive: true });

      const result = await new PolicyAdapter({ graph: appGraph() }).ingest(pkg);
      expect(result.nodes.map((n) => n.id)).toEqual(['policy:retention_rule:invoice_retention']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops at the repository boundary rather than adopting a stranger's policy", async () => {
    // Walking to `/` would let an unrelated ancestor govern this project.
    const outer = await mkdtemp(join(tmpdir(), 'lbr-outer-'));
    try {
      await mkdir(join(outer, '.lbr'), { recursive: true });
      await writeFile(join(outer, '.lbr', 'policy.json'), JSON.stringify(retentionPolicy));

      const repo = join(outer, 'unrelated-repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });

      const result = await new PolicyAdapter({ graph: appGraph() }).ingest(join(repo, 'src'));
      expect(result.nodes).toEqual([]);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });
});

describe('selectors survive being ingested from a different root', () => {
  /** The same file, as the adapter would id it from two different ingest roots. */
  function graphIngestedFrom(prefix: string): ProjectGraph {
    const slug = `${prefix.replace(/[^a-z0-9]+/g, '_')}src_auth`.replace(/^_+/, '');
    return ProjectGraph.from(
      [
        {
          id: `code:module:${slug}`,
          kind: 'module',
          name: `${prefix}src/auth.ts`,
          attributes: { path: `${prefix}src/auth.ts` },
        },
      ],
      [],
    );
  }

  const pathRule = {
    version: 1,
    rules: [
      {
        id: 'auth_review',
        kind: 'approval_requirement',
        name: 'Auth changes need review',
        requiresApproval: true,
        governs: ['src/auth.ts'],
      },
    ],
  };

  it('binds when the project is ingested at its own root', async () => {
    const result = await withPolicyFile(pathRule, (dir) =>
      new PolicyAdapter({ graph: graphIngestedFrom('') }).ingest(dir),
    );
    expect(result.edges.map((e) => e.from)).toEqual(['code:module:src_auth']);
  });

  it('still binds when ingested from one level up, where every id changed', async () => {
    // Node ids are derived from the path relative to the ingested directory, so
    // an id-based rule would silently stop binding here — a policy that depends
    // on how the tool was invoked is the opposite of a policy.
    const result = await withPolicyFile(pathRule, (dir) =>
      new PolicyAdapter({ graph: graphIngestedFrom('packages/api/') }).ingest(dir),
    );
    expect(result.edges.map((e) => e.from)).toEqual(['code:module:packages_api_src_auth']);
  });

  it('matches on a segment boundary, not a bare suffix', async () => {
    const graph = ProjectGraph.from(
      [
        {
          id: 'code:module:other_notsrc_auth',
          kind: 'module',
          name: 'other/notsrc/auth.ts',
          attributes: { path: 'other/notsrc/auth.ts' },
        },
      ],
      [],
    );
    const result = await withPolicyFile(pathRule, (dir) =>
      new PolicyAdapter({ graph }).ingest(dir),
    );
    expect(result.edges).toEqual([]);
  });
});
