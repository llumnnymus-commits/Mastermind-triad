# @lbr/runtime-core

The Live Build Runtime substrate: the project graph, intent objects, impact resolution, and the authority gate.

An application under this runtime is never "finished, packaged, shipped." It stays connected to a layer that knows how it is built, what is running, what depends on what, what rules constrain it, and what happens when something changes. This package is the foundation that layer queries.

## What is implemented

| Piece | Status |
| --- | --- |
| Seven-domain project graph (code, surface, service, infra, policy, evidence, actor) | ✅ |
| Edge semantics with directional propagation | ✅ |
| Intent objects (goal, rationale, scope, success condition, hard limits) | ✅ |
| Impact resolution across all domains | ✅ |
| Authority gate — risk tiers, approval objects | ✅ |
| Isolated mirror environments | not yet |
| Mechanical + behavioral validation | not yet |
| Progressive deployment and lineage | not yet |
| Cost attribution | not yet |

## Try it

```bash
npm install
npm test --workspace @lbr/runtime-core
npx tsx packages/runtime-core/src/demo.ts
```

The demo runs two intents against the same graph. They implicate a nearly identical set of nodes — 11 structural nodes, magnitude 0.85 versus 0.865 — and receive opposite verdicts: the restart proceeds unattended, the migration stops for a human. A node-count threshold cannot tell those apart. That difference is the reason this package exists.

## The three design decisions that matter

### 1. Impact is directional

Every edge is read as a sentence: `login_screen --depends_on--> auth_service`. Two different questions get asked of it, and they have different answers.

- **Blast** — "auth_service is changing; what breaks?" Walk *inbound*. The login screen depends on auth, so the login screen is at risk. This is the direction that causes outages.
- **Context** — "login_screen is changing; what does it rely on?" Walk *outbound*. Auth is context the change must respect, but changing a screen rarely breaks the service under it.

Blast weights are high and context weights are low for the same edge type. Collapsing them into one number is what makes naive impact analysis either miss real breakage or flag the entire codebase.

The walk is a max-product relaxation, so a node reachable by both a weak and a strong path settles on the strong one — anything else understates the blast radius.

### 2. Policy binds at the strength of what it governs; verification does not

A policy attached to a node that is barely implicated is barely relevant. Attaching every reachable policy at full weight makes a data-retention rule bind a worker restart, and a gate that fires on everything is a gate people learn to click past. So a constraint inherits the score of the node it governs — the `governed_by` hop itself costs nothing, but distance to the governed node still counts.

Verification is deliberately asymmetric: tests attach at full weight regardless of distance. An unnecessary test costs seconds; a skipped one costs an outage.

A policy may declare `appliesToActions`. A PII retention rule governs schema migrations and data deletion — it has no opinion about whether a worker may be restarted.

### 3. Graph reach is not a risk signal for transient actions

Restarting a rate limiter that three live surfaces depend on has the same blast radius as migrating the schema underneath them. The graph alone cannot separate those, because the difference is not structural: a restart interrupts and recovers, a migration does not.

So wholly transient actions (`restart`, `rollback`, `cache_clear`, `flag_toggle`, `read`) are judged on policy and declared limits only, not on reach. This is what preserves the runtime's ability to repair itself unattended, which is most of why it exists. A policy can still override by naming the action class explicitly.

## The governance lock, defined

The source specification says: *"If NodesChanged > Threshold, trigger UserApprovalRequest."* That is not implementable as written — it presumes you already know which nodes a change touches, and that answer depends entirely on which direction you walk each edge.

What is implemented instead takes four inputs:

1. **Action class** — a baseline per action, independent of the graph. Deleting data is dangerous against a small blast radius; a config edit is routine except on a live payment path.
2. **Governing policy** — a policy in the constraint set can demand approval on its own authority, filtered by relevance and by whether it governs the action being performed.
3. **Graph-derived risk** — irreversible nodes in scope, live nodes in the blast radius, aggregate magnitude. Skipped for transient actions.
4. **Declared limits** — the intent's own bounds. Crossing these produces `blocked`, which is a refusal rather than an approval prompt: the change asked not to be allowed to do this.

## The approval request

Every field derives from the graph rather than from the agent's account of what it is about to do. "The agent would like to modify the database" is not authorization — the person approving cannot see what is at stake. The request answers: what will happen, why, what is affected and why each thing is implicated, what data is in scope, what could go wrong, whether it can be undone, which policies bind it, and what will be run to verify it.

Implication paths render in the edge vocabulary — `auth_service writes to users` — rather than a generic "connected to," because the distinction between a screen that calls a service and a service that writes to a table is the whole content of the warning.

## Layout

```
src/
  graph/     domains, edge semantics, node schemas, the store
  intent/    intent objects and action classes
  impact/    the resolution walk
  policy/    risk classification and approval requests
  fixtures/  the login-workflow graph from the specification
```

The `ProjectGraph` interface is deliberately narrow — `node`, `inbound`, `outbound` — because that is the entire surface impact resolution needs, which is what will let the store move to a persistent backend without touching the engine.
