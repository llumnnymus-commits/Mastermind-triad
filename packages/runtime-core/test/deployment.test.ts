import { describe, it, expect } from 'vitest';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { parseIntent } from '../src/intent/intent.js';
import { resolveImpact } from '../src/impact/resolve.js';
import { classifyRisk } from '../src/policy/risk.js';
import { planMirror } from '../src/mirror/plan.js';
import { evaluatePromotion, DEFAULT_STAGES, type Baseline } from '../src/deployment/stages.js';
import { openLineage, recordStage, auditPrediction } from '../src/deployment/lineage.js';

const baseline: Baseline = { errorRate: 0.01, latencyP95Ms: 200, crashRate: 0.001 };

describe('promotion gates', () => {
  it('promotes to the next stage when signals are within tolerance', () => {
    const decision = evaluatePromotion('internal', { errorRate: 0.011, latencyP95Ms: 210 }, baseline);
    expect(decision.verdict).toBe('promote');
    expect(decision.nextStage).toBe('limited');
  });

  it('rolls back on an error-rate regression', () => {
    const decision = evaluatePromotion('limited', { errorRate: 0.05 }, baseline);
    expect(decision.verdict).toBe('roll_back');
    expect(decision.reasons[0]).toContain('error rate');
  });

  it('rolls back on any security anomaly, however small', () => {
    const decision = evaluatePromotion('internal', { securityAnomalies: 1 }, baseline);
    expect(decision.verdict).toBe('roll_back');
  });

  it('holds rather than promoting when no evidence was reported', () => {
    // Silence is not success. This is the case that would otherwise roll an
    // unmonitored change to everyone.
    const decision = evaluatePromotion('internal', {}, baseline);
    expect(decision.verdict).toBe('hold');
    expect(decision.reasons[0]).toContain('no evidence');
  });

  it('holds until the soak has elapsed', () => {
    const decision = evaluatePromotion('internal', { errorRate: 0.01 }, baseline, {}, 5);
    expect(decision.verdict).toBe('hold');
    expect(decision.reasons[0]).toContain('soak incomplete');
  });

  it('rolls back when a change exceeds its cost ceiling in production', () => {
    const decision = evaluatePromotion(
      'limited',
      { errorRate: 0.01, addedDailyCostUsd: 300 },
      baseline,
      { maxAddedDailyCostUsd: 50 },
    );
    expect(decision.verdict).toBe('roll_back');
    expect(decision.reasons[0]).toContain('added cost');
  });

  it('rolls back when model quality drops below the floor', () => {
    const decision = evaluatePromotion(
      'limited',
      { errorRate: 0.01, modelQuality: 0.6 },
      baseline,
      { minModelQuality: 0.8 },
    );
    expect(decision.verdict).toBe('roll_back');
  });

  it('stops promoting at full exposure', () => {
    const decision = evaluatePromotion('full', { errorRate: 0.01 }, baseline);
    expect(decision.verdict).toBe('promote');
    expect(decision.nextStage).toBeUndefined();
  });

  it('widens exposure monotonically across the default stages', () => {
    const exposures = DEFAULT_STAGES.map((s) => s.exposure);
    expect([...exposures].sort((a, b) => a - b)).toEqual(exposures);
  });
});

describe('lineage', () => {
  const graph = loginAppGraph();
  const intent = parseIntent({
    id: 'intent_lineage',
    goal: 'Shorten session lifetime',
    rationale: 'Security review',
    source: 'agent',
    raisedBy: 'actor:agent:repair_agent',
    targets: ['service:api:auth_service'],
    actions: ['code_change'],
    successCondition: 'Sessions expire at 24h',
  });
  const impact = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, impact);
  const mirror = planMirror(graph, intent, impact);

  const record = openLineage({
    deploymentId: 'dep_001',
    baseRevision: 'rev_abc123',
    intent,
    impact,
    risk,
    mirror,
    validation: [],
    rollback: {
      toDeploymentId: 'dep_000',
      unrecoverableNodes: impact.irreversible.map((n) => n.id),
      steps: ['redeploy dep_000', 'verify auth health'],
    },
  });

  it('captures the prediction while it is still a prediction', () => {
    expect(record.predictedImpact.blastRadius.length).toBeGreaterThan(0);
    expect(record.predictedImpact.magnitude).toBe(impact.magnitude);
    expect(record.outcome).toBe('in_progress');
  });

  it('records what the mirror actually materialized', () => {
    expect(record.mirror.realNodes).toContain('service:api:auth_service');
    expect(record.mirror.copiedNodes).toContain('service:database:accounts');
  });

  it('states honestly what rollback cannot restore', () => {
    expect(record.rollback.unrecoverableNodes).toContain('service:database:accounts');
  });

  it('closes as deployed when the final stage promotes', () => {
    const done = recordStage(record, {
      stage: 'full',
      enteredAt: new Date().toISOString(),
      evidence: { errorRate: 0.01 },
      decision: { verdict: 'promote', reasons: ['clean'] },
    });
    expect(done.outcome).toBe('deployed');
  });

  it('closes as rolled back when a stage regresses', () => {
    const failed = recordStage(record, {
      stage: 'limited',
      enteredAt: new Date().toISOString(),
      evidence: { errorRate: 0.4 },
      decision: { verdict: 'roll_back', reasons: ['error rate'] },
    });
    expect(failed.outcome).toBe('rolled_back');
  });

  it('scores a prediction that was exactly right', () => {
    const audit = auditPrediction(record, record.predictedImpact.blastRadius);
    expect(audit.recall).toBe(1);
    expect(audit.precision).toBe(1);
    expect(audit.misses).toEqual([]);
  });

  it('reports a casualty nobody predicted as a missing edge in the graph', () => {
    // The signal worth acting on: the deployment was fine, the graph was wrong.
    const audit = auditPrediction(record, [
      ...record.predictedImpact.blastRadius,
      'service:endpoint:rate_limit',
    ]);
    expect(audit.misses).toEqual(['service:endpoint:rate_limit']);
    expect(audit.recall).toBeLessThan(1);
  });

  it('reports over-prediction without treating it as failure', () => {
    const audit = auditPrediction(record, ['surface:screen:login']);
    expect(audit.recall).toBe(1);
    expect(audit.precision).toBeLessThan(1);
    expect(audit.falseAlarms.length).toBeGreaterThan(0);
  });
});
