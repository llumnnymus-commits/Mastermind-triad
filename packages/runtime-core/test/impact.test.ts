import { describe, it, expect } from 'vitest';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { parseIntent } from '../src/intent/intent.js';
import { resolveImpact } from '../src/impact/resolve.js';
import type { NodeId } from '../src/graph/nodes.js';

function ids(nodes: readonly { id: NodeId }[]): string[] {
  return nodes.map((n) => n.id).sort();
}

const changeAuthService = parseIntent({
  id: 'intent_001',
  goal: 'Shorten the session token lifetime on the authentication service',
  rationale: 'Security review flagged 30-day sessions as excessive for an app holding PII',
  source: 'agent',
  raisedBy: 'actor:agent:repair_agent',
  targets: ['service:api:auth_service'],
  actions: ['code_change'],
  successCondition: 'Sessions expire after 24h and all login flows still authenticate',
});

describe('impact resolution — the login workflow case from the specification', () => {
  const graph = loginAppGraph();
  const impact = resolveImpact(graph, changeAuthService);
  const found = new Set(impact.implicated.map((n) => n.id));

  it('finds every system the specification says it must find', () => {
    // "It should identify the authentication service, session-token rules,
    //  database fields, rate limits, account-recovery flow, permissions,
    //  telemetry, browser tests, mobile tests..."
    const required: NodeId[] = [
      'service:api:auth_service', // the authentication service
      'service:contract:session_token', // session-token rules
      'service:table:users', // database fields
      'service:database:accounts', // ...and the database holding them
      'service:endpoint:rate_limit', // rate limits
      'surface:flow:account_recovery', // account-recovery flow
      'infra:network_permission:auth_ingress', // permissions
      'evidence:trace:auth_latency', // telemetry
      'evidence:test:browser_login', // browser tests
      'evidence:test:mobile_login', // mobile tests
    ];
    const missing = required.filter((id) => !found.has(id));
    expect(missing).toEqual([]);
  });

  it('does not stop at the visible login-screen code', () => {
    // The failure mode the specification is warning about: an agent that edits
    // the screen and calls it done.
    expect(found.has('surface:screen:login')).toBe(true);
    expect(impact.structuralCount).toBeGreaterThan(5);
  });

  it('separates what breaks from what the change relies on', () => {
    // Screens depend on auth, so they break when auth changes.
    expect(ids(impact.blastRadius)).toContain('surface:screen:login');
    expect(ids(impact.blastRadius)).toContain('surface:screen:profile');
    expect(ids(impact.blastRadius)).toContain('surface:flow:account_recovery');

    // Auth depends on these, so they are context, not casualties.
    const context = impact.implicated.filter((n) => n.relation === 'context').map((n) => n.id);
    expect(context).toContain('service:endpoint:rate_limit');
    expect(context).toContain('service:contract:session_token');

    // The distinction is the whole point: a dependent is not a dependency.
    expect(ids(impact.blastRadius)).not.toContain('service:endpoint:rate_limit');
  });

  it('scores direct dependents above transitive ones', () => {
    const score = (id: string) => impact.implicated.find((n) => n.id === id)?.score ?? 0;
    // login_screen depends directly on auth; login_view only implements the screen.
    expect(score('surface:screen:login')).toBeGreaterThan(score('code:module:login_view'));
  });

  it('binds policy at the strength of the node it governs, with no extra decay', () => {
    // pii_retention governs the accounts database, reached three hops out via
    // auth -> writes -> users -> part_of -> accounts. The `governed_by` hop
    // itself costs nothing, so the policy is exactly as relevant as the data
    // it protects is implicated — no more, no less.
    const pii = impact.constraints.find((c) => c.id === 'policy:retention_rule:pii_retention')!;
    const accounts = impact.implicated.find((n) => n.id === 'service:database:accounts')!;
    expect(pii.score).toBe(accounts.score);

    // Distance still matters: the policy on auth itself binds harder than the
    // one three hops away behind a write.
    const sessionExpiry = impact.constraints.find(
      (c) => c.id === 'policy:safety_rule:session_expiry',
    )!;
    expect(sessionExpiry.score).toBeGreaterThan(pii.score);
  });

  it('keeps verification attached at full weight regardless of distance', () => {
    // Deliberately asymmetric with policy: an unnecessary test costs seconds,
    // a skipped one costs an outage.
    expect(impact.verifications.every((v) => v.score === 1)).toBe(true);
  });

  it('collects the tests that must run', () => {
    expect(ids(impact.verifications)).toEqual([
      'evidence:test:auth_service',
      'evidence:test:browser_login',
      'evidence:test:mobile_login',
    ]);
  });

  it('flags the irreversible node in scope', () => {
    expect(ids(impact.irreversible)).toEqual(['service:database:accounts']);
  });

  it('reports which domains a single-node change actually spans', () => {
    expect(impact.domainsTouched).toEqual(
      expect.arrayContaining(['code', 'evidence', 'infra', 'policy', 'service', 'surface']),
    );
  });

  it('records the path that implicated each node', () => {
    const recovery = impact.implicated.find((n) => n.id === 'surface:flow:account_recovery')!;
    expect(recovery.path).toEqual([
      {
        from: 'surface:flow:account_recovery',
        type: 'depends_on',
        to: 'service:api:auth_service',
        direction: 'inbound',
      },
    ]);
  });
});

