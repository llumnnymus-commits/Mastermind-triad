#!/usr/bin/env node
/**
 * lbr — drive the Live Build Runtime against a real project.
 *
 *   lbr ingest   <dir>                  build the graph, report what is in it
 *   lbr impact   <dir> <file>           what a change to this file would touch
 *   lbr validate <dir> <file>           the whole loop against the tree as it stands
 *   lbr run      <dir> --goal "..."     propose a change, apply it, validate it
 *   lbr build    --goal "..." --out <dir>   build an application, one step at a time
 *
 * `impact` answers the question the substrate exists for. `validate` runs the
 * real build and the tests the change implicates, against the tree unchanged.
 * `run` closes the loop: a proposer writes a real change into the mirror, the
 * mirror is re-ingested to see what the change actually did, and behavioral
 * validation finally has two different graphs to compare.
 */
import { writeFileSync } from 'node:fs';
import {
  ProjectGraph,
  resolveImpact,
  classifyRisk,
  buildApprovalRequest,
  planMirror,
  parseIntent,
  serializeGraph,
  runMechanicalValidation,
  runBehavioralValidation,
  openLineage,
  saveLineage,
  attributeCosts,
  diffGraphs,
  type ActionClass,
  type ChangeProposal,
  type ChangeProposer,
  type CheckResult,
  type CostEvent,
  type GraphNode,
  type Intent,
  type ValidationReport,
} from '@lbr/runtime-core';
import { TypeScriptAdapter } from '@lbr/adapter-typescript';
import { PolicyAdapter, DEFAULT_POLICY_PATH } from '@lbr/adapter-policy';
import { LocalMirrorExecutor, applyProposal, detectSandbox, NO_SANDBOX } from '@lbr/executor-local';
import { ClaudeEvaluator } from '@lbr/evaluator-claude';
import { selectTarget, type AppTarget } from '@lbr/app-target-node';

/**
 * Model spend incurred during this invocation.
 *
 * Collected here rather than estimated at the end: the proposer reports what
 * its own request actually cost, from the response's usage, and an inference
 * bill nobody attributes is the one cost a runtime economics layer exists to
 * stop losing.
 *
 * Declared above the dispatch below, not beside the code that fills it. `const`
 * is not hoisted, so a command reading this from further down the file reached
 * it before its initializer had run and died with "cannot access before
 * initialization" — after the change had been applied and validated, which is
 * the worst place to lose a run.
 */
const modelCosts: CostEvent[] = [];

const [command, ...rest] = process.argv.slice(2);

const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const token = rest[i]!;
  if (token.startsWith('--')) {
    flags.set(token.slice(2), rest[i + 1]?.startsWith('--') === false ? rest[++i]! : 'true');
  } else {
    positional.push(token);
  }
}

try {
  switch (command) {
    case 'ingest':
      await ingest();
      break;
    case 'impact':
      await impact();
      break;
    case 'validate':
      await validate();
      break;
    case 'run':
      await run();
      break;
    case 'build':
      await buildApp();
      break;
    default:
      usage();
  }
} catch (error) {
  console.error(`\nlbr: ${(error as Error).message}\n`);
  process.exit(1);
}

/**
 * Build the graph from every adapter that has something to say about this
 * project.
 *
 * Order matters in one direction only: policy attaches to nodes, so the
 * domains it governs have to exist before it is ingested. Beyond that adapters
 * are additive and may overlap — `addNode` replaces by id, so two adapters
 * describing the same node converge rather than conflict.
 */
async function build(dir: string): Promise<BuiltGraph> {
  const graph = new ProjectGraph();

  const source = await new TypeScriptAdapter().ingest(dir);
  for (const node of source.nodes) graph.addNode(node);
  for (const edge of source.edges) graph.addEdge(edge);

  const policy = await new PolicyAdapter({ graph }).ingest(dir);
  for (const node of policy.nodes) graph.addNode(node);
  for (const edge of policy.edges) graph.addEdge(edge);

  return {
    graph,
    unresolved: source.unresolved.length,
    policyCount: policy.nodes.length,
    // A declared rule that governs nothing looks exactly like a rule being
    // obeyed, so it is surfaced rather than counted as success.
    inertPolicies: policy.unresolved.map((u) => u.reason),
  };
}

interface BuiltGraph {
  readonly graph: ProjectGraph;
  readonly unresolved: number;
  readonly policyCount: number;
  readonly inertPolicies: readonly string[];
}

function findNode(graph: ProjectGraph, target: string): GraphNode {
  const match = [...graph.nodes()].find(
    (n) => n.name === target || n.name.endsWith(target) || n.id === target,
  );
  if (match === undefined) {
    const sample = [...graph.nodes()]
      .slice(0, 8)
      .map((n) => `  ${n.name}`)
      .join('\n');
    throw new Error(`no node matches '${target}'. Try one of:\n${sample}`);
  }
  return match;
}

