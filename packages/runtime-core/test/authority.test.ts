import { describe, it, expect } from 'vitest';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { parseIntent, type Intent } from '../src/intent/intent.js';
import { resolveImpact } from '../src/impact/resolve.js';
import { classifyRisk } from '../src/policy/risk.js';
import { buildApprovalRequest } from '../src/policy/approval.js';

const graph = loginAppGraph();

function assess(overrides: Partial<Intent> & { id: string }) {
  const intent = parseIntent({
    goal: 'change something',
    rationale: 'because it needs changing',
    source: 'agent',
    raisedBy: 'actor:agent:repair_agent',
    targets: ['service:api:auth_service'],
    actions: ['code_change'],
    successCondition: 'it works',
    ...overrides,
  });
  const impact = resolveImpact(graph, intent);
  return { intent, impact, risk: classifyRisk(intent, impact) };
}

describe('the authority gate — capability is not permission', () => {
  it('lets an agent restart an unhealthy worker unattended, even on a busy path', () => {
    // The rate limiter sits under the auth service that three live surfaces
    // depend on, so its blast radius on the graph is identical to that of a
    // schema migration. What separates them is that a restart resolves itself.
    const { risk } = assess({
      id: 'i_restart',
      targets: ['service:endpoint:rate_limit'],
      actions: ['restart'],
      goal: 'Restart the rate limiter after a health check failure',
    });
    expect(risk.tier).toBe('low');
    expect(risk.requiresApproval).toBe(false);
  });

  it('does not let a data policy bind an action it has no opinion about', () => {
    // The PII retention rule is reachable from almost anywhere in this graph.
    // It governs how account data is shaped and kept — not whether a worker
    // may be restarted.
    const { risk } = assess({
      id: 'i_restart_policy',
      targets: ['service:endpoint:rate_limit'],
      actions: ['restart'],
    });
    expect(risk.reasons.map((r) => r.code)).not.toContain('policy_requires_approval');
  });

  it('lets an agent roll back a failed release unattended', () => {
    const { risk } = assess({
      id: 'i_rollback',
      targets: ['surface:screen:profile'],
      actions: ['rollback'],
      goal: 'Roll back the profile screen to the last known-good deployment',
    });
    expect(risk.requiresApproval).toBe(false);
  });

  it('stops an agent before it changes permissions', () => {
    const { risk } = assess({
      id: 'i_perm',
      targets: ['infra:network_permission:auth_ingress'],
      actions: ['permission_change'],
      goal: 'Widen auth ingress to a new subnet',
    });
    expect(risk.tier).toBe('high');
    expect(risk.requiresApproval).toBe(true);
    expect(risk.reasons.map((r) => r.code)).toContain('action_class');
  });

  it('stops an agent before it deletes data', () => {
    const { risk } = assess({
      id: 'i_delete',
      targets: ['service:table:users'],
      actions: ['data_delete'],
      goal: 'Purge orphaned user rows',
    });
    expect(risk.requiresApproval).toBe(true);
  });

  it('escalates a routine code change when a governing policy demands approval', () => {
    // Nothing about `code_change` is high risk on its own. The PII retention
    // policy three hops away is what escalates it — which is only visible
    // because policy does not decay across the walk.
    const { risk } = assess({ id: 'i_policy', actions: ['code_change'] });
    expect(risk.tier).toBe('high');
    expect(risk.requiresApproval).toBe(true);
    expect(risk.reasons.map((r) => r.code)).toContain('policy_requires_approval');
  });

  it('refuses rather than prompts when the intent crosses its own declared limits', () => {
    const { risk } = assess({
      id: 'i_blocked',
      actions: ['code_change'],
      limits: { forbiddenNodes: ['service:database:accounts'] },
    });
    expect(risk.blocked).toBe(true);
    expect(risk.reasons.some((r) => r.escalatesTo === 'blocked')).toBe(true);
  });

  it('notices a live blast radius even for an ordinary action', () => {
    const { risk } = assess({ id: 'i_live', actions: ['config_change'] });
    const codes = risk.reasons.map((r) => r.code);
    expect(codes).toContain('live_blast_radius');
  });
});

describe('the approval request', () => {
  const { intent, impact, risk } = assess({
    id: 'i_approval',
    actions: ['schema_migration'],
    targets: ['service:table:users'],
    goal: 'Add a last_login_at column to the users table',
    rationale: 'Support the security review requirement to expire dormant sessions',
    successCondition: 'Column exists, backfilled, and login writes it on every authentication',
  });
  const request = buildApprovalRequest(graph, intent, impact, risk);

  it('states the exact operation rather than a summary', () => {
    expect(request.operation).toContain('schema_migration');
    expect(request.operation).toContain('users');
    expect(request.rationale).toContain('security review');
  });

  it('names what is affected, worst first, with why', () => {
    expect(request.affectedSystems.length).toBeGreaterThan(0);
    const first = request.affectedSystems[0]!;
    expect(first.why).toBeTruthy();
    // Confidence is monotonically non-increasing down the list.
    const scores = request.affectedSystems.map((s) => s.confidence);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('explains implication paths in the edge vocabulary, not "connected to"', () => {
    const auth = request.affectedSystems.find((s) => s.id === 'service:api:auth_service');
    expect(auth?.why).toMatch(/writes to/);
  });

  it('identifies the data in scope', () => {
    expect(request.dataInvolved).toContain('service:table:users');
    expect(request.dataInvolved).toContain('service:database:accounts');
  });

  it('answers the reversibility question honestly', () => {
    expect(request.reversibility.reversible).toBe(false);
    expect(request.reversibility.irreversibleNodes).toContain('service:database:accounts');
    expect(request.reversibility.detail).toContain('cannot be restored');
  });

  it('lists the governing policies and the verification plan', () => {
    expect(request.governingPolicies).toContain('policy:retention_rule:pii_retention');
    expect(request.verificationPlan.length).toBeGreaterThan(0);
  });

  it('warns when nothing would catch a failure', () => {
    const bare = assess({
      id: 'i_untested',
      targets: ['infra:deploy_target:prod_cluster'],
      actions: ['config_change'],
    });
    const req = buildApprovalRequest(graph, bare.intent, bare.impact, bare.risk);
    if (bare.impact.verifications.length === 0) {
      expect(req.risks.some((r) => r.includes('no tests'))).toBe(true);
    }
  });
});
