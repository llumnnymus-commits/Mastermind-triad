#!/usr/bin/env node
/**
 * lbr — drive the Live Build Runtime against a real project.
 *
 *   lbr ingest   <dir>                  build the graph, report what is in it
 *   lbr impact   <dir> <file>           what a change to this file would touch
 *   lbr validate <dir> <file>           the whole loop, running the real build and tests
 *
 * `impact` answers the question the substrate exists for. `validate` goes
 * further and actually does it: materializes an isolated mirror, runs the
 * build, and runs only the tests attached to the nodes the change implicates.
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
  type ActionClass,
  type GraphNode,
} from '@lbr/runtime-core';
import { TypeScriptAdapter } from '@lbr/adapter-typescript';
import { LocalMirrorExecutor } from '@lbr/executor-local';

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
    default:
      usage();
  }
} catch (error) {
  console.error(`\nlbr: ${(error as Error).message}\n`);
  process.exit(1);
}

async function build(dir: string): Promise<{ graph: ProjectGraph; unresolved: number }> {
  const result = await new TypeScriptAdapter().ingest(dir);
  const graph = new ProjectGraph();
  for (const node of result.nodes) graph.addNode(node);
  for (const edge of result.edges) graph.addEdge(edge);
  return { graph, unresolved: result.unresolved.length };
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

  const { graph, unresolved } = await build(dir);
  const size = graph.size;
  console.log(`ingested ${size.nodes} nodes, ${size.edges} edges from ${dir}`);
  console.log(`${unresolved} external reference(s) recorded as unresolved`);

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
    `IMPACT     ${impactResult.structuralCount} structural nodes · magnitude ${impactResult.magnitude}`,
  );
  console.log(
    `AUTHORITY  ${risk.tier.toUpperCase()}${risk.requiresApproval ? ' · approval required' : ' · unattended'}`,
  );
  console.log(
    `MIRROR     ${plan.nodes.filter((n) => n.mode === 'real').length} real · ${plan.nodes.filter((n) => n.mode === 'stub').length} stubbed · ${plan.verificationPlan.length} test(s) to run`,
  );

  if (plan.safetyViolations.length > 0) {
    console.log(`\nREFUSED    ${plan.safetyViolations.join('; ')}\n`);
    process.exit(2);
  }

  const executor = new LocalMirrorExecutor({
    sourceRoot: dir,
    graph,
    nodeModulesFrom: flags.get('node-modules'),
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
    for (const caveat of executor.workspace?.caveats ?? []) {
      console.log(`  caveat    ${caveat}`);
    }
    console.log();
    if (!mechanical.passed) process.exit(1);
  } finally {
    await executor.dispose();
  }
}

function usage(): void {
  console.error('usage:');
  console.error('  lbr ingest   <dir> [--out graph.json]');
  console.error('  lbr impact   <dir> <file> [--action code_change|data_delete|restart|…]');
  console.error('  lbr validate <dir> <file> [--action …] [--node-modules <dir>]');
  process.exit(1);
}
