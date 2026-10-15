import type { NodeId } from '../graph/nodes.js';

export const CHECK_STATUSES = ['pass', 'fail', 'skipped', 'inconclusive'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly nodes?: readonly NodeId[];
  readonly durationMs?: number;
}

export interface ValidationReport {
  readonly intentId: string;
  readonly stage: 'mechanical' | 'behavioral';
  readonly checks: readonly CheckResult[];
  readonly passed: boolean;
}

export function summarize(
  intentId: string,
  stage: ValidationReport['stage'],
  checks: readonly CheckResult[],
): ValidationReport {
  return {
    intentId,
    stage,
    checks,
    // `inconclusive` deliberately does not pass. A check that could not reach a
    // verdict is not evidence that a change is safe, and treating it as one is
    // how an unavailable eval harness silently becomes a green light.
    passed: checks.every((c) => c.status === 'pass' || c.status === 'skipped'),
  };
}
