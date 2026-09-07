# @lbr/runtime-core

The Live Build Runtime substrate: the project graph, the intent-to-deployment loop, the authority gate, and runtime economics.

An application under this runtime is never "finished, packaged, shipped." It stays connected to a layer that knows how it is built, what is running, what depends on what, what rules constrain it, and what happens when something changes. This package is the foundation that layer queries.

## What is implemented

| Piece | Status |
| --- | --- |
| Seven-domain project graph (code, surface, service, infra, policy, evidence, actor) | ✅ |
| Edge semantics with directional propagation | ✅ |
| Intent objects (goal, rationale, scope, success condition, hard limits) | ✅ |
| Impact resolution across all domains | ✅ |
| Authority gate — risk tiers, approval objects | ✅ |
| Isolated mirror environments | ✅ |
| Mechanical + behavioral validation | ✅ |
| Progressive deployment and lineage | ✅ |
| Cost attribution and sustainability | ✅ |
| Executor implementations (real build workers, real evaluators) | interfaces only |
| Persistent graph store | in-memory only |

## Try it

```bash
npm install
npm test --workspace @lbr/runtime-core
npx tsx packages/runtime-core/src/demo.ts
```

The demo runs two intents through the whole loop against the same graph. They implicate a nearly identical set of nodes — 11 structural nodes, magnitude 0.85 versus 0.865 — and receive opposite verdicts: the restart proceeds unattended; the migration stops for approval, is validated in an isolated mirror, deploys progressively, and is rolled back at 10% exposure when production disagrees with the tests. A node-count threshold cannot tell those two intents apart. That difference is the reason this package exists.

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

## The rest of the loop

### Isolation is sized from the impact walk

Mirroring everything is a staging environment: expensive, slow, and drifting. Mirroring nothing is a unit test, which cannot see integration breakage. The impact walk already computed which slice matters, so each node gets a materialization decision — `real`, `copy`, `stub`, or `excluded` — with a stated reason.

One invariant outranks every sizing decision: **a mirror is never bound to live irreversible state.** A node that is both `live` and `irreversible` is restored from a snapshot or left out, whatever its confidence, and a plan that would do otherwise fails `safetyViolations` before anything runs. Third-party services are always stubbed — real calls cost money, mutate state outside the blast radius, and make runs unrepeatable.

### Validation has two halves, and the second one is the point

Mechanical validation asks whether anything broke: build, start, connect, run the tests attached to implicated nodes. It stops at the first failure, because test failures inside something that never started describe one root cause at length.

Behavioral validation asks the questions that decide whether an agent can be trusted to operate here, and answers most of them by diffing the graph rather than asking a model:

- **Scope adherence** — the enforceable form of "scoped mutation as law." The walk predicted a node set before anything was written; the diff shows what actually moved. Anything outside the predicted set is a scope escape: either the change did more than it claimed, or the graph is wrong about the system. This works regardless of how the change was produced — an agent editing source freehand cannot be prevented from touching an unpredicted node, but it cannot hide having done so.
- **Permission drift** — new secrets, env vars, or network permissions, and new bindings to them.
- **Irreversible exposure** — new write paths into state that rollback cannot restore.
- **Cost limit** — the intent's declared ceiling, checked as a gate rather than read on the invoice later.
- **Success condition** — via a pluggable evaluator.

`inconclusive` is a first-class outcome and does not pass. A missing evaluator, an absent cost projection, or a judge that cannot reach a verdict is not evidence a change is safe, and treating it as one is how an unavailable eval harness becomes a silent green light.

### Deployment is a monitored experiment

Three verdicts, not two: `promote`, `hold`, `roll_back`. `hold` is what a stage gets when nothing is wrong and nothing has been proven — the soak has not elapsed, or no signal is being reported at all. Collapsing `hold` into `promote` is how an unmonitored change rolls to everyone; collapsing it into `roll_back` makes the runtime thrash on quiet periods.

The lineage record opens **before** exposure, not after, because the prediction has to be captured while it is still a prediction. `auditPrediction` then compares what was predicted against what actually broke. A casualty nobody predicted is a missing edge in the graph — a defect in the model of the system, not in the deployment — and that is the signal the runtime learns from.

### Cost is attributed to the node that caused it

Spend rolls up through outbound structural edges: a screen that costs a dollar to render and triggers sixty dollars of inference behind it is not a cheap screen. Two details keep the output actionable:

- **Hotspots exclude pure conduits.** Ranking on roll-up alone surfaces whatever sits furthest upstream — a UI module that spends nothing inherits everything beneath it and tops the list, answering "what is the root of this subgraph" when the question was "where is the money going."
- **Recommendations use the rolled-up category mix.** The lever for that same screen is the inference bill, not the container size its own dollar of compute was spent on.

An unmeasured benefit is reported as `unknown`, never as zero. Cost is easy to measure and value is not, and a system that treats the two as symmetric will recommend deleting everything it cannot price.

## Layout

```
src/
  graph/       domains, edge semantics, node schemas, the store, diffing
  intent/      intent objects and action classes
  impact/      the resolution walk
  policy/      risk classification and approval requests
  mirror/      isolated-environment planning
  validation/  mechanical and behavioral gates
  deployment/  promotion stages and lineage records
  cost/        attribution and sustainability
  fixtures/    the login-workflow graph from the specification
```

Everything here is pure. The two places that must touch real infrastructure — `MirrorExecutor` (build workers) and `BehavioralEvaluator` (success-condition judgment) — are interfaces, so which checks run, in what order, and what a failure means all stay testable without a container runtime.

The `ProjectGraph` interface is deliberately narrow — `node`, `inbound`, `outbound` — because that is the entire surface impact resolution needs, which is what will let the store move to a persistent backend without touching the engine.
