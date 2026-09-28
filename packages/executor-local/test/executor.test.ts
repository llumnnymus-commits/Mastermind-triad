import { describe, it, expect, afterEach } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProjectGraph,
  planMirror,
  parseIntent,
  resolveImpact,
  runMechanicalValidation,
  type MirrorPlan,
} from '@lbr/runtime-core';
import { LocalMirrorExecutor } from '../src/executor.js';
import type { AllowedCommand } from '../src/commands.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture-project');

/**
 * A graph describing the fixture project, written the way the TypeScript
 * adapter would emit it: file-backed nodes carrying a `path` attribute.
 */
function fixtureGraph(pathOverrides: Record<string, string> = {}): ProjectGraph {
  return ProjectGraph.from(
    [
      {
        id: 'code:module:src_alpha',
        kind: 'module',
        name: 'src/alpha.ts',
        attributes: { path: pathOverrides['alpha'] ?? 'src/alpha.ts' },
      },
      {
        id: 'code:module:src_beta',
        kind: 'module',
        name: 'src/beta.ts',
        attributes: { path: pathOverrides['beta'] ?? 'src/beta.ts' },
      },
      {
        id: 'evidence:test:src_beta_test',
        kind: 'test',
        name: 'src/beta.test.ts',
        attributes: { path: pathOverrides['test'] ?? 'src/beta.test.ts' },
      },
    ],
    [
      { from: 'code:module:src_beta', type: 'depends_on', to: 'code:module:src_alpha' },
      { from: 'code:module:src_beta', type: 'verified_by', to: 'evidence:test:src_beta_test' },
    ],
  );
}

function planFor(graph: ProjectGraph, target = 'code:module:src_alpha') {
  const intent = parseIntent({
    id: 'intent_exec',
    goal: 'Change alpha',
    rationale: 'test',
    source: 'human',
    raisedBy: 'actor:human:cli',
    targets: [target],
    actions: ['code_change'],
    successCondition: 'still builds',
  });
  const impact = resolveImpact(graph, intent);
  return { intent, impact, plan: planMirror(graph, intent, impact) };
}

/** Commands that exercise the real execution path without needing a toolchain. */
const fakeCommands: Record<string, AllowedCommand> = {
  build: { file: 'node', args: ['-e', 'console.log("built")'] },
  typecheck: { file: 'node', args: ['-e', 'console.log("typechecked")'] },
  test: { file: 'node', args: ['-e', 'console.log("ran " + (process.argv[1] ?? "all"))'] },
};

const failing: Record<string, AllowedCommand> = {
  ...fakeCommands,
  build: { file: 'node', args: ['-e', 'console.error("compile error on line 4"); process.exit(1)'] },
};

let open: LocalMirrorExecutor | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

describe('the executor actually runs things', () => {
  it('builds in a real workspace and reports where', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.build(plan);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('lbr-mirror-');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces a real build failure with its compiler output', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: failing });

    const outcome = await open.build(plan);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('compile error on line 4');
  });

  it('runs a verification scoped to the node that must pass', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.runVerification('evidence:test:src_beta_test', plan);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('src/beta.test.ts');
  });

  it('drives a full mechanical validation pass end to end', async () => {
    const graph = fixtureGraph();
    const { intent, plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const report = await runMechanicalValidation(intent, plan, open);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.name).slice(0, 3)).toEqual(['build', 'start', 'connect']);
    expect(report.checks.some((c) => c.name.startsWith('verify'))).toBe(true);
  });
});

describe('the executor refuses what it should refuse', () => {
  it('will not materialize a workspace for a plan that violates isolation', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    const unsafe: MirrorPlan = { ...plan, safetyViolations: ['would bind to production state'] };
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.build(unsafe);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('refusing to materialize');
    expect(open.workspace).toBeUndefined(); // nothing was created
  });

  it('refuses a verification whose path escapes the workspace', async () => {
    // The adapter that produced this node was reading someone else's repo.
    const graph = fixtureGraph({ test: '../../../../etc/passwd' });
    const { plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.runVerification('evidence:test:src_beta_test', plan);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('outside the workspace');
  });

  it('fails connect when a node planned as real is missing from the mirror', async () => {
    const graph = fixtureGraph({ alpha: 'src/does-not-exist.ts' });
    const { plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.connect(plan);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('absent from the mirror');
  });

  it('fails connect when the plan needs a snapshot this executor cannot restore', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    const needsData: MirrorPlan = { ...plan, snapshotsRequired: ['service:database:accounts'] };
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.connect(needsData);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('cannot restore');
  });

  it('reports having no test command rather than passing silently', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    const noTest = { build: fakeCommands['build']!, typecheck: fakeCommands['typecheck']! };
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: noTest });

    const outcome = await open.runVerification('evidence:test:src_beta_test', plan);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('nothing verifies this change');
  });

  it('reports a node that carries no path rather than guessing one', async () => {
    const graph = fixtureGraph();
    graph.addNode({ id: 'evidence:test:pathless', kind: 'test', name: 'pathless' });
    const { plan } = planFor(graph);
    open = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });

    const outcome = await open.runVerification('evidence:test:pathless', plan);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('carries no path');
  });

  it('cleans up the workspace on dispose', async () => {
    const graph = fixtureGraph();
    const { plan } = planFor(graph);
    const executor = new LocalMirrorExecutor({ sourceRoot: fixture, graph, commands: fakeCommands });
    await executor.build(plan);
    const root = executor.workspace!.root;
    await executor.dispose();
    const { access } = await import('node:fs/promises');
    await expect(access(root)).rejects.toThrow();
  });
});
