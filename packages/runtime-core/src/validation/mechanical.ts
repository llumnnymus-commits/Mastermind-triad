import type { NodeId } from '../graph/nodes.js';
import type { Intent } from '../intent/intent.js';
import type { MirrorPlan } from '../mirror/plan.js';
import { summarize, type CheckResult, type ValidationReport } from './types.js';

/**
 * The side of validation that touches real infrastructure.
 *
 * Kept behind an interface so the runtime's own logic — which checks run, in
 * what order, what a failure means — is testable without a container runtime.
 * An implementation of this is a build worker; everything else in this package
 * stays pure.
 */
export interface MirrorExecutor {
  build(plan: MirrorPlan): Promise<ExecutionOutcome>;
  start(plan: MirrorPlan): Promise<ExecutionOutcome>;
  /** Confirms the materialized nodes can reach the ones they depend on. */
  connect(plan: MirrorPlan): Promise<ExecutionOutcome>;
  /** Runs one test or evaluation node from the verification plan. */
  runVerification(id: NodeId, plan: MirrorPlan): Promise<ExecutionOutcome>;
}

export interface ExecutionOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly durationMs?: number;
}

/**
 * Run mechanical validation: is the mirror what the plan asked for, does it
 * build and start, and does it pass the tests attached to the nodes this
 * change implicates.
 *
 * Ordering is not cosmetic. Each step is a precondition for the next being
 * meaningful — test failures in something that never started tell you nothing
 * about the change — so the run stops at the first failure rather than
 * producing a long report of consequences of one root cause.
 *
 * `connect` comes first, and that ordering is a safety property rather than a
 * preference. It is the step that confirms the mirror actually satisfies the
 * plan — every node the plan wanted materialized is present, and no caveat
 * means the isolation the plan assumed was never established. `build` runs the
 * project's own scripts, which on an ingested third-party repository is
 * running somebody else's code. Checking the mirror afterwards would mean the
 * untrusted code had already run inside an environment nothing had verified,
 * so a caller that gates on those caveats would be gating after the fact.
 */
export async function runMechanicalValidation(
  intent: Intent,
  plan: MirrorPlan,
  executor: MirrorExecutor,
): Promise<ValidationReport> {
  const checks: CheckResult[] = [];

  if (plan.safetyViolations.length > 0) {
    checks.push({
      name: 'mirror safety',
      status: 'fail',
      detail: `mirror plan violates isolation invariants: ${plan.safetyViolations.join('; ')}`,
    });
    return summarize(intent.id, 'mechanical', checks);
  }

  for (const [name, run] of [
    ['connect', executor.connect],
    ['build', executor.build],
    ['start', executor.start],
  ] as const) {
    const outcome = await run.call(executor, plan);
    checks.push({
      name,
      status: outcome.ok ? 'pass' : 'fail',
      detail: outcome.detail,
      durationMs: outcome.durationMs,
    });
    if (!outcome.ok) return summarize(intent.id, 'mechanical', checks);
  }

  if (plan.verificationPlan.length === 0) {
    checks.push({
      name: 'verification coverage',
      status: 'inconclusive',
      detail: 'no tests or evaluations are attached to any implicated node',
    });
  }

  for (const id of plan.verificationPlan) {
    const outcome = await executor.runVerification(id, plan);
    checks.push({
      name: `verify ${id}`,
      status: outcome.ok ? 'pass' : 'fail',
      detail: outcome.detail,
      nodes: [id],
      durationMs: outcome.durationMs,
    });
  }

  return summarize(intent.id, 'mechanical', checks);
}
