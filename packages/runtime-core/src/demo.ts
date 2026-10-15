/**
 * Run one intent through the entire loop and print what the runtime knows at
 * each step.
 *
 *   npx tsx packages/runtime-core/src/demo.ts
 *
 * Two intents touch overlapping parts of the same graph. One is handled
 * unattended; the other stops for a human, is validated in isolation, deploys
 * progressively, and is rolled back when production disagrees with the tests.
 * Every verdict below is computed, not narrated.
 */
import { loginAppGraph } from './fixtures/login-app.js';
import { parseIntent, type Intent } from './intent/intent.js';
import { resolveImpact } from './impact/resolve.js';
import { classifyRisk } from './policy/risk.js';
import { buildApprovalRequest } from './policy/approval.js';
import { planMirror } from './mirror/plan.js';
import { runMechanicalValidation, type MirrorExecutor } from './validation/mechanical.js';
import { runBehavioralValidation } from './validation/behavioral.js';
import { evaluatePromotion, type Baseline, type StageEvidence } from './deployment/stages.js';
import { openLineage, recordStage, auditPrediction } from './deployment/lineage.js';
import { attributeCosts, assessSustainability, type CostEvent } from './cost/attribution.js';

const graph = loginAppGraph();

const restart = parseIntent({
  id: 'intent_restart',
  goal: 'Restart the auth rate limiter after three failed health checks',
  rationale: 'Health probe failing for 4 minutes; restart is the standard remedy',
  source: 'incident',
  raisedBy: 'actor:agent:repair_agent',
  targets: ['service:endpoint:rate_limit'],
  actions: ['restart'],
  successCondition: 'Health check passes within 60s and auth error rate returns to baseline',
});

const migration = parseIntent({
  id: 'intent_migration',
  goal: 'Add a last_login_at column to the users table',
  rationale: 'Security review requires dormant-session expiry, which needs a last-login timestamp',
  source: 'agent',
  raisedBy: 'actor:agent:repair_agent',
  targets: ['service:table:users'],
  actions: ['schema_migration'],
  successCondition: 'Column exists, is backfilled, and every authentication writes it',
  limits: { maxAddedDailyCostUsd: 5 },
});

const passing: MirrorExecutor = {
  build: async () => ({ ok: true, detail: 'gradle assemble succeeded', durationMs: 42_000 }),
  start: async () => ({ ok: true, detail: 'all real nodes healthy', durationMs: 8_000 }),
  connect: async () => ({ ok: true, detail: 'stubs reachable, snapshot restored', durationMs: 3_000 }),
  runVerification: async (id) => ({ ok: true, detail: `${id} passed`, durationMs: 12_000 }),
};

await triage(restart);
await triage(migration);

