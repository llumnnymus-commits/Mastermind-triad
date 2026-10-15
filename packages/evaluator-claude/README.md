# @lbr/evaluator-claude

A `BehavioralEvaluator` that judges whether a change accomplished what its intent asked for.

Until this existed, every success condition came back `inconclusive`. That was honest — nothing was checking — but it meant the runtime could confirm only that nothing visibly broke, never that the change did what someone wanted.

## What it judges, and what it can't

Most of behavioral validation is decided by diffing the graph: scope adherence, permission drift, new write paths into irreversible state. Those are facts, and a model is the wrong tool for them.

The one question a diff cannot answer on its own is whether the change satisfies a success condition written in prose — "sessions expire after 24h and all login flows still authenticate." That is what this judges, and it is told plainly what its evidence cannot show:

> The graph diff shows structure … It does NOT show runtime behavior. It cannot tell you a feature works, that a value is correct at execution time, that data was backfilled, or that a user flow still completes.

So a success condition asserting runtime behavior gets `unclear`, and `unclear` does not pass. The judge is also told the rule that matters most:

> absence of evidence of a problem is not evidence of success. A clean diff with no visible issues is "unclear", not "met"

When it answers `unclear` it lists what it would have needed — a test exercising the behavior, a migration record — so the next intent can be written more checkably.

## It cannot launder uncertainty into a pass

Every failure path lands on `unclear`, never `met`:

| Situation | Verdict |
| --- | --- |
| Nothing changed in the graph | `not_met`, without calling the model |
| The model is unreachable | `unclear` |
| The request is declined by a safety classifier | `unclear` |
| The response has no parseable verdict | `unclear` |

The empty-diff case is decided locally on purpose: an empty diff means the change did not happen, and asking a model to rule on that is paying to be told what is already on the page.

A network failure returning `unclear` rather than throwing is deliberate too. It must not take down a validation run — and it must not pass one.

## Use it

```ts
import { ClaudeEvaluator } from '@lbr/evaluator-claude';

const report = await runBehavioralValidation({
  before, after, intent, impact,
  evaluator: new ClaudeEvaluator(),
});
```

The client is injectable (`new ClaudeEvaluator({ client })`), which is how the evaluator's own logic — prompt construction, verdict mapping, failure handling — is tested without a network call or an API key.

`lbr validate` deliberately does **not** wire this up. That command applies no change: it builds and tests the project as it stands inside a mirror, so the before and after graphs are identical and there is no change to judge. Passing `--judge` prints that explanation rather than reporting a confusing failure.

## Verification status

The evaluator's logic is covered by tests against an injected client. **The live API path is unverified** — this environment has no Anthropic credential, so no real request has been made from it. The request shape is written against the installed SDK's own type declarations (`client.messages.parse` with `zodOutputFormat`, adaptive thinking, `claude-opus-5`) and typechecks, but "typechecks" is not "works", and the first real call may still find something.
