#!/usr/bin/env node
/**
 * lbr — ask the runtime what a change to a real source tree would touch.
 *
 *   npx tsx packages/adapter-typescript/src/cli.ts ingest <dir>
 *   npx tsx packages/adapter-typescript/src/cli.ts impact <dir> <file> [--action <class>]
 *
 * `impact` is the question the whole substrate exists to answer: given this
 * file is about to change, what breaks, what constrains it, what has to pass,
 * and may an agent do it unattended.
 */
import { writeFileSync } from 'node:fs';
import {
  ProjectGraph,
  resolveImpact,
  classifyRisk,
  buildApprovalRequest,
  parseIntent,
  serializeGraph,
  type ActionClass,
} from '@lbr/runtime-core';
import { TypeScriptAdapter } from './index.js';

const [command, ...rest] = process.argv.slice(2);

const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const token = rest[i]!;
  if (token.startsWith('--')) {
    flags.set(token.slice(2), rest[++i] ?? '');
  } else {
    positional.push(token);
  }
}

switch (command) {
  case 'ingest':
    await ingest();
    break;
  case 'impact':
    await impact();
    break;
  default:
    usage();
}

async function build(dir: string): Promise<{ graph: ProjectGraph; unresolvedCount: number }> {
  const result = await new TypeScriptAdapter().ingest(dir);
  const graph = new ProjectGraph();
  for (const node of result.nodes) graph.addNode(node);
  for (const edge of result.edges) graph.addEdge(edge);
  return { graph, unresolvedCount: result.unresolved.length };
}

async function ingest(): Promise<void> {
  const dir = positional[0];
  if (dir === undefined) return usage();

  const { graph, unresolvedCount } = await build(dir);
  const size = graph.size;
  console.log(`ingested ${size.nodes} nodes, ${size.edges} edges from ${dir}`);
  console.log(`${unresolvedCount} external reference(s) recorded as unresolved`);

  const out = flags.get('out');
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify(serializeGraph(graph), null, 2));
    console.log(`written to ${out}`);
  }
}

async function impact(): Promise<void> {
  const [dir, target] = positional;
  if (dir === undefined || target === undefined) return usage();

  const { graph } = await build(dir);
  const node = [...graph.nodes()].find(
    (n) => n.name === target || n.name.endsWith(target) || n.id === target,
  );
  if (node === undefined) {
    console.error(`no node matches '${target}'`);
    console.error('try one of:');
    for (const candidate of [...graph.nodes()].slice(0, 10)) console.error(`  ${candidate.name}`);
    process.exit(1);
  }

  const action = (flags.get('action') ?? 'code_change') as ActionClass;
  const intent = parseIntent({
    id: `cli_${Date.now()}`,
    goal: `Change ${node.name}`,
    rationale: 'asked from the command line',
    source: 'human',
    raisedBy: 'actor:human:cli',
    targets: [node.id],
    actions: [action],
    successCondition: 'the change does what was intended and nothing else breaks',
  });

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
    console.log('\nMUST PASS\n  nothing — no test covers this file, so a failure here would be silent');
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

function usage(): void {
  console.error('usage:');
  console.error('  lbr ingest <dir> [--out graph.json]');
  console.error('  lbr impact <dir> <file> [--action code_change|data_delete|restart|…]');
  process.exit(1);
}
