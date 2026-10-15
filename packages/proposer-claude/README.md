# @lbr/proposer-claude

The piece that makes the runtime able to *build* something rather than only inspect it.

`@lbr/runtime-core` analyzes, gates, isolates, validates and records. None of that does anything until some component actually writes a change. `ChangeProposer` is that contract, and this package is its Claude-backed implementation.

## Two things it does

### `decompose` — an application becomes an ordered list of intents

The white paper describes the agent constructing a project "one graph-node at a time, providing a plain-English explanation for every stage". That is taken literally rather than decoratively. `decompose(description, target, { client })` returns a `BuildPlan`: an ordered sequence of steps, each with a goal, a rationale for its position in the order, a success condition, and the files it expects to touch.

Each step then becomes a real `Intent` driven through the same impact walk, authority gate, mirror and validation as any other change. A step that breaks the build stops the run, and the lineage says which one and why.

The alternative — one generation producing a whole application — cannot be validated incrementally, so the first failure invalidates everything and nothing localizes the fault.

`decompose` throws on a refusal or an unparseable response rather than returning a partial plan. Half a plan is not a smaller plan; it is a plan that builds an application missing the parts nobody noticed were absent.

### `ClaudeProposer` — one step becomes file contents

`propose(intent, graph, impact)` returns a `ChangeProposal`: complete file contents, never patches. The request shows the model what is wanted, what the impact walk predicts the change will touch (including a note when that walk did not finish), the files that exist, and the current contents of the ones most relevant.

## What it is not allowed to decide

The proposer does not get to decide whether its output is any good, and the design reflects that at three points:

1. **Its output is reparsed through the runtime's own schema**, not trusted. `parseChangeProposal` is where absolute paths and paths containing `..` are refused — the same gate a hand-written proposal passes through. A proposer that validated its own paths would be the component checking its own containment.
2. **`expectedNodes` is a claim, not an answer.** It is recorded in lineage and compared against reality. The after-graph is produced by re-ingesting the mirror, so a proposal that quietly touches an unpredicted file is caught even though it never mentioned it. If the proposer supplied both sides, scope adherence would be marking its own homework.
3. **Nothing is written outside the mirror.** The edits go through the same path confinement, the same isolated copy, the same real build and tests as any other change.

The system prompt says all of this to the model too, because a model that knows its output is compiled and tested writes differently from one that believes its claims are taken at face value: *"This is checked, not assumed, so there is no benefit to optimism."*

## Failure paths do not invent

- A `refusal` stop reason throws, naming the category.
- A response with no parseable output throws.
- Cost is reported **before** any failure path returns, so a refused or unparseable response still accounts for what it cost.

Nothing here degrades into a plausible-looking empty proposal. A proposal that silently becomes "change nothing" passes every validation gate the runtime has.

## Cost

`onCost` receives a `model_inference` `CostEvent` per request, computed from the response's own `usage` at Claude Opus 5 list pricing ($5/MTok in, $25/MTok out), attributed to the intent's target node. This is measured, not estimated.

## Honest limit

**The live API path is unverified.** There is no credential in this environment, so every test here injects a client. What is tested is the proposer's own logic: prompt construction, schema handling, the reparse through `parseChangeProposal`, refusal and unparseable handling, and cost reporting on every path. What is not tested is that a real request to a real endpoint returns what the schema expects. `@lbr/evaluator-claude` documents the same limit for the same reason.

## Try it

```bash
npm test --workspace @lbr/proposer-claude
```

Every test injects a fake client through `ClaudeProposerOptions.client`; there is no stub proposer in `src`, and no fallback. If the real proposer fails, the run fails. Where a deterministic change is wanted — the CLI's own end-to-end tests, a reproducible build — `lbr run --proposal <file>` and `lbr build --proposals <dir>` take a `ChangeProposal` as JSON and go through the identical apply-and-validate path.
