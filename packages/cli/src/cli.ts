#!/usr/bin/env node
/**
 * lbr — drive the Live Build Runtime against a real project.
 *
 *   lbr ingest   <dir>                  build the graph, report what is in it
 *   lbr impact   <dir> <file>           what a change to this file would touch
 *   lbr validate <dir> <file>           the whole loop against the tree as it stands
 *   lbr run      <dir> --goal "..."     propose a change, apply it, validate it
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
  type CostEvent,
  type GraphNode,
  type Intent,
} from '@lbr/runtime-core';
import { TypeScriptAdapter } from '@lbr/adapter-typescript';
import { PolicyAdapter, DEFAULT_POLICY_PATH } from '@lbr/adapter-policy';
import { LocalMirrorExecutor, detectSandbox, NO_SANDBOX } from '@lbr/executor-local';
import { ClaudeEvaluator } from '@lbr/evaluator-claude';

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

  const proposer = await selectProposer();
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

    const costs = collectCosts(mechanical, intent);
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
 * Where a proposal comes from.
 *
 * A prepared proposal on disk is supported because it makes the loop runnable
 * and testable with no model, no network and no credential — which is how the
 * end-to-end behavior of this command is actually verified.
 */
async function selectProposer(): Promise<ChangeProposer | undefined> {
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
  return undefined;
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
  process.exit(1);
}
