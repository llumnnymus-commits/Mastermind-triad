import { describe, it, expect } from 'vitest';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { ProjectGraph } from '../src/graph/graph.js';
import { parseIntent, type Intent } from '../src/intent/intent.js';
import { resolveImpact } from '../src/impact/resolve.js';
import { planMirror } from '../src/mirror/plan.js';
import { runMechanicalValidation, type MirrorExecutor } from '../src/validation/mechanical.js';
import { runBehavioralValidation } from '../src/validation/behavioral.js';
import { diffGraphs } from '../src/graph/diff.js';

const baseIntent = {
  goal: 'Shorten session token lifetime',
  rationale: 'Security review',
  source: 'agent' as const,
  raisedBy: 'actor:agent:repair_agent',
  targets: ['service:api:auth_service'],
  actions: ['code_change' as const],
  successCondition: 'Sessions expire after 24h and login still works',
};

function setup(overrides: Partial<Intent> & { id: string }) {
  const graph = loginAppGraph();
  const intent = parseIntent({ ...baseIntent, ...overrides });
  const impact = resolveImpact(graph, intent);
  return { graph, intent, impact, plan: planMirror(graph, intent, impact) };
}

/** An executor that succeeds at everything, for testing the runner's logic. */
function passingExecutor(): MirrorExecutor {
  const ok = async () => ({ ok: true, detail: 'ok', durationMs: 1 });
  return { build: ok, start: ok, connect: ok, runVerification: ok };
}

describe('mechanical validation', () => {
  const { intent, plan } = setup({ id: 'i_mech' });

  it('verifies the mirror, then builds and starts, then runs the attached tests', async () => {
    const report = await runMechanicalValidation(intent, plan, passingExecutor());
    expect(report.passed).toBe(true);
    const names = report.checks.map((c) => c.name);
    expect(names.slice(0, 3)).toEqual(['connect', 'build', 'start']);
    expect(names.filter((n) => n.startsWith('verify')).length).toBe(plan.verificationPlan.length);
  });

  it('stops at the first failure rather than reporting its consequences', async () => {
    const executor: MirrorExecutor = {
      ...passingExecutor(),
      start: async () => ({ ok: false, detail: 'service exited on boot' }),
    };
    const report = await runMechanicalValidation(intent, plan, executor);
    expect(report.passed).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual(['connect', 'build', 'start']);
  });

  it('never runs project code in a mirror it has not verified', async () => {
    // `build` runs the project's own scripts, which on an ingested repository
    // is running somebody else's code. If `connect` reports the mirror does
    // not satisfy the plan, that code must not have run already.
    let built = false;
    const executor: MirrorExecutor = {
      ...passingExecutor(),
      connect: async () => ({ ok: false, detail: 'mirror cannot satisfy the plan' }),
      build: async () => {
        built = true;
        return { ok: true, detail: 'built' };
      },
    };

    const report = await runMechanicalValidation(intent, plan, executor);
    expect(built).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual(['connect']);
  });

  it('refuses to run a mirror plan that violates isolation', async () => {
    const unsafe = { ...plan, safetyViolations: ['would bind to production state'] };
    const report = await runMechanicalValidation(intent, unsafe, passingExecutor());
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.name).toBe('mirror safety');
  });

  it('does not treat an unverifiable change as a passing one', async () => {
    const noTests = { ...plan, verificationPlan: [] };
    const report = await runMechanicalValidation(intent, noTests, passingExecutor());
    expect(report.passed).toBe(false);
    expect(report.checks.some((c) => c.status === 'inconclusive')).toBe(true);
  });
});

