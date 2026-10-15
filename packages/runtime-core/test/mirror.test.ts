import { describe, it, expect } from 'vitest';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { parseIntent } from '../src/intent/intent.js';
import { resolveImpact } from '../src/impact/resolve.js';
import { planMirror } from '../src/mirror/plan.js';

const graph = loginAppGraph();

function planFor(overrides: Record<string, unknown> & { id: string }) {
  const intent = parseIntent({
    goal: 'change something',
    rationale: 'it needs changing',
    source: 'agent',
    raisedBy: 'actor:agent:repair_agent',
    targets: ['service:api:auth_service'],
    actions: ['code_change'],
    successCondition: 'it works',
    ...overrides,
  });
  const impact = resolveImpact(graph, intent);
  return { intent, impact, plan: planMirror(graph, intent, impact) };
}

describe('mirror planning', () => {
  const { plan } = planFor({ id: 'i_mirror' });
  const modeOf = (id: string) => plan.nodes.find((n) => n.id === id)?.mode;

  it('never binds a mirror to live irreversible state', () => {
    // The invariant the isolation step exists to enforce. The accounts
    // database is live and irreversible, so it is restored from a snapshot
    // whatever its confidence — a validation run must not be able to mutate
    // production.
    expect(modeOf('service:database:accounts')).toBe('copy');
    expect(plan.snapshotsRequired).toContain('service:database:accounts');
    expect(plan.safetyViolations).toEqual([]);
  });

  it('materializes the target and the high-confidence blast radius for real', () => {
    expect(modeOf('service:api:auth_service')).toBe('real');
    expect(modeOf('surface:screen:login')).toBe('real');
  });

  it('stubs the context the change relies on rather than running it', () => {
    expect(modeOf('service:endpoint:rate_limit')).toBe('stub');
    expect(modeOf('service:contract:session_token')).toBe('stub');
  });

  it('excludes host infrastructure the mirror provides itself', () => {
    expect(modeOf('infra:deploy_target:prod_cluster')).toBe('excluded');
    expect(modeOf('infra:network_permission:auth_ingress')).toBe('excluded');
  });

  it('carries policy in as constraints rather than materializing it', () => {
    expect(plan.constraints).toContain('policy:retention_rule:pii_retention');
    expect(plan.nodes.map((n) => n.id)).not.toContain('policy:retention_rule:pii_retention');
  });

  it('leaves actors out of the environment entirely', () => {
    expect(plan.nodes.every((n) => !n.id.startsWith('actor:'))).toBe(true);
  });

  it('states a reason for every materialization decision', () => {
    expect(plan.nodes.every((n) => n.reason.length > 0)).toBe(true);
  });

  it('narrows what runs for real as the threshold rises', () => {
    const { intent, impact } = planFor({ id: 'i_threshold' });
    const loose = planMirror(graph, intent, impact, { realThreshold: 0.1 });
    const tight = planMirror(graph, intent, impact, { realThreshold: 0.99 });
    const realCount = (p: typeof loose) => p.nodes.filter((n) => n.mode === 'real').length;
    expect(realCount(tight)).toBeLessThan(realCount(loose));
  });

  it('carries the verification plan into the environment', () => {
    expect(plan.verificationPlan.length).toBeGreaterThan(0);
  });
});

describe('mirror safety invariants', () => {
  it('flags a plan that would validate nothing', () => {
    // Targeting a node that is excluded from mirrors leaves nothing real to
    // exercise, which is a plan that cannot fail and therefore proves nothing.
    const { plan } = planFor({
      id: 'i_nothing',
      targets: ['infra:deploy_target:prod_cluster'],
      actions: ['config_change'],
    });
    const real = plan.nodes.filter((n) => n.mode === 'real');
    if (real.length === 0) {
      expect(plan.safetyViolations.some((v) => v.includes('validate nothing'))).toBe(true);
    }
  });

  it('treats a live irreversible target as a copy, not a real binding', () => {
    const { plan } = planFor({
      id: 'i_db_target',
      targets: ['service:database:accounts'],
      actions: ['schema_migration'],
    });
    expect(plan.nodes.find((n) => n.id === 'service:database:accounts')?.mode).toBe('copy');
    expect(plan.safetyViolations).toEqual([]);
  });
});