async function triage(intent: Intent): Promise<void> {
  rule();
  console.log(`INTENT   ${intent.id} — ${intent.goal}`);
  console.log(`SOURCE   ${intent.source} (${intent.raisedBy})`);

  const impact = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, impact);

  console.log(
    `IMPACT   ${impact.structuralCount} structural nodes · magnitude ${impact.magnitude} · ${impact.domainsTouched.length} domains`,
  );
  console.log(
    `VERDICT  ${risk.tier.toUpperCase()}${risk.blocked ? ' · BLOCKED' : ''}${
      risk.requiresApproval ? ' · approval required' : ' · agent proceeds unattended'
    }`,
  );
  for (const reason of risk.reasons) console.log(`         · ${reason.detail}`);

  if (!risk.requiresApproval) {
    console.log('\nACTION   executed without interrupting anyone.\n');
    return;
  }

  const request = buildApprovalRequest(graph, intent, impact, risk);
  console.log('\nAPPROVAL REQUEST');
  console.log(`  operation     ${request.operation}`);
  console.log(`  reversible    ${request.reversibility.reversible ? 'yes' : 'no'} — ${request.reversibility.detail}`);
  console.log(`  data in scope ${request.dataInvolved.join(', ')}`);
  for (const system of request.affectedSystems.slice(0, 3)) {
    console.log(`  affected      ${system.name} (${system.confidence}) — ${system.why}`);
  }

  console.log('\n  [ human grants approval ]');

  const mirror = planMirror(graph, intent, impact);
  console.log('\nMIRROR');
  console.log(`  real          ${mirror.nodes.filter((n) => n.mode === 'real').length} node(s)`);
  console.log(`  snapshot      ${mirror.snapshotsRequired.join(', ') || 'none'}`);
  console.log(`  stubbed       ${mirror.nodes.filter((n) => n.mode === 'stub').length} node(s)`);
  console.log(`  safety        ${mirror.safetyViolations.length === 0 ? 'isolation invariants hold' : mirror.safetyViolations.join('; ')}`);

  const mechanical = await runMechanicalValidation(intent, mirror, passing);
  console.log(`\nMECHANICAL   ${mechanical.passed ? 'pass' : 'FAIL'} (${mechanical.checks.length} checks)`);

  const behavioral = await runBehavioralValidation({
    before: graph,
    after: loginAppGraph(),
    intent,
    impact,
    projectedAddedDailyCostUsd: 2.4,
    evaluator: {
      evaluateSuccessCondition: async () => ({
        verdict: 'met',
        reasoning: 'column present and written on all three authentication paths',
      }),
    },
  });
  console.log(`BEHAVIORAL   ${behavioral.passed ? 'pass' : 'FAIL'}`);
  for (const check of behavioral.checks) {
    console.log(`         ${check.status.padEnd(12)} ${check.name} — ${check.detail}`);
  }

  let record = openLineage({
    deploymentId: 'dep_042',
    baseRevision: 'rev_9f2c1a',
    intent,
    impact,
    risk,
    mirror,
    validation: [mechanical, behavioral],
    approval: {
      grantedBy: 'actor:human:owner',
      grantedAt: new Date().toISOString(),
      requestDigest: 'sha256:2b1f…',
    },
    rollback: {
      toDeploymentId: 'dep_041',
      unrecoverableNodes: impact.irreversible.map((n) => n.id),
      steps: ['redeploy dep_041', 'verify auth health', 'confirm column is additive and left in place'],
    },
  });

  const baseline: Baseline = { errorRate: 0.008, latencyP95Ms: 180, crashRate: 0.0004 };
  const observed: Record<string, StageEvidence> = {
    private: { errorRate: 0.008, latencyP95Ms: 182 },
    internal: { errorRate: 0.009, latencyP95Ms: 190, failedWorkflows: 0 },
    limited: { errorRate: 0.031, latencyP95Ms: 460, failedWorkflows: 37 },
  };

  console.log('\nPROGRESSIVE DEPLOYMENT');
  for (const stage of ['private', 'internal', 'limited'] as const) {
    const evidence = observed[stage]!;
    const decision = evaluatePromotion(stage, evidence, baseline);
    record = recordStage(record, {
      stage,
      enteredAt: new Date().toISOString(),
      evidence,
      decision,
    });
    console.log(`  ${stage.padEnd(9)} ${decision.verdict.padEnd(10)} ${decision.reasons[0]}`);
    if (decision.verdict === 'roll_back') break;
  }

  console.log(`\nOUTCOME  ${record.outcome}`);
  console.log(`  rollback     ${record.rollback.steps[0]}`);
  console.log(
    `  cannot undo  ${record.rollback.unrecoverableNodes.join(', ') || 'nothing — fully reversible'}`,
  );

  // The tests passed and production disagreed. That gap is the signal.
  const audit = auditPrediction(record, ['surface:screen:login', 'service:endpoint:rate_limit']);
  console.log('\nPREDICTION AUDIT');
  console.log(`  recall ${audit.recall.toFixed(2)} · precision ${audit.precision.toFixed(2)}`);
  if (audit.misses.length > 0) {
    console.log(`  unpredicted casualties: ${audit.misses.join(', ')}`);
    console.log('  → each one is a missing edge in the graph, not a bad deployment');
  }

  const costs: CostEvent[] = [
    { nodeId: 'service:api:auth_service', category: 'model_inference', usd: 61.2, at: new Date().toISOString(), detail: { retries: 4 } },
    { nodeId: 'service:api:auth_service', category: 'retrieval', usd: 9.4, at: new Date().toISOString() },
    { nodeId: 'surface:screen:login', category: 'compute', usd: 1.1, at: new Date().toISOString() },
  ];
  const report = attributeCosts(graph, costs);
  const hotspot = report.hotspots[0]!;
  const sustainability = assessSustainability(hotspot, {
    nodeId: hotspot.nodeId,
    dailyValueUsd: 22,
  });
  console.log('\nRUNTIME ECONOMICS');
  console.log(`  hotspot      ${hotspot.name} — $${hotspot.rolledUpUsd}/day rolled up`);
  console.log(`  verdict      ${sustainability.verdict} (${sustainability.ratio}x return)`);
  console.log(`  →            ${sustainability.recommendation}`);
  console.log();
}

function rule(): void {
  console.log('─'.repeat(78));
}