function intentFor(node: GraphNode, action: ActionClass) {
  return parseIntent({
    id: `cli_${Date.now()}`,
    goal: `Change ${node.name}`,
    rationale: 'asked from the command line',
    source: 'human',
    raisedBy: 'actor:human:cli',
    targets: [node.id],
    actions: [action],
    successCondition: 'the change does what was intended and nothing else breaks',
  });
}

async function ingest(): Promise<void> {
  const dir = positional[0];
  if (dir === undefined) return usage();

  const { graph, unresolved, policyCount, inertPolicies } = await build(dir);
  const size = graph.size;
  console.log(`ingested ${size.nodes} nodes, ${size.edges} edges from ${dir}`);
  console.log(`${unresolved} external reference(s) recorded as unresolved`);
  console.log(
    policyCount === 0
      ? `no policy declared (looked for ${DEFAULT_POLICY_PATH}) — the authority gate has only action class and graph shape to work with`
      : `${policyCount} policy rule(s) declared and bound`,
  );
  for (const inert of inertPolicies) console.log(`  warning: ${inert}`);

  const out = flags.get('out');
  if (out !== undefined && out !== 'true') {
    writeFileSync(out, JSON.stringify(serializeGraph(graph), null, 2));
    console.log(`written to ${out}`);
  }
}

async function impact(): Promise<void> {
  const [dir, target] = positional;
  if (dir === undefined || target === undefined) return usage();

  const { graph } = await build(dir);
  const node = findNode(graph, target);
  const action = (flags.get('action') ?? 'code_change') as ActionClass;
  const intent = intentFor(node, action);
  const result = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, result);

  console.log(`\nCHANGING  ${node.name}`);
  console.log(
    `IMPACT    ${result.structuralCount} structural nodes · magnitude ${result.magnitude} · action '${action}'`,
  );

  if (result.blastRadius.length > 0) {
    console.log('\nBREAKS IF THIS IS WRONG');
    for (const impacted of result.blastRadius.slice(0, 12)) {
      console.log(`  ${impacted.score.toFixed(2).padStart(5)}  ${impacted.node.name}`);
    }
    if (result.blastRadius.length > 12) {
      console.log(`  …and ${result.blastRadius.length - 12} more`);
    }
    if (!result.coverage.complete) {
      console.log(
        `  INCOMPLETE — the walk stopped with ${result.coverage.depthLimited} node(s) unexplored at confidence up to ${result.coverage.highestUnexplored}; this list is short by an unknown amount`,
      );
    }
  } else {
    console.log('\nBREAKS IF THIS IS WRONG\n  nothing depends on this file');
  }

  if (result.verifications.length > 0) {
    console.log('\nMUST PASS');
    for (const test of result.verifications) console.log(`         ${test.node.name}`);
  } else {
    console.log(
      '\nMUST PASS\n  nothing — no test covers this file, so a failure here would be silent',
    );
  }

  console.log(
    `\nVERDICT   ${risk.tier.toUpperCase()}${
      risk.requiresApproval ? ' · approval required' : ' · an agent may do this unattended'
    }`,
  );
  for (const reason of risk.reasons) console.log(`  · ${reason.detail}`);

  if (risk.requiresApproval) {
    const request = buildApprovalRequest(graph, intent, result, risk);
    console.log('\nWHY');
    for (const item of request.risks.slice(0, 4)) console.log(`  · ${item}`);
  }
  console.log();
}

/**
 * The whole loop against a real project, with real commands.
 *
 * The point is the scoping: the mirror runs only the tests attached to nodes
 * this change implicates, not the whole suite. On a small repository that is a
 * curiosity; on a large one it is the difference between a validation gate an
 * agent can run on every change and one nobody waits for.
 */
