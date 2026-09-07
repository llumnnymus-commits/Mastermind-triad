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
 * Run mechanical validation: does it build, start, connect, and pass the tests
 * attached to the nodes this change implicates.
 *
 * Ordering is not cosmetic. Each step is a precondition for the next being
 * meaningful — test failures in something that never started tell you nothing
 * about the change — so the run stops at the first failure rather than
 * producing a long report of consequences of one root cause.
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
    ['build', executor.build],
    ['start', executor.start],
    ['connect', executor.connect],
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