describe('impact resolution — mechanics', () => {
  const graph = loginAppGraph();

  it('settles each node on its strongest path, not the first one found', () => {
    // profile and login both depend on auth directly; neither should be
    // discounted by a longer alternative route existing.
    const impact = resolveImpact(graph, changeAuthService);
    const login = impact.implicated.find((n) => n.id === 'surface:screen:login')!;
    expect(login.score).toBe(1); // depends_on blast weight is 1.0
    expect(login.depth).toBe(1);
  });

  it('respects the epsilon cutoff', () => {
    const wide = resolveImpact(graph, changeAuthService, { epsilon: 0.01 });
    const narrow = resolveImpact(graph, changeAuthService, { epsilon: 0.5 });
    expect(narrow.implicated.length).toBeLessThan(wide.implicated.length);
  });

  it('respects the depth cutoff', () => {
    const shallow = resolveImpact(graph, changeAuthService, { maxDepth: 1 });
    expect(shallow.implicated.map((n) => n.id)).not.toContain('service:database:accounts');
  });

  it('does not propagate structurally out of a policy node', () => {
    // Reaching pii_retention must not drag in everything else it governs.
    const impact = resolveImpact(graph, changeAuthService);
    const constraintIds = impact.constraints.map((c) => c.id);
    expect(constraintIds).toContain('policy:retention_rule:pii_retention');
    expect(impact.implicated.every((n) => n.relation !== 'blast' || !n.id.startsWith('policy:'))).toBe(
      true,
    );
  });

  it('rejects an intent targeting a node that is not in the graph', () => {
    const bad = parseIntent({
      ...changeAuthService,
      id: 'intent_bad',
      targets: ['service:api:nonexistent'],
    });
    expect(() => resolveImpact(graph, bad)).toThrow(/unknown node/);
  });

  it('grows magnitude with the size of the blast radius, and saturates', () => {
    const single = resolveImpact(
      graph,
      parseIntent({ ...changeAuthService, id: 'i1', targets: ['evidence:trace:auth_latency'] }),
    );
    const central = resolveImpact(graph, changeAuthService);
    expect(central.magnitude).toBeGreaterThan(single.magnitude);
    expect(central.magnitude).toBeLessThanOrEqual(1);
  });
});

describe('intent limits', () => {
  const graph = loginAppGraph();

  it('flags a change that would touch a node the intent forbade', () => {
    const impact = resolveImpact(
      graph,
      parseIntent({
        ...changeAuthService,
        id: 'intent_limited',
        limits: { forbiddenNodes: ['service:database:accounts'] },
      }),
    );
    expect(impact.violations.map((v) => v.limit)).toContain('forbiddenNodes');
  });

  it('flags a change wider than the intent allowed', () => {
    const impact = resolveImpact(
      graph,
      parseIntent({ ...changeAuthService, id: 'intent_narrow', limits: { maxImplicatedNodes: 2 } }),
    );
    expect(impact.violations.map((v) => v.limit)).toContain('maxImplicatedNodes');
  });

  it('flags a change reaching irreversible state when the intent forbade it', () => {
    const impact = resolveImpact(
      graph,
      parseIntent({
        ...changeAuthService,
        id: 'intent_reversible_only',
        limits: { forbidIrreversible: true },
      }),
    );
    expect(impact.violations.map((v) => v.limit)).toContain('forbidIrreversible');
  });

  it('passes a change that stays inside its limits', () => {
    const impact = resolveImpact(
      graph,
      parseIntent({
        ...changeAuthService,
        id: 'intent_ok',
        targets: ['surface:screen:profile'],
        limits: { forbidIrreversible: true, maxImplicatedNodes: 20 },
      }),
    );
    expect(impact.violations).toEqual([]);
  });

  it('does not trip a categorical limit on a node reachable only in principle', () => {
    // The accounts database is four weak hops from the profile screen. It is
    // correctly reported as implicated, and it must not by itself veto every
    // change made anywhere in an app that has a production database.
    const impact = resolveImpact(
      graph,
      parseIntent({
        ...changeAuthService,
        id: 'intent_far',
        targets: ['surface:screen:profile'],
        limits: { forbidIrreversible: true },
      }),
    );
    const accounts = impact.implicated.find((n) => n.id === 'service:database:accounts');
    expect(accounts).toBeDefined();
    expect(accounts!.score).toBeLessThan(0.25);
    expect(impact.violations).toEqual([]);
  });
});