async function validate(): Promise<void> {
  const [dir, target] = positional;
  if (dir === undefined || target === undefined) return usage();

  const { graph } = await build(dir);
  const node = findNode(graph, target);
  const action = (flags.get('action') ?? 'code_change') as ActionClass;
  const intent = intentFor(node, action);

  const impactResult = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, impactResult);
  const plan = planMirror(graph, intent, impactResult);

  console.log(`\nCHANGING   ${node.name}`);
  console.log(
    `IMPACT     ${impactResult.structuralCount} structural nodes · magnitude ${impactResult.magnitude}${
      impactResult.coverage.complete ? '' : ' · INCOMPLETE WALK'
    }`,
  );
  console.log(
    `AUTHORITY  ${risk.tier.toUpperCase()}${risk.requiresApproval ? ' · approval required' : ' · unattended'}`,
  );
  console.log(
    `MIRROR     ${plan.nodes.filter((n) => n.mode === 'real').length} real · ${plan.nodes.filter((n) => n.mode === 'stub').length} stubbed · ${plan.verificationPlan.length} test(s) to run`,
  );

  if (plan.safetyViolations.length > 0) {
    console.log(`\nREFUSED    ${plan.safetyViolations.join('; ')}\n`);
    process.exitCode = 2;
    return;
  }

  // Confinement is opt-in: it blocks network egress, which breaks a build that
  // legitimately fetches. Asking for it on a repository you did not write is
  // the point of it existing.
  const sandbox = flags.has('sandbox') ? await detectSandbox() : NO_SANDBOX;
  if (flags.has('sandbox') && sandbox === NO_SANDBOX) {
    console.log(
      '\n  WARNING    --sandbox was requested but this machine refused to create namespaces;\n             commands will run unconfined. Treat the result accordingly.',
    );
  }

  const executor = new LocalMirrorExecutor({
    sourceRoot: dir,
    graph,
    nodeModulesFrom: flags.get('node-modules'),
    sandbox,
  });

  try {
    console.log('\nRUNNING    (real build, real tests, in an isolated copy)');
    const mechanical = await runMechanicalValidation(intent, plan, executor);
    for (const check of mechanical.checks) {
      const ms = check.durationMs === undefined ? '' : ` ${(check.durationMs / 1000).toFixed(1)}s`;
      console.log(`  ${check.status.toUpperCase().padEnd(13)}${check.name}${ms}`);
      if (check.status === 'fail') console.log(`                ${check.detail}`);
    }

    // Behavioral validation with no change applied: the graph is identical, so
    // this reports the honest baseline — scope held, nothing drifted, and the
    // intent's success condition was never actually judged.
    // `validate` applies no change — it builds and tests the project as it
    // stands, in a mirror. So the graph it compares is the graph it started
    // with, and "did the change do what was asked" has no subject. Wiring a
    // judge to that would spend money to be told nothing moved, so the flag
    // says why instead of reporting a confusing failure. The evaluator is
    // reached through `runBehavioralValidation` by a caller that has actually
    // applied a change.
    if (flags.has('judge')) {
      console.log(
        '\n  NOTE     --judge has nothing to judge here: validate applies no change, so the\n           before and after graphs are identical. Pass an evaluator to\n           runBehavioralValidation from a caller that has applied one.',
      );
    }


    const behavioral = await runBehavioralValidation({
      before: graph,
      after: graph,
      intent,
      impact: impactResult,
    });
    console.log();
    for (const check of behavioral.checks) {
      console.log(`  ${check.status.toUpperCase().padEnd(13)}${check.name} — ${check.detail}`);
    }

    const record = openLineage({
      deploymentId: `local_${Date.now()}`,
      baseRevision: 'working-tree',
      intent,
      impact: impactResult,
      risk,
      mirror: plan,
      validation: [mechanical, behavioral],
      rollback: {
        toDeploymentId: 'none',
        unrecoverableNodes: impactResult.irreversible.map((n) => n.id),
        steps: ['discard the mirror; the working tree was never modified'],
      },
    });

    console.log(
      `\nRESULT     mechanical ${mechanical.passed ? 'pass' : 'FAIL'} · behavioral ${
        behavioral.passed ? 'pass' : 'incomplete'
      } · lineage ${record.deploymentId}`,
    );
    console.log(`  sandbox   ${sandbox.name}`);
    for (const provided of sandbox.provides) console.log(`  provides  ${provided}`);
    for (const lacking of sandbox.lacks) console.log(`  lacks     ${lacking}`);
    for (const caveat of executor.workspace?.caveats ?? []) {
      console.log(`  caveat    ${caveat}`);
    }
    console.log();
    // Exiting here would skip the `finally` below, leaving a full copy of the
    // validated project on disk — including, for an ingested third-party
    // repository, whatever it contained. The code is recorded and applied
    // after cleanup instead.
    if (!mechanical.passed) process.exitCode = 1;
  } finally {
    await executor.dispose();
  }
}

/**
 * The full cycle, with a change actually applied.
 *
 * This is the command the rest of the runtime was built for. Everything before
 * it analyzed a change that never happened: `validate` compares the graph to
 * itself, so scope adherence, permission drift and irreversible exposure could
 * report nothing but success. Here a proposer writes real edits into the
 * mirror, the mirror is re-ingested, and those checks finally have two
 * different graphs to compare.
 *
 * The after-graph comes from re-ingesting, never from the proposal. A proposer
 * that supplied both the change and the description of the change would be
 * marking its own homework — and a change that quietly touches a file it never
 * mentioned is exactly what scope adherence exists to catch.
 */
