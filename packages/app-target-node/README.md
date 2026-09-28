# @lbr/app-target-node

What "an application" means for one stack, so `lbr build` can construct one from nothing.

An `AppTarget` supplies four things: the files that make an empty but working project, where generated source belongs, how to install the project's dependencies, and how to run the finished thing. The runtime supplies everything else — decomposition, the impact walk, the mirror, validation, promotion, lineage.

## Why Node/TypeScript and not Android

The source documents describe building Android apps through `gradlew`. That target is not implemented here, and the reason is stated rather than hidden: this environment has no Android SDK, no Gradle and no emulator, so an Android codegen path could be written but never run. A generator nobody can execute is how a system accumulates confident claims about code that has never worked.

The Node target can be scaffolded, compiled, tested and executed here, so it is the one that exists. `AppTarget` is an interface; an Android or Flutter target supplies its own scaffold and commands and drops into the same loop, unchanged.

## The scaffold is a change like any other

`scaffold()` returns `FileEdit[]` — the same type a proposer returns. That is deliberate. A scaffold written through a privileged side-channel would be the one change in the system that nothing checked, and it is the change everything else is built on top of.

It is also deliberately minimal: the smallest thing that genuinely compiles, tests and runs. Every line the runtime adds after this is a change that went through the loop and was validated, rather than something smuggled in as "setup".

Two details that were only found by running it:

- **The project owns its dependencies.** An early version relied on the generating repository's `node_modules`, which produced something that compiled where it was generated and nowhere else. `installCommand` runs once after scaffolding, and the test for this package installs for real rather than linking — linking is what hid the defect.
- **`types: ['node']` is explicit.** Without it the entry point cannot reference `process` or `console`, and the scaffold does not compile at all.

The app name is derived from the goal (`"a note taker with tags and search"` → `a-note-taker-with-tags-and-search`), falling back to `app` when nothing usable survives sanitization.

## Selecting one

```ts
import { selectTarget } from '@lbr/app-target-node';

const target = selectTarget('node-typescript');
```

`selectTarget` throws on a name it has no implementation for, naming what is available. A build that named a target it cannot produce fails before a scaffold is written, rather than leaving behind a directory of files nothing can compile.

## Try it

```bash
npm test --workspace @lbr/app-target-node
```

The test that matters installs the scaffold as a standalone project, compiles it with `tsc`, runs its test with vitest, and executes the built entry point. It takes several seconds because all of that is real.