describe('behavioral validation', () => {
  it('passes a change that stays inside the analyzed scope', async () => {
    const { graph, intent, impact } = setup({ id: 'i_clean' });
    const after = loginAppGraph();
    after.addNode({
      id: 'service:api:auth_service',
      kind: 'api',
      name: 'Authentication service',
      live: true,
      attributes: { sessionHours: 24 },
    });
    const report = await runBehavioralValidation({ before: graph, after, intent, impact });
    expect(report.checks.find((c) => c.name === 'scope adherence')!.status).toBe('pass');
  });

  it('catches a change that touched a node nobody analyzed', async () => {
    // The enforceable form of "scoped mutation as law": the walk predicted a
    // set before anything was written, and this node was not in it.
    const { graph, intent, impact } = setup({
      id: 'i_escape',
      targets: ['evidence:trace:auth_latency'],
      actions: ['config_change'],
    });
    const after = loginAppGraph();
    after.addNode({
      id: 'service:database:accounts',
      kind: 'database',
      name: 'Accounts database',
      live: true,
      irreversible: true,
      attributes: { engine: 'postgres', containsPii: true, tamperedBy: 'agent' },
    });
    const report = await runBehavioralValidation({ before: graph, after, intent, impact });
    const scope = report.checks.find((c) => c.name === 'scope adherence')!;
    expect(scope.status).toBe('fail');
    expect(scope.nodes).toContain('service:database:accounts');
    expect(report.passed).toBe(false);
  });

  it('catches a change that quietly grants itself a new permission', async () => {
    const { graph, intent, impact } = setup({ id: 'i_perm' });
    const after = loginAppGraph();
    after.addNode({
      id: 'infra:secret:stripe_key',
      kind: 'secret',
      name: 'Payment provider key',
    });
    after.addEdge({
      from: 'service:api:auth_service',
      type: 'depends_on',
      to: 'infra:secret:stripe_key',
    });
    const report = await runBehavioralValidation({ before: graph, after, intent, impact });
    expect(report.checks.find((c) => c.name === 'permission drift')!.status).toBe('fail');
  });

  it('catches a new write path into state that cannot be restored', async () => {
    const { graph, intent, impact } = setup({ id: 'i_irrev' });
    const after = loginAppGraph();
    after.addEdge({
      from: 'surface:screen:profile',
      type: 'writes',
      to: 'service:database:accounts',
    });
    const report = await runBehavioralValidation({ before: graph, after, intent, impact });
    const check = report.checks.find((c) => c.name === 'irreversible exposure')!;
    expect(check.status).toBe('fail');
    expect(check.nodes).toContain('service:database:accounts');
  });

  it('fails a change that would exceed the cost limit the intent declared', async () => {
    const { graph, intent, impact } = setup({
      id: 'i_cost',
      limits: { maxAddedDailyCostUsd: 5 },
    });
    const report = await runBehavioralValidation({
      before: graph,
      after: loginAppGraph(),
      intent,
      impact,
      projectedAddedDailyCostUsd: 42,
    });
    const check = report.checks.find((c) => c.name === 'cost limit')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('42');
  });

  it('does not let a missing cost projection pass as being within limits', async () => {
    const { graph, intent, impact } = setup({
      id: 'i_cost_missing',
      limits: { maxAddedDailyCostUsd: 5 },
    });
    const report = await runBehavioralValidation({
      before: graph,
      after: loginAppGraph(),
      intent,
      impact,
    });
    expect(report.checks.find((c) => c.name === 'cost limit')!.status).toBe('inconclusive');
    expect(report.passed).toBe(false);
  });

  it('does not let an absent evaluator launder into a pass', async () => {
    const { graph, intent, impact } = setup({ id: 'i_noeval' });
    const report = await runBehavioralValidation({
      before: graph,
      after: loginAppGraph(),
      intent,
      impact,
    });
    const check = report.checks.find((c) => c.name === 'success condition')!;
    expect(check.status).toBe('inconclusive');
    expect(report.passed).toBe(false);
  });

  it('records an evaluator that cannot reach a verdict as inconclusive, not a pass', async () => {
    const { graph, intent, impact } = setup({ id: 'i_unclear' });
    const report = await runBehavioralValidation({
      before: graph,
      after: loginAppGraph(),
      intent,
      impact,
      evaluator: {
        evaluateSuccessCondition: async () => ({
          verdict: 'unclear',
          reasoning: 'could not observe session expiry in the mirror',
        }),
      },
    });
    expect(report.checks.find((c) => c.name === 'success condition')!.status).toBe('inconclusive');
    expect(report.passed).toBe(false);
  });

  it('passes when the evaluator confirms the intent was met', async () => {
    const { graph, intent, impact } = setup({ id: 'i_met' });
    const report = await runBehavioralValidation({
      before: graph,
      after: loginAppGraph(),
      intent,
      impact,
      evaluator: {
        evaluateSuccessCondition: async () => ({
          verdict: 'met',
          reasoning: 'sessions expired at 24h across all three login paths',
        }),
      },
    });
    expect(report.passed).toBe(true);
  });
});

describe('graph diff', () => {
  it('reports nothing changed between identical graphs', () => {
    const diff = diffGraphs(loginAppGraph(), loginAppGraph());
    expect(diff.addedNodes).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
    expect(diff.changedNodes).toEqual([]);
    expect(diff.addedEdges).toEqual([]);
    expect(diff.removedEdges).toEqual([]);
  });

  it('names the fields that changed on a node', () => {
    const after = loginAppGraph();
    after.addNode({
      id: 'surface:screen:login',
      kind: 'screen',
      name: 'Sign-in screen',
      live: true,
    });
    const diff = diffGraphs(loginAppGraph(), after);
    expect(diff.changedNodes[0]!.fields).toContain('name');
  });

  it('detects an added edge', () => {
    const after = loginAppGraph();
    after.addEdge({
      from: 'surface:screen:profile',
      type: 'writes',
      to: 'service:table:users',
    });
    const diff = diffGraphs(loginAppGraph(), after);
    expect(diff.addedEdges).toHaveLength(1);
    expect(diff.addedEdges[0]!.type).toBe('writes');
  });

  it('detects a graph with a node removed', () => {
    const before = loginAppGraph();
    const after = ProjectGraph.from(
      [...before.nodes()].filter((n) => n.id !== 'evidence:test:mobile_login'),
      before.edges().filter((e) => e.to !== 'evidence:test:mobile_login'),
    );
    const diff = diffGraphs(before, after);
    expect(diff.removedNodes.map((n) => n.id)).toEqual(['evidence:test:mobile_login']);
    expect(diff.removedEdges).toHaveLength(1);
  });
});