async function run(): Promise<void> {
  const dir = positional[0];
  const goal = flags.get('goal');
  if (dir === undefined || goal === undefined || goal === 'true') return usage();

  const { graph, policyCount } = await build(dir);

  // A target anchors the impact walk. Given one, the walk starts there; without
  // one it starts from the whole surface the goal might touch, which on a real
  // repository is too broad to be useful — so it is required rather than guessed.
  const targetName = flags.get('target');
  if (targetName === undefined || targetName === 'true') {
    console.error('\nlbr run needs --target <file> to anchor the impact walk.\n');
    process.exitCode = 1;
    return;
  }
  const node = findNode(graph, targetName);

  const intent = parseIntent({
    id: `run_${Date.now()}`,
    goal,
    rationale: 'requested from the command line',
    source: 'human',
    raisedBy: 'actor:human:cli',
    targets: [node.id],
    actions: [(flags.get('action') ?? 'code_change') as ActionClass],
    successCondition: goal,
  });

  const impact = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, impact);
  const plan = planMirror(graph, intent, impact);

  console.log(`\nGOAL       ${goal}`);
  console.log(`TARGET     ${node.name}`);
  console.log(
    `IMPACT     ${impact.structuralCount} structural nodes · magnitude ${impact.magnitude}${
      impact.coverage.complete ? '' : ' · INCOMPLETE WALK'
    }`,
  );
  console.log(
    `AUTHORITY  ${risk.tier.toUpperCase()}${risk.blocked ? ' · BLOCKED' : ''}${
      risk.requiresApproval ? ' · approval required' : ' · unattended'
    }${policyCount > 0 ? ` · ${policyCount} policy rule(s) bound` : ''}`,
  );
  for (const reason of risk.reasons) console.log(`           · ${reason.detail}`);

  if (risk.blocked) {
    console.log('\nREFUSED    the intent crosses its own declared limits\n');
    process.exitCode = 2;
    return;
  }
  if (plan.safetyViolations.length > 0) {
    console.log(`\nREFUSED    ${plan.safetyViolations.join('; ')}\n`);
    process.exitCode = 2;
    return;
  }

  const proposer = await selectProposer(dir);
  if (proposer === undefined) {
    console.log(
      '\nNO PROPOSER  nothing can write a change. Pass --proposal <file.json> for a prepared\n' +
        '             proposal, or configure a credential for the model-backed proposer.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nPROPOSING  via ${proposer.name}`);
  const proposal = await proposer.propose(intent, graph, impact);
  console.log(`           ${proposal.edits.length} edit(s): ${proposal.rationale}`);
  for (const edit of proposal.edits.slice(0, 8)) {
    console.log(`           ${'delete' in edit ? 'delete' : 'write '} ${edit.path}`);
  }

  if (!flags.has('apply')) {
    console.log(
      '\nNOT APPLIED  --apply was not passed. Nothing was written, so there is no change to\n' +
        '             validate. The proposal above is what would have been applied.\n',
    );
    return;
  }

  const sandbox = flags.has('sandbox') ? await detectSandbox() : NO_SANDBOX;
  if (flags.has('sandbox') && sandbox === NO_SANDBOX) {
    console.log(
      '\n  WARNING    --sandbox was requested but this machine refused to create namespaces;\n             commands will run unconfined. Treat the result accordingly.',
    );
  }

  const executor = new LocalMirrorExecutor({
    sourceRoot: dir,
    graph,
    nodeModulesFrom: flags.get('node-modules'),
    sandbox,
    proposal,
  });

  try {
    console.log('\nRUNNING    (real build, real tests, against the changed mirror)');
    const mechanical = await runMechanicalValidation(intent, plan, executor);
    for (const check of mechanical.checks) {
      const ms = check.durationMs === undefined ? '' : ` ${(check.durationMs / 1000).toFixed(1)}s`;
      console.log(`  ${check.status.toUpperCase().padEnd(13)}${check.name}${ms}`);
      if (check.status === 'fail') console.log(`                ${check.detail}`);
    }

    const applied = executor.applied;
    const mirrorRoot = executor.workspace?.root;
    if (applied !== undefined) {
      console.log(
        `\nAPPLIED    ${applied.written.length} written, ${applied.deleted.length} deleted, ${applied.refused.length} refused (in the mirror; the working tree is untouched)`,
      );
    }

    // Re-ingest the mirror. This is what makes the diff real.
    const after =
      mirrorRoot === undefined ? graph : (await build(mirrorRoot)).graph;
    const diff = diffGraphs(graph, after);
    console.log(
      `DIFF       ${diff.addedNodes.length} node(s) added, ${diff.changedNodes.length} changed, ${diff.removedNodes.length} removed, ${diff.addedEdges.length} edge(s) added`,
    );

    const behavioral = await runBehavioralValidation({
      before: graph,
      after,
      intent,
      impact,
      evaluator: flags.has('judge') ? new ClaudeEvaluator() : undefined,
    });
    console.log();
    for (const check of behavioral.checks) {
      console.log(`  ${check.status.toUpperCase().padEnd(13)}${check.name} — ${check.detail}`);
    }

    // Compute measured by the executor, plus whatever the proposer's own
    // requests actually cost. Both are measured; neither is estimated.
    const costs = [...collectCosts(mechanical, intent), ...modelCosts];
    const report = attributeCosts(graph, costs);

    let record = openLineage({
      deploymentId: `run_${Date.now()}`,
      baseRevision: 'working-tree',
      intent,
      impact,
      risk,
      mirror: plan,
      validation: [mechanical, behavioral],
      rollback: {
        toDeploymentId: 'none',
        unrecoverableNodes: impact.irreversible.map((n) => n.id),
        steps: ['discard the mirror; the working tree was never modified'],
      },
    });
    // `abandoned` means someone decided to drop this. A change that built and
    // passed its tests but whose success condition nothing judged has not been
    // abandoned — it is still a candidate, waiting on a verdict. Recording it
    // as abandoned would make the lineage history lie about why changes stopped.
    record = {
      ...record,
      outcome: !mechanical.passed
        ? 'abandoned'
        : behavioral.passed
          ? 'deployed'
          : 'in_progress',
    };

    const saved = await saveLineage(dir, record, graph);

    console.log(
      `\nRESULT     mechanical ${mechanical.passed ? 'pass' : 'FAIL'} · behavioral ${
        behavioral.passed ? 'pass' : 'incomplete'
      }`,
    );
    console.log(`  lineage   ${saved.path}`);
    if (report.totalUsd > 0) {
      console.log(`  cost      $${report.totalUsd} across ${costs.length} measured operation(s)`);
      for (const hotspot of report.hotspots.slice(0, 3)) {
        console.log(`            ${hotspot.name} — $${hotspot.rolledUpUsd}`);
      }
    }
    for (const caveat of executor.workspace?.caveats ?? []) {
      console.log(`  caveat    ${caveat}`);
    }
    console.log();

    if (!mechanical.passed || !behavioral.passed) process.exitCode = 1;
  } finally {
    await executor.dispose();
  }
}

/**
 * Build an application, one validated step at a time.
 *
 * The source documents describe an agent that "constructs the project one
 * graph-node at a time, providing a plain-English explanation for every stage".
 * That is what this does, and it is not a presentation choice: each step is a
 * real intent driven through the impact walk, the authority gate, an isolated
 * mirror, a real compile and a real test run. A step that breaks the build
 * stops the run and the lineage says which one — which a single generation
 * producing a whole application cannot do, because its first failure
 * invalidates everything and nothing localizes the fault.
 *
 * A step is promoted into the app only after it validated in the mirror. Until
 * then the app on disk is whatever last passed.
 */
async function buildApp(): Promise<void> {
  const goal = flags.get('goal');
  const out = flags.get('out');
  if (goal === undefined || goal === 'true' || out === undefined || out === 'true') return usage();

  const target = selectTarget(flags.get('app-target') ?? 'node-typescript');
  const { mkdir, readdir } = await import('node:fs/promises');

  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) {
    console.error(`\nlbr build needs an empty directory; ${out} is not empty.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nBUILDING   ${goal}`);
  console.log(`TARGET     ${target.produces}`);
  console.log(`INTO       ${out}`);

  // The plan is obtained before anything is written or installed.
  //
  // A plan that is malformed — a step id that is not a usable filename, a step
  // with no goal — fails the whole build, so paying for a scaffold and a full
  // dependency install first buys nothing and leaves a directory behind. This
  // throws for an invalid plan and returns undefined only when nothing was
  // available to plan with, which is a different situation and handled below.
  const plan = await loadBuildPlan();

  // The scaffold goes through the same apply path as any other change, even
  // though this directory is the application being created rather than a tree
  // to be protected. The paths are the target's own constants, so nothing here
  // is untrusted — but a write path that bypasses the confinement is one nobody
  // notices has started carrying untrusted input.
  const scaffold = target.scaffold(goal);
  const scaffolded = await applyProposal(
    out,
    {
      intentId: 'scaffold',
      rationale: `scaffold a ${target.name} project`,
      edits: scaffold,
      expectedNodes: [],
    },
    { allowNonMirror: true },
  );
  if (scaffolded.refused.length > 0) {
    const reasons = scaffolded.refused.map((r) => `${r.path} (${r.reason})`).join(', ');
    console.error(`\nlbr build refused part of its own scaffold: ${reasons}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`SCAFFOLD   ${scaffolded.written.length} file(s) written`);

  // Installed once, here, so the generated application is a project in its own
  // right rather than something that only builds inside this repository. Every
  // step after this compiles and tests against these dependencies.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const [installBin, ...installArgs] = target.installCommand;
  process.stdout.write('INSTALL    ');
  try {
    await exec(installBin!, [...installArgs], { cwd: out, timeout: 600_000 });
    console.log('dependencies installed');
  } catch (error) {
    console.log('FAILED');
    console.error(`\nlbr build could not install dependencies: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  if (plan === undefined) {
    // Nothing was available to decompose the goal — no prepared plan and no
    // credential. The scaffold stays: it installed and it compiles, so it is a
    // working project rather than a half-written directory.
    console.log(
      '\nNO PLAN    nothing can decompose this goal into steps. Pass --plan <file.json> for a\n' +
        '           prepared plan, or configure a credential for the model-backed planner.\n' +
        `           The scaffold is in ${out} and is a working project.\n`,
    );
    return;
  }

  console.log(`PLAN       ${plan.steps.length} step(s): ${plan.summary}`);
  for (const [i, step] of plan.steps.entries()) {
    console.log(`           ${i + 1}. ${step.goal}`);
  }

  const proposalsDir = flags.get('proposals');
  let completed = 0;

  for (const [i, step] of plan.steps.entries()) {
    console.log(`\n── step ${i + 1}/${plan.steps.length} · ${step.id} ─────────────────`);
    console.log(`GOAL       ${step.goal}`);
    console.log(`WHY        ${step.rationale}`);

    const proposal = await loadStepProposal(proposalsDir, step.id);
    if (proposal === undefined) {
      console.log(
        `\nSTOPPED    no proposal available for step '${step.id}'. ${completed} step(s) completed.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const outcome = await runOneStep(out, step, proposal);
    if (!outcome.ok) {
      console.log(`\nSTOPPED    step '${step.id}' did not validate: ${outcome.reason}`);
      console.log(`           ${completed} of ${plan.steps.length} step(s) completed.`);
      console.log(`           lineage: ${outcome.lineagePath ?? 'not recorded'}\n`);
      process.exitCode = 1;
      return;
    }

    // Promote: the step validated in isolation, so it lands in the app and the
    // next step builds on it.
    //
    // Through the same confined apply as the mirror, not a bare join. These
    // paths came from a proposal — model output, or a file somebody handed us —
    // and were refused lexically at parse time; this is the check that also
    // sees through a symlink, of which an installed node_modules has many. It
    // would be a strange kind of care to confine the copy and not the original.
    const promoted = await applyProposal(out, proposal, { allowNonMirror: true });
    if (promoted.refused.length > 0) {
      const reasons = promoted.refused.map((r) => `${r.path} (${r.reason})`).join(', ');
      console.log(`\nSTOPPED    step '${step.id}' validated but could not be promoted: ${reasons}`);
      console.log(`           ${completed} of ${plan.steps.length} step(s) completed.\n`);
      process.exitCode = 1;
      return;
    }
    completed++;
    console.log(`PROMOTED   step '${step.id}' is now part of the app`);
  }

  console.log(`\nBUILT      ${completed} step(s), all validated`);
  console.log(`           ${out}`);
  console.log(`           run it: ${target.runHint}\n`);
}

interface StepOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly lineagePath?: string;
}

/** One step through the same loop `run` uses. */
async function runOneStep(
  appDir: string,
  step: { id: string; goal: string; rationale: string; successCondition: string },
  proposal: ChangeProposal,
): Promise<StepOutcome> {
  const { graph } = await build(appDir);

  // Anchor on a file the step touches that already exists; otherwise the entry
  // point, which every project has.
  const anchor =
    [...graph.nodes()].find((n) =>
      proposal.edits.some((e) => n.name === e.path),
    ) ?? [...graph.nodes()].find((n) => n.name.endsWith('main.ts'));

  if (anchor === undefined) {
    return { ok: false, reason: 'the app has no node to anchor the impact walk on' };
  }

  const intent = parseIntent({
    id: `step_${step.id}_${Date.now()}`,
    goal: step.goal,
    rationale: step.rationale,
    source: 'agent',
    raisedBy: 'actor:agent:builder',
    targets: [anchor.id],
    actions: ['code_change'],
    successCondition: step.successCondition,
  });

  const impact = resolveImpact(graph, intent);
  const risk = classifyRisk(intent, impact);
  const plan = planMirror(graph, intent, impact);
  if (plan.safetyViolations.length > 0) {
    return { ok: false, reason: plan.safetyViolations.join('; ') };
  }

  const sandbox = flags.has('sandbox') ? await detectSandbox() : NO_SANDBOX;
  const executor = new LocalMirrorExecutor({
    sourceRoot: appDir,
    graph,
    nodeModulesFrom: flags.get('node-modules'),
    sandbox,
    proposal,
  });

  try {
    const mechanical = await runMechanicalValidation(intent, plan, executor);
    for (const check of mechanical.checks) {
      const ms = check.durationMs === undefined ? '' : ` ${(check.durationMs / 1000).toFixed(1)}s`;
      console.log(`  ${check.status.toUpperCase().padEnd(13)}${check.name}${ms}`);
      if (check.status === 'fail') console.log(`                ${check.detail}`);
    }

    const mirrorRoot = executor.workspace?.root;
    const after = mirrorRoot === undefined ? graph : (await build(mirrorRoot)).graph;

    // Run the tests this step itself added.
    //
    // The verification plan comes from the graph as it was *before* the change,
    // so a test the step creates cannot be in it — it did not exist when the
    // plan was made. Without this a step could add a test, never run it, and be
    // promoted on the strength of the tests it happened not to change. The new
    // tests are visible in the after-graph, which is exactly what re-ingesting
    // the mirror produces.
    const existingTests = new Set(
      [...graph.nodes()].filter((n) => n.id.startsWith('evidence:test:')).map((n) => n.id),
    );
    const addedTests = [...after.nodes()].filter(
      (n) => n.id.startsWith('evidence:test:') && !existingTests.has(n.id),
    );

    // The executor's graph predates the change, so it has no path for these.
    // What re-ingestion saw in the mirror is what it is told.
    executor.learn(addedTests);

    let addedTestsPassed = true;
    const addedTestChecks: CheckResult[] = [];
    for (const test of addedTests) {
      const outcome = await executor.runVerification(test.id, plan);
      console.log(
        `  ${(outcome.ok ? 'PASS' : 'FAIL').padEnd(13)}verify ${test.name} (added by this step)`,
      );
      addedTestChecks.push({
        name: `verify ${test.id} (added by this step)`,
        status: outcome.ok ? 'pass' : 'fail',
        detail: outcome.detail,
        nodes: [test.id],
        durationMs: outcome.durationMs,
      });
      if (!outcome.ok) {
        addedTestsPassed = false;
        console.log(`                ${outcome.detail}`);
      }
    }

    // These runs gate promotion, so they belong in the record. A lineage entry
    // that omits a check the decision turned on describes a different decision.
    const mechanicalRecorded: ValidationReport = {
      ...mechanical,
      checks: [...mechanical.checks, ...addedTestChecks],
      passed: mechanical.passed && addedTestsPassed,
    };

    const behavioral = await runBehavioralValidation({
      before: graph,
      after,
      intent,
      impact,
      evaluator: flags.has('judge') ? new ClaudeEvaluator() : undefined,
    });
    for (const check of behavioral.checks) {
      if (check.status === 'fail') {
        console.log(`  ${check.status.toUpperCase().padEnd(13)}${check.name} — ${check.detail}`);
      }
    }

    let record = openLineage({
      deploymentId: `step_${step.id}_${Date.now()}`,
      baseRevision: 'app-in-progress',
      intent,
      impact,
      risk,
      mirror: plan,
      validation: [mechanicalRecorded, behavioral],
      rollback: {
        toDeploymentId: 'previous step',
        unrecoverableNodes: [],
        steps: ['discard the mirror; the app keeps whatever last validated'],
      },
    });

    // A behavioral check that could not reach a verdict does not block a step —
    // without a judge configured, nothing can ever judge a success condition,
    // and treating that as failure would make every build impossible. A check
    // that actually failed does block.
    const behavioralFailed = behavioral.checks.some((c) => c.status === 'fail');
    const ok = mechanical.passed && addedTestsPassed && !behavioralFailed;
    record = { ...record, outcome: ok ? 'deployed' : 'abandoned' };
    const saved = await saveLineage(appDir, record, graph);

    return ok
      ? { ok: true, lineagePath: saved.path }
      : {
          ok: false,
          reason: !mechanical.passed
            ? 'the change did not build or its tests did not pass'
            : !addedTestsPassed
              ? 'a test this step added did not pass'
              : 'a behavioral check failed',
          lineagePath: saved.path,
        };
  } finally {
    await executor.dispose();
  }
}

/** A prepared build plan, so the machinery is runnable without a model. */
async function loadBuildPlan(): Promise<
  { summary: string; steps: { id: string; goal: string; rationale: string; successCondition: string }[] } | undefined
> {
  const { BuildPlanSchema } = await import('@lbr/proposer-claude');

  const file = flags.get('plan');
  if (file !== undefined && file !== 'true') {
    const { readFile } = await import('node:fs/promises');
    // Validated, not cast. The step ids become filenames — one holding the
    // step's proposal, one holding its lineage — so a plan from a file or from
    // a model is input, and `BuildStepSchema` is where its ids are constrained
    // to something that cannot climb out of either directory.
    const parsed = BuildPlanSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success) {
      // Reported as the field and the reason. A raw schema dump is technically
      // complete and practically unread, and whoever has to fix the plan is the
      // person this message is for.
      const problems = parsed.error.issues
        .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      throw new Error(`the build plan in ${file} is not usable:\n${problems}`);
    }
    return parsed.data;
  }

  // Otherwise the model decomposes the goal, which is the path this is for.
  const goal = flags.get('goal');
  const target = selectTarget(flags.get('app-target') ?? 'node-typescript');
  if (goal === undefined || goal === 'true') return undefined;

  const { decompose, credentialConfigured } = await import('@lbr/proposer-claude');
  if (!credentialConfigured()) return undefined;

  try {
    return await decompose(goal, target, { onCost: (event) => modelCosts.push(event) });
  } catch {
    // No credential, a refusal, or an unparseable plan. Half a plan builds an
    // application missing the parts nobody noticed were absent, so there is no
    // partial result to return.
    return undefined;
  }
}

async function loadStepProposal(
  dir: string | undefined,
  stepId: string,
): Promise<ChangeProposal | undefined> {
  if (dir === undefined || dir === 'true') return undefined;
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { parseChangeProposal } = await import('@lbr/runtime-core');
  try {
    const raw = await readFile(join(dir, `${stepId}.json`), 'utf8');
    return parseChangeProposal({ ...JSON.parse(raw), intentId: stepId });
  } catch {
    return undefined;
  }
}

/**
 * Where a proposal comes from.
 *
 * A prepared proposal on disk is supported because it makes the loop runnable
 * and testable with no model, no network and no credential — which is how the
 * end-to-end behavior of this command is actually verified.
 */
async function selectProposer(root?: string): Promise<ChangeProposer | undefined> {
  const file = flags.get('proposal');
  if (file !== undefined && file !== 'true') {
    const { readFile } = await import('node:fs/promises');
    const { parseChangeProposal } = await import('@lbr/runtime-core');
    const parsed = parseChangeProposal(JSON.parse(await readFile(file, 'utf8')));
    return {
      name: `prepared proposal (${file})`,
      propose: async (intent: Intent): Promise<ChangeProposal> => ({
        ...parsed,
        intentId: intent.id,
      }),
    };
  }

  // Otherwise the model writes it, which is the path this is actually for.
  const { ClaudeProposer, credentialConfigured } = await import('@lbr/proposer-claude');

  // Checked before the mirror is materialized. The SDK happily constructs a
  // keyless client and fails at request time, so "it constructed" is not an
  // answer to "can anything write a change".
  if (!credentialConfigured()) return undefined;

  return {
    name: 'claude',
    async propose(intent, graph, impact): Promise<ChangeProposal> {
      // The files the change is most likely to need, read at propose time
      // because only the impact walk knows which those are. Bounded: a prompt
      // containing the whole repository is one the model reads none of.
      const context = new Map<string, string>();
      if (root !== undefined) {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        for (const implicated of impact.implicated.slice(0, 12)) {
          const path = implicated.node.attributes['path'];
          if (typeof path !== 'string') continue;
          try {
            context.set(path, await readFile(join(root, path), 'utf8'));
          } catch {
            // A node whose file cannot be read is context the model does not
            // get, not a reason to abandon the change.
          }
        }
      }

      return new ClaudeProposer({
        context,
        onCost: (event) => modelCosts.push(event),
      }).propose(intent, graph, impact);
    },
  };
}


/**
 * Turn measured command durations into cost events.
 *
 * Compute is the one cost this executor can measure honestly: it ran the
 * commands and timed them. Model spend is attributed by whatever proposer
 * incurred it, not invented here.
 */
function collectCosts(
  mechanical: { checks: readonly { name: string; durationMs?: number }[] },
  intent: Intent,
): CostEvent[] {
  const USD_PER_SECOND = 0.0000116; // ~$0.04/hour of a small worker
  const at = new Date().toISOString();
  const target = intent.targets[0]!;

  return mechanical.checks
    .filter((c) => c.durationMs !== undefined && c.durationMs > 0)
    .map((c) => ({
      nodeId: target,
      category: 'compute' as const,
      usd: Math.round((c.durationMs! / 1000) * USD_PER_SECOND * 1e6) / 1e6,
      at,
      detail: { durationMs: c.durationMs! },
    }));
}

function usage(): void {
  console.error('usage:');
  console.error('  lbr ingest   <dir> [--out graph.json]');
  console.error('  lbr impact   <dir> <file> [--action code_change|data_delete|restart|…]');
  console.error(
    '  lbr validate <dir> <file> [--action …] [--node-modules <dir>] [--sandbox] [--judge]',
  );
  console.error(
    '  lbr run      <dir> --goal "..." [--target <file>] [--apply] [--sandbox] [--judge]',
  );
  console.error(
    '  lbr build    --goal "..." --out <dir> [--app-target node-typescript] [--plan <file>]',
  );
  console.error('                 [--proposals <dir>] [--sandbox]');
  process.exit(1);
}
