import { ProjectGraph } from '../graph/graph.js';

/**
 * The login-workflow graph.
 *
 * This fixture exists because the specification names this exact scenario as
 * the test of whether impact analysis is real:
 *
 *   "If an agent proposes changing a login workflow, the runtime should not
 *    look only at the visible login-screen code. It should identify the
 *    authentication service, session-token rules, database fields, rate
 *    limits, account-recovery flow, permissions, telemetry, browser tests,
 *    mobile tests, and rollback strategy that are connected to that workflow."
 *
 * Every one of those is a node here, and the test suite asserts the walk finds
 * each of them from a single-node intent. The PII retention policy is
 * deliberately three hops away behind a weak context path — it should still
 * bind the change at full weight, because policy does not decay with distance.
 */
export function loginAppGraph(): ProjectGraph {
  return ProjectGraph.from(
    [
      // ---- product surface ------------------------------------------------
      { id: 'surface:screen:login', kind: 'screen', name: 'Login screen', live: true },
      { id: 'surface:screen:profile', kind: 'screen', name: 'Profile screen', live: true },
      {
        id: 'surface:flow:account_recovery',
        kind: 'flow',
        name: 'Account recovery flow',
        live: true,
      },

      // ---- code -----------------------------------------------------------
      { id: 'code:module:login_view', kind: 'module', name: 'LoginView module' },

      // ---- services and data ----------------------------------------------
      {
        id: 'service:api:auth_service',
        kind: 'api',
        name: 'Authentication service',
        live: true,
      },
      {
        id: 'service:contract:session_token',
        kind: 'contract',
        name: 'Session token rules',
      },
      { id: 'service:endpoint:rate_limit', kind: 'endpoint', name: 'Auth rate limiter', live: true },
      { id: 'service:table:users', kind: 'table', name: 'users table', live: true },
      {
        id: 'service:database:accounts',
        kind: 'database',
        name: 'Accounts database',
        live: true,
        irreversible: true,
        attributes: { engine: 'postgres', containsPii: true },
      },

      // ---- infrastructure --------------------------------------------------
      {
        id: 'infra:network_permission:auth_ingress',
        kind: 'network_permission',
        name: 'Auth ingress permission',
        live: true,
      },
      {
        id: 'infra:deploy_target:prod_cluster',
        kind: 'deploy_target',
        name: 'Production cluster',
        live: true,
      },

      // ---- policy ----------------------------------------------------------
      {
        id: 'policy:safety_rule:session_expiry',
        kind: 'safety_rule',
        name: 'Session expiry rule',
        attributes: { maxSessionHours: 24 },
      },
      {
        id: 'policy:retention_rule:pii_retention',
        kind: 'retention_rule',
        name: 'PII retention rule',
        attributes: {
          requiresApproval: true,
          retentionDays: 90,
          // The rule governs anything that changes how account data is shaped,
          // stored, or handled — and deliberately not the operational actions
          // (restart, rollback, cache clear) that leave the data untouched.
          appliesToActions: [
            'schema_migration',
            'data_delete',
            'data_collection_expansion',
            'code_change',
            'config_change',
          ],
        },
      },

      // ---- evidence ---------------------------------------------------------
      { id: 'evidence:test:browser_login', kind: 'test', name: 'Browser login test' },
      { id: 'evidence:test:mobile_login', kind: 'test', name: 'Mobile login test' },
      { id: 'evidence:test:auth_service', kind: 'test', name: 'Auth service test suite' },
      { id: 'evidence:trace:auth_latency', kind: 'trace', name: 'Auth latency telemetry' },

      // ---- actors -----------------------------------------------------------
      { id: 'actor:agent:repair_agent', kind: 'agent', name: 'Repair agent' },
      { id: 'actor:human:owner', kind: 'human', name: 'Product owner' },
    ],
    [
      // What depends on auth — the blast radius when it changes.
      { from: 'surface:screen:login', type: 'depends_on', to: 'service:api:auth_service' },
      { from: 'surface:screen:profile', type: 'depends_on', to: 'service:api:auth_service' },
      { from: 'surface:flow:account_recovery', type: 'depends_on', to: 'service:api:auth_service' },
      { from: 'code:module:login_view', type: 'implements', to: 'surface:screen:login' },
      {
        from: 'infra:network_permission:auth_ingress',
        type: 'configures',
        to: 'service:api:auth_service',
      },

      // What auth relies on — context the change must respect.
      { from: 'service:api:auth_service', type: 'implements', to: 'service:contract:session_token' },
      { from: 'service:api:auth_service', type: 'depends_on', to: 'service:endpoint:rate_limit' },
      { from: 'service:api:auth_service', type: 'writes', to: 'service:table:users' },
      { from: 'service:table:users', type: 'part_of', to: 'service:database:accounts' },
      { from: 'service:api:auth_service', type: 'deployed_to', to: 'infra:deploy_target:prod_cluster' },

      // Policy binds regardless of distance.
      { from: 'service:api:auth_service', type: 'governed_by', to: 'policy:safety_rule:session_expiry' },
      { from: 'service:database:accounts', type: 'governed_by', to: 'policy:retention_rule:pii_retention' },

      // Proof obligations.
      { from: 'surface:screen:login', type: 'verified_by', to: 'evidence:test:browser_login' },
      { from: 'surface:screen:login', type: 'verified_by', to: 'evidence:test:mobile_login' },
      { from: 'service:api:auth_service', type: 'verified_by', to: 'evidence:test:auth_service' },

      // Telemetry and attribution.
      { from: 'evidence:trace:auth_latency', type: 'observes', to: 'service:api:auth_service' },
      { from: 'surface:screen:login', type: 'authored_by', to: 'actor:human:owner' },
    ],
  );
}
