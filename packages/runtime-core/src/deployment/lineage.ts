import type { NodeId } from '../graph/nodes.js';
import type { Intent } from '../intent/intent.js';
import type { ImpactResult } from '../impact/resolve.js';
import type { RiskAssessment } from '../policy/risk.js';
import type { ValidationReport } from '../validation/types.js';
import type { MirrorPlan } from '../mirror/plan.js';
import type { Stage, StageEvidence, RollbackPlan, PromotionDecision } from './stages.js';

/**
 * The lineage record.
 *
 * Every field the specification requires a deployed version to carry: what it
 * was built from, why it was proposed, what was involved, what was tested,
 * what risks were identified, who approved it, where it ran, what the live
 * evidence showed, and how to undo it.
 *
 * The reason to keep this as one object rather than rows scattered across a
 * CI system, a monitoring tool and a chat thread is that it is the runtime's
 * only route to learning. "Which kinds of change are reliably safe here" is a
 * query over accumulated lineage; it is unanswerable if the record of what was
 * proposed, what was predicted, and what actually happened lives in three
 * systems that cannot be joined.
 */
export interface LineageRecord {
  readonly deploymentId: string;
  /** The graph revision this was built from. */
  readonly baseRevision: string;
  readonly intent: Intent;
  /** What the impact walk predicted before anything was written. */
  readonly predictedImpact: ImpactPrediction;
  readonly risk: RiskAssessment;
  readonly approval?: ApprovalRecord;
  readonly mirror: MirrorSummary;
  readonly validation: readonly ValidationReport[];
  readonly stages: readonly StageRecord[];
  readonly rollback: RollbackPlan;
  readonly createdAt: string;
  readonly outcome: DeploymentOutcome;
}

export type DeploymentOutcome = 'in_progress' | 'deployed' | 'rolled_back' | 'abandoned';

export interface ImpactPrediction {
  readonly structuralCount: number;
  readonly magnitude: number;
  readonly blastRadius: readonly NodeId[];
  readonly constraints: readonly NodeId[];
  readonly verifications: readonly NodeId[];
  readonly domainsTouched: readonly string[];
}

export interface ApprovalRecord {
  readonly grantedBy: NodeId;
  readonly grantedAt: string;
  /** What was shown at the moment of approval, so consent is auditable. */
  readonly requestDigest: string;
}

export interface MirrorSummary {
  readonly realNodes: readonly NodeId[];
  readonly copiedNodes: readonly NodeId[];
  readonly stubbedNodes: readonly NodeId[];
}

export interface StageRecord {
  readonly stage: Stage;
  readonly enteredAt: string;
  readonly evidence: StageEvidence;
  readonly decision: PromotionDecision;
}

export interface OpenLineageInput {
  readonly deploymentId: string;
  readonly baseRevision: string;
  readonly intent: Intent;
  readonly impact: ImpactResult;
  readonly risk: RiskAssessment;
  readonly mirror: MirrorPlan;
  readonly validation: readonly ValidationReport[];
  readonly rollback: RollbackPlan;
  readonly approval?: ApprovalRecord;
}

/**
 * Open a lineage record at the moment a change becomes a deployment candidate.
 *
 * Opened before exposure rather than written after it: the prediction has to be
 * captured while it is still a prediction. A blast radius recorded after the
 * incident is a description of the incident, and comparing the two is the whole
 * mechanism by which the runtime learns that its own analysis was wrong.
 */
export function openLineage(input: OpenLineageInput): LineageRecord {
  return {
    deploymentId: input.deploymentId,
    baseRevision: input.baseRevision,
    intent: input.intent,
    predictedImpact: {
      structuralCount: input.impact.structuralCount,
      magnitude: input.impact.magnitude,
      blastRadius: input.impact.blastRadius.map((n) => n.id),
      constraints: input.impact.constraints.map((n) => n.id),
      verifications: input.impact.verifications.map((n) => n.id),
      domainsTouched: input.impact.domainsTouched,
    },
    risk: input.risk,
    approval: input.approval,
    mirror: {
      realNodes: input.mirror.nodes.filter((n) => n.mode === 'real').map((n) => n.id),
      copiedNodes: input.mirror.nodes.filter((n) => n.mode === 'copy').map((n) => n.id),
      stubbedNodes: input.mirror.nodes.filter((n) => n.mode === 'stub').map((n) => n.id),
    },
    validation: input.validation,
    stages: [],
    rollback: input.rollback,
    createdAt: new Date().toISOString(),
    outcome: 'in_progress',
  };
}

export function recordStage(record: LineageRecord, stage: StageRecord): LineageRecord {
  const outcome: DeploymentOutcome =
    stage.decision.verdict === 'roll_back'
      ? 'rolled_back'
      : stage.stage === 'full' && stage.decision.verdict === 'promote'
        ? 'deployed'
        : 'in_progress';
  return { ...record, stages: [...record.stages, stage], outcome };
}

/**
 * Was the prediction right?
 *
 * Run after the fact against what actually broke. A change whose real
 * casualties were never in the predicted blast radius means the graph is
 * missing an edge — which is a defect in the graph, not in the deployment, and
 * is the signal worth acting on.
 */
export interface PredictionAudit {
  readonly deploymentId: string;
  /** Predicted and did break. */
  readonly hits: readonly NodeId[];
  /** Broke without being predicted — each one is a missing edge in the graph. */
  readonly misses: readonly NodeId[];
  /** Predicted and did not break. */
  readonly falseAlarms: readonly NodeId[];
  readonly recall: number;
  readonly precision: number;
}

export function auditPrediction(
  record: LineageRecord,
  actuallyAffected: readonly NodeId[],
): PredictionAudit {
  const predicted = new Set(record.predictedImpact.blastRadius);
  const actual = new Set(actuallyAffected);

  const hits = [...actual].filter((id) => predicted.has(id));
  const misses = [...actual].filter((id) => !predicted.has(id));
  const falseAlarms = [...predicted].filter((id) => !actual.has(id));

  return {
    deploymentId: record.deploymentId,
    hits,
    misses,
    falseAlarms,
    recall: actual.size === 0 ? 1 : hits.length / actual.size,
    precision: predicted.size === 0 ? 1 : hits.length / predicted.size,
  };
}
