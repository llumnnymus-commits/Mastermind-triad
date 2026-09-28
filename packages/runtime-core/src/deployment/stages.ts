import type { NodeId } from '../graph/nodes.js';

/**
 * Exposure stages. A deployment is a monitored experiment, not a release, so
 * the population is widened only while the evidence stays favorable.
 */
export const STAGES = ['private', 'internal', 'limited', 'full'] as const;
export type Stage = (typeof STAGES)[number];

export interface StageSpec {
  readonly stage: Stage;
  /** Share of the population exposed, 0–1. */
  readonly exposure: number;
  /** How long evidence must stay clean before the next stage opens. */
  readonly soakMinutes: number;
}

export const DEFAULT_STAGES: readonly StageSpec[] = [
  { stage: 'private', exposure: 0, soakMinutes: 5 },
  { stage: 'internal', exposure: 0.01, soakMinutes: 30 },
  { stage: 'limited', exposure: 0.1, soakMinutes: 120 },
  { stage: 'full', exposure: 1, soakMinutes: 0 },
];

/**
 * The live signals a stage is judged on.
 *
 * `undefined` means not reported, which is deliberately different from zero:
 * a metric nobody is emitting cannot be evidence that a change is healthy.
 */
export interface StageEvidence {
  readonly errorRate?: number;
  readonly latencyP95Ms?: number;
  readonly crashRate?: number;
  readonly failedWorkflows?: number;
  readonly securityAnomalies?: number;
  readonly abandonmentRate?: number;
  readonly modelQuality?: number;
  readonly addedDailyCostUsd?: number;
}

/** The baseline the change is measured against, captured before exposure. */
export interface Baseline {
  readonly errorRate: number;
  readonly latencyP95Ms: number;
  readonly crashRate: number;
  readonly abandonmentRate?: number;
  readonly modelQuality?: number;
}

export interface PromotionGate {
  /** Multiple of baseline error rate that halts promotion. Default 1.5. */
  readonly errorRateMultiplier?: number;
  /** Multiple of baseline p95 latency that halts promotion. Default 1.3. */
  readonly latencyMultiplier?: number;
  /** Multiple of baseline crash rate that halts promotion. Default 1.2. */
  readonly crashRateMultiplier?: number;
  /** Absolute cap on added operating cost per day. */
  readonly maxAddedDailyCostUsd?: number;
  /** Minimum acceptable model quality, where reported. */
  readonly minModelQuality?: number;
}

export type PromotionVerdict = 'promote' | 'hold' | 'roll_back';

export interface PromotionDecision {
  readonly verdict: PromotionVerdict;
  readonly reasons: readonly string[];
  readonly nextStage?: Stage;
}

/**
 * Decide whether a stage's evidence justifies widening exposure.
 *
 * Three outcomes rather than two. `hold` is what a stage gets when nothing is
 * wrong but nothing has been proven either — the soak has not elapsed, or a
 * signal the gate depends on is not being reported. Collapsing `hold` into
 * `promote` is how a change with no telemetry rolls to everyone; collapsing it
 * into `roll_back` makes the runtime thrash on ordinary quiet periods.
 */
export function evaluatePromotion(
  current: Stage,
  evidence: StageEvidence,
  baseline: Baseline,
  gate: PromotionGate = {},
  soakElapsedMinutes = Number.POSITIVE_INFINITY,
  stages: readonly StageSpec[] = DEFAULT_STAGES,
): PromotionDecision {
  const errorMult = gate.errorRateMultiplier ?? 1.5;
  const latencyMult = gate.latencyMultiplier ?? 1.3;
  const crashMult = gate.crashRateMultiplier ?? 1.2;

  const regressions: string[] = [];

  if (evidence.errorRate !== undefined && evidence.errorRate > baseline.errorRate * errorMult) {
    regressions.push(
      `error rate ${evidence.errorRate} exceeds ${errorMult}x baseline ${baseline.errorRate}`,
    );
  }
  if (
    evidence.crashRate !== undefined &&
    evidence.crashRate > baseline.crashRate * crashMult
  ) {
    regressions.push(
      `crash rate ${evidence.crashRate} exceeds ${crashMult}x baseline ${baseline.crashRate}`,
    );
  }
  if (evidence.securityAnomalies !== undefined && evidence.securityAnomalies > 0) {
    regressions.push(`${evidence.securityAnomalies} security anomal(ies) observed`);
  }
  if (
    evidence.latencyP95Ms !== undefined &&
    evidence.latencyP95Ms > baseline.latencyP95Ms * latencyMult
  ) {
    regressions.push(
      `p95 latency ${evidence.latencyP95Ms}ms exceeds ${latencyMult}x baseline ${baseline.latencyP95Ms}ms`,
    );
  }
  if (
    gate.maxAddedDailyCostUsd !== undefined &&
    evidence.addedDailyCostUsd !== undefined &&
    evidence.addedDailyCostUsd > gate.maxAddedDailyCostUsd
  ) {
    regressions.push(
      `added cost $${evidence.addedDailyCostUsd}/day exceeds the $${gate.maxAddedDailyCostUsd}/day ceiling`,
    );
  }
  if (
    gate.minModelQuality !== undefined &&
    evidence.modelQuality !== undefined &&
    evidence.modelQuality < gate.minModelQuality
  ) {
    regressions.push(
      `model quality ${evidence.modelQuality} is below the ${gate.minModelQuality} floor`,
    );
  }

  if (regressions.length > 0) return { verdict: 'roll_back', reasons: regressions };

  const spec = stages.find((s) => s.stage === current);
  if (spec !== undefined && soakElapsedMinutes < spec.soakMinutes) {
    return {
      verdict: 'hold',
      reasons: [`soak incomplete: ${soakElapsedMinutes} of ${spec.soakMinutes} minutes elapsed`],
    };
  }

  // A stage with no reported evidence has not demonstrated anything. Widening
  // exposure on silence is indistinguishable from widening it on success right
  // up until the moment it isn't.
  const reported = Object.values(evidence).filter((v) => v !== undefined).length;
  if (reported === 0) {
    return {
      verdict: 'hold',
      reasons: ['no evidence reported for this stage — nothing has been demonstrated'],
    };
  }

  const index = stages.findIndex((s) => s.stage === current);
  const next = stages[index + 1];
  if (next === undefined) {
    return { verdict: 'promote', reasons: ['already at full exposure'] };
  }

  return {
    verdict: 'promote',
    reasons: [`${reported} signal(s) within tolerance across a completed soak`],
    nextStage: next.stage,
  };
}

export interface RollbackPlan {
  /** The deployment this returns to. */
  readonly toDeploymentId: string;
  /** Nodes rollback cannot restore — the honest limit of the undo. */
  readonly unrecoverableNodes: readonly NodeId[];
  readonly steps: readonly string[];
}
