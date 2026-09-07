/**
 * Walk one intent through the substrate and print what the runtime knows.
 *
 *   npx tsx packages/runtime-core/src/demo.ts
 *
 * The point of the demo is the difference between the two intents below. They
 * touch overlapping parts of the same graph; one is handled unattended and one
 * stops for a human, and the reason is visible rather than asserted.
 */
import { loginAppGraph } from './fixtures/login-app.js';
import { parseIntent, type Intent } from './intent/intent.js';
import { resolveImpact } from './impact/resolve.js';
import { classifyRisk } from './policy/risk.js';
import { buildApprovalRequest } from './policy/approval.js';

const graph = loginAppGraph();

const intents: Intent[] = [
  parseIntent({
    id: 'intent_restart',
    goal: 'Restart the auth rate limiter after three failed health checks',
    rationale: 'Health probe has been failing for 4 minutes; restart is the standard remedy',
    source: 'incident',
    raisedBy: 'actor:agent:repair_agent',
    targets: ['service:endpoint:rate_limit'],
    actions: ['restart'],
    successCondition: 'Health check passes within 60s and auth error rate returns to baseline',
  }),
  parseIntent({
    id: 'intent_migration',
    goal: 'Add a last_login_at column to the users table',
    rationale: 'Security review requires dormant-session expiry, which needs a last-login timestamp',
    source: 'agent',
    raisedBy: 'actor:agent:repair_agent',
    targets: ['service:table:users'],
    actions: ['schema_migration'],
    successCondition: 'Column exists, is backfilled, and every authentication writes it',
    limits: { forbidIrreversible: false, maxAddedDailyCostUsd: 5 },
  }),
];

for (const intent of intents) {
  const impact = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, impact);

  line();
  console.log(`INTENT  ${intent.id} — ${intent.goal}`);
  console.log(`SOURCE  ${intent.source} (${intent.raisedBy})`);
  console.log(
    `IMPACT  ${impact.structuralCount} structural nodes · magnitude ${impact.magnitude} · domains: ${impact.domainsTouched.join(', ')}`,
  );

  if (impact.blastRadius.length > 0) {
    console.log('\nBLAST RADIUS (what breaks if this is wrong)');
    for (const node of impact.blastRadius.slice(0, 6)) {
      console.log(
        `  ${pad(node.score.toFixed(2))} ${node.node.name}${node.node.live ? ' [live]' : ''}`,
      );
    }
  }

  if (impact.constraints.length > 0) {
    console.log('\nGOVERNED BY');
    for (const policy of impact.constraints) {
      const gates = policy.node.attributes['requiresApproval'] === true ? ' — requires approval' : '';
      console.log(`  ${pad(policy.score.toFixed(2))} ${policy.node.name}${gates}`);
    }
  }

  if (impact.verifications.length > 0) {
    console.log('\nMUST PASS');
    for (const test of impact.verifications) console.log(`         ${test.node.name}`);
  }

  console.log(
    `\nVERDICT ${risk.tier.toUpperCase()}${risk.blocked ? ' · BLOCKED' : ''}${
      risk.requiresApproval ? ' · approval required' : ' · agent may proceed unattended'
    }`,
  );
  for (const reason of risk.reasons) console.log(`  · ${reason.detail}`);

  if (risk.requiresApproval) {
    const request = buildApprovalRequest(graph, intent, impact, risk);
    console.log('\nAPPROVAL REQUEST');
    console.log(`  operation      ${request.operation}`);
    console.log(`  why            ${request.rationale}`);
    console.log(`  success means  ${request.successCondition}`);
    console.log(`  data in scope  ${request.dataInvolved.join(', ') || 'none'}`);
    console.log(`  reversible     ${request.reversibility.reversible ? 'yes' : 'no'} — ${request.reversibility.detail}`);
    console.log('  risks');
    for (const risk of request.risks) console.log(`    - ${risk}`);
    console.log('  affected');
    for (const system of request.affectedSystems.slice(0, 5)) {
      console.log(`    - ${system.name} (${system.confidence}) — ${system.why}`);
    }
  }
  console.log();
}

function line(): void {
  console.log('─'.repeat(78));
}

function pad(value: string): string {
  return value.padStart(6);
}
