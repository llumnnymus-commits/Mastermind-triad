# @lbr/executor-local

A `MirrorExecutor` that actually runs things.

Until this package, validation was an interface with a passing stub behind it — which proves the runtime's logic and nothing about whether a change works. This materializes a real workspace and runs real build and test commands against it.

## What it does

```bash
npx tsx packages/cli/src/cli.ts validate packages/runtime-core src/impact/resolve.ts
```

```
CHANGING   src/impact/resolve.ts
IMPACT     14 structural nodes · magnitude 0.884
AUTHORITY  HIGH · approval required
MIRROR     9 real · 5 stubbed · 5 test(s) to run

RUNNING    (real build, real tests, in an isolated copy)
  PASS         build 2.2s
  PASS         start 1.6s
  PASS         connect
  PASS         verify evidence:test:test_authority_test 1.2s
  PASS         verify evidence:test:test_deployment_test 1.1s
  PASS         verify evidence:test:test_impact_test 1.0s
  PASS         verify evidence:test:test_mirror_test 1.0s
  PASS         verify evidence:test:test_validation_test 1.1s
```

Five of six test files. `cost.test.ts` is absent because nothing in the cost module depends on `resolve.ts`. Validating `src/cost/attribution.ts` instead runs exactly one. On a repository this size that is a curiosity; on a large one it is the difference between a validation gate an agent can run on every change and one nobody waits for.

## The security model

The executor runs commands, and the graph it reads is populated by adapters that ingest other people's repositories. Node attributes are therefore attacker-controlled input, and ingesting a repository must not be equivalent to running it. Three properties hold by construction rather than by care:

**There is no shell.** `execFile` with an argv array, `shell: false` stated explicitly. A value containing `; rm -rf /` is an argument, not a command, and there is no string interpolation anywhere in `commands.ts` for a reviewer to have to verify.

**Commands come from an allowlist the host supplies.** Graph data selects *which* allowlisted command runs; it never contributes an executable or argv. The default set for a Node project is three fixed argv arrays a reviewer can read in full.

**The environment is rebuilt, not filtered.** A mirror runs code the runtime is evaluating. Inheriting `process.env` hands that code every credential the host holds — cloud tokens, registry auth, signing keys — in exchange for nothing a build needs. So the child environment is assembled from an allowlist; a denylist would be a promise to predict every secret name anyone will ever introduce.

**Containment is decided on the real filesystem.** Paths read out of node attributes are resolved against the workspace and refused if they escape it. That check calls `realpath` rather than comparing strings, because a lexical test cannot see a symlink — and symlinks leaving the source tree are dropped during the copy rather than reproduced inside the mirror, so there is no door to walk back out of.

**An appended argument may never look like an option.** Absence of a shell is necessary but not sufficient. A value is passed intact to the child, and a child that parses its own argv reads one beginning with `-` as an *option* rather than the operand it was meant to be: `vitest run <filter>` takes a path substring, but `vitest run --config=X` takes a config file. A repository containing a file named `--config=…` could otherwise redirect the runner at anything on the host with `shell: false` fully intact and entirely beside the point. The invariant is enforced centrally in `CommandRunner.run`, and verification paths are additionally passed as explicitly relative operands so they cannot begin with a dash.

These three came out of a security review of this package, each with a working proof of concept; `test/security.test.ts` keeps them fixed.

## What it does not provide, and says so

This is deliberately the weakest executor worth having. `MirrorWorkspace.caveats` reports what the mirror could not do, and `connect` fails rather than passing when a caveat means the plan was not actually carried out:

- Commands run as the host user. No process, network, or filesystem isolation from the machine. A container or micro-VM executor satisfying the same interface would provide that; this does not.
- `node_modules` is linked rather than copied, so a change to dependencies is not isolated.
- Data snapshots and third-party stubs the plan requires cannot be restored or intercepted here. A plan asking for a database snapshot that nothing restored has not been carried out, whatever the tests then say — so `connect` fails instead of reporting a clean pass.

The point is not that a source-tree copy is strong isolation. It is that the executor states its limits rather than letting a caller infer safety from the word "mirror."

## One thing running it taught

The first real run failed to build with `cannot find module 'zod'`, which reads as a broken project. It was a misplaced mirror.

Node resolves a dependency by walking up from the importing file through every `node_modules` between it and the filesystem root. An npm workspace hoists most packages to the repository root and leaves a *partial* `node_modules` in each package — so "link the nearest `node_modules`" reproduces exactly one link of that chain and severs the rest. A mirror in `/tmp` has no chain at all.

The fix is placement rather than linking: mirrors are created in `.lbr-mirrors/` beside the `node_modules` the source resolves against, so walking up from the mirror reaches the same packages the original would.
