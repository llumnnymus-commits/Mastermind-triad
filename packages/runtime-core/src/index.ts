/**
 * Live Build Runtime — core substrate.
 *
 * Build order, per the plan: the graph and the intent/impact loop come first,
 * because everything else in the runtime is a query against them. Currently
 * implemented: the seven-domain graph, intent objects, impact resolution, and
 * the authority gate. Isolation, validation, deployment/lineage, and cost
 * attribution build on this and are not here yet.
 */

// The graph
export { DOMAINS, NODE_KINDS, domainOfKind, isNodeKind } from './graph/domains.js';
export type { Domain, NodeKind } from './graph/domains.js';
export {
  EDGE_TYPES,
  EDGE_TYPE_NAMES,
  EDGE_ROLES,
  isEdgeType,
  semanticsOf,
  isNonDecaying,
} from './graph/edges.js';
export type { EdgeType, EdgeRole, EdgeSemantics } from './graph/edges.js';
export {
  GraphNodeSchema,
  GraphEdgeSchema,
  NodeIdSchema,
  domainOf,
  makeNodeId,
} from './graph/nodes.js';
export type { GraphNode, GraphEdge, NodeId } from './graph/nodes.js';
export { ProjectGraph } from './graph/graph.js';
export type { AdjacentEdge } from './graph/graph.js';

// Intent
export {
  IntentSchema,
  IntentLimitsSchema,
  INTENT_SOURCES,
  ACTION_CLASSES,
  parseIntent,
} from './intent/intent.js';
export type { Intent, IntentLimits, IntentSource, ActionClass } from './intent/intent.js';

// Impact
export { resolveImpact } from './impact/resolve.js';
export type {
  ImpactResult,
  ImpactedNode,
  Relation,
  PathStep,
  LimitViolation,
  ResolveOptions,
} from './impact/resolve.js';

// Authority
export { classifyRisk, baselineRiskOf, RISK_TIERS } from './policy/risk.js';
export type { RiskAssessment, RiskReason, RiskTier } from './policy/risk.js';
export { buildApprovalRequest, explainPath } from './policy/approval.js';
export type { ApprovalRequest, AffectedSystem, Reversibility } from './policy/approval.js';

// Fixtures
export { loginAppGraph } from './fixtures/login-app.js';
