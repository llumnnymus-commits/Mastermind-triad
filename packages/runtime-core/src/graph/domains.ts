/**
 * The seven domains of the project graph.
 *
 * The point of the graph is that these are one queryable structure rather than
 * seven separate tools. Impact analysis on a real change needs all of them at
 * once: a login-workflow change touches code, the product surface, the auth
 * service, the data it reads, the policy governing session handling, the tests
 * that prove it still works, and the record of who is allowed to approve it.
 */
export const DOMAINS = [
  /** Modules, functions, packages, libraries, repositories. */
  'code',
  /** UI screens, interaction flows, product features, accessibility behavior. */
  'surface',
  /** APIs, events, schemas, contracts, queues, workers, databases, caches, model endpoints. */
  'service',
  /** Containers, deploy targets, compute, domains, secrets, env vars, network permissions. */
  'infra',
  /** Safety rules, retention, approval requirements, audit, financial limits, consent boundaries. */
  'policy',
  /** Tests, benchmarks, evals, incidents, logs, traces, security findings, deployment outcomes. */
  'evidence',
  /** Humans and agents: who proposed, authored, deployed, approved. */
  'actor',
] as const;

export type Domain = (typeof DOMAINS)[number];

/**
 * Node kinds, grouped by the domain that owns them.
 *
 * Kinds are deliberately concrete. A generic "node" carries no information the
 * impact engine can use; knowing something is a `database` rather than a
 * `screen` is what lets the risk classifier decide a migration needs approval
 * while a copy change does not.
 */
export const NODE_KINDS = {
  code: ['repository', 'package', 'module', 'function', 'library'],
  surface: ['screen', 'component', 'flow', 'feature', 'accessibility_rule'],
  service: [
    'api',
    'endpoint',
    'event',
    'schema',
    'contract',
    'queue',
    'worker',
    'database',
    'table',
    'cache',
    'model_endpoint',
    'external_service',
  ],
  infra: [
    'container',
    'deploy_target',
    'compute_resource',
    'domain',
    'secret',
    'env_var',
    'network_permission',
  ],
  policy: [
    'safety_rule',
    'retention_rule',
    'approval_requirement',
    'audit_requirement',
    'financial_limit',
    'consent_boundary',
  ],
  evidence: [
    'test',
    'benchmark',
    'evaluation',
    'incident',
    'log_stream',
    'trace',
    'security_finding',
    'deployment_outcome',
  ],
  actor: ['human', 'agent', 'system'],
} as const satisfies Record<Domain, readonly string[]>;

export type NodeKind = (typeof NODE_KINDS)[Domain][number];

/** Reverse index: which domain owns a given node kind. */
const KIND_TO_DOMAIN = new Map<string, Domain>();
for (const domain of DOMAINS) {
  for (const kind of NODE_KINDS[domain]) {
    KIND_TO_DOMAIN.set(kind, domain);
  }
}

export function domainOfKind(kind: string): Domain | undefined {
  return KIND_TO_DOMAIN.get(kind);
}

export function isNodeKind(kind: string): kind is NodeKind {
  return KIND_TO_DOMAIN.has(kind);
}
