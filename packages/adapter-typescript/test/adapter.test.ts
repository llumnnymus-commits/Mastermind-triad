import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProjectGraph, resolveImpact, parseIntent } from '@lbr/runtime-core';
import { TypeScriptAdapter, extractImports } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture-project');

async function ingestFixture() {
  const result = await new TypeScriptAdapter().ingest(fixture);
  const graph = new ProjectGraph();
  for (const node of result.nodes) graph.addNode(node);
  for (const edge of result.edges) graph.addEdge(edge);
  return { result, graph };
}

describe('import extraction', () => {
  it('finds every form of module reference, not just static imports', () => {
    // A regex-based adapter misses most of these, and every missed edge is a
    // node absent from a blast radius that a change will still break.
    const found = extractImports(
      'service.ts',
      `
        import { run } from './core/engine.js';
        import type { help } from './core/helpers.js';
        export * from './barrel.js';
        export { thing } from './named.js';
        const later = await import('./dynamic.js');
        import bare from 'zod';
      `,
    );
    expect(found).toContain('./core/engine.js');
    expect(found).toContain('./core/helpers.js'); // type-only still breaks the build
    expect(found).toContain('./barrel.js'); // export * from
    expect(found).toContain('./named.js');
    expect(found).toContain('./dynamic.js'); // dynamic import
    expect(found).toContain('zod');
  });

  it('deduplicates repeated references to the same module', () => {
    const found = extractImports(
      'x.ts',
      `import { a } from './m.js'; import type { B } from './m.js';`,
    );
    expect(found).toEqual(['./m.js']);
  });
});

describe('ingesting a real source tree', () => {
  it('creates a module node per source file', async () => {
    const { graph } = await ingestFixture();
    const ids = [...graph.nodes()].map((n) => n.id);
    expect(ids).toContain('code:module:src_service');
    expect(ids).toContain('code:module:src_core_engine');
    expect(ids).toContain('code:module:src_app');
  });

  it('resolves .js specifiers to the .ts files that actually exist', async () => {
    // TypeScript ESM source imports its own emitted output. Assuming the
    // specifier names a real file on disk drops every internal edge.
    const { graph } = await ingestFixture();
    const deps = graph
      .outbound('code:module:src_service')
      .filter((a) => a.edge.type === 'depends_on')
      .map((a) => a.other);
    expect(deps).toContain('code:module:src_core_engine');
    expect(deps).toContain('code:module:src_core_helpers');
  });

  it('records external packages as unresolved rather than inventing nodes', async () => {
    const { result, graph } = await ingestFixture();
    expect(result.unresolved.some((u) => u.reference === 'zod')).toBe(true);
    expect([...graph.nodes()].map((n) => n.id)).not.toContain('code:module:zod');
  });

  it('makes a test a proof obligation, not a dependent', async () => {
    // A test importing a module verifies it. Modelling that as `depends_on`
    // would put every test in the repo in the blast radius of every change —
    // true, and useless.
    const { graph } = await ingestFixture();
    const testNode = [...graph.nodes()].find((n) => n.id.startsWith('evidence:test:'));
    expect(testNode).toBeDefined();

    const verifies = graph
      .inbound(testNode!.id)
      .filter((a) => a.edge.type === 'verified_by')
      .map((a) => a.other);
    expect(verifies).toContain('code:module:src_service');

    const asDependent = graph
      .outbound(testNode!.id)
      .filter((a) => a.edge.type === 'depends_on');
    expect(asDependent).toEqual([]);
  });

  it('answers what breaks when a real file changes', async () => {
    const { graph } = await ingestFixture();
    const impact = resolveImpact(
      graph,
      parseIntent({
        id: 'i_engine',
        goal: 'Change the engine',
        rationale: 'test',
        source: 'human',
        raisedBy: 'actor:human:cli',
        targets: ['code:module:src_core_engine'],
        actions: ['code_change'],
        successCondition: 'still runs',
      }),
    );

    const blast = impact.blastRadius.map((n) => n.id);
    expect(blast).toContain('code:module:src_service'); // imports engine directly
    expect(blast).toContain('code:module:src_app'); // imports service, transitively at risk

    // And the test that covers it comes back as the thing that must pass.
    expect(impact.verifications.map((v) => v.id)).toContain('evidence:test:test_service_test');
  });

  it('scores the direct importer above the transitive one', async () => {
    const { graph } = await ingestFixture();
    const impact = resolveImpact(
      graph,
      parseIntent({
        id: 'i_engine2',
        goal: 'Change the engine',
        rationale: 'test',
        source: 'human',
        raisedBy: 'actor:human:cli',
        targets: ['code:module:src_core_engine'],
        actions: ['code_change'],
        successCondition: 'still runs',
      }),
    );
    const score = (id: string) => impact.implicated.find((n) => n.id === id)!.score;
    expect(score('code:module:src_service')).toBeGreaterThan(score('code:module:src_app'));
  });

  it('skips build output and dependency directories', async () => {
    const { graph } = await ingestFixture();
    expect([...graph.nodes()].every((n) => !n.name.includes('node_modules'))).toBe(true);
    expect([...graph.nodes()].every((n) => !n.name.includes('dist/'))).toBe(true);
  });

  it('produces a graph that validates against the core schema', async () => {
    // The adapter emits raw objects; ProjectGraph.addNode parses them. If ids
    // or kinds were malformed this would have thrown during ingest.
    const { graph } = await ingestFixture();
    expect(graph.size.nodes).toBeGreaterThan(0);
    expect(graph.size.edges).toBeGreaterThan(0);
  });
});

describe('mirrors are not source', () => {
  it('does not ingest a materialized mirror as if it were the project', async () => {
    // Mirrors are created inside the repository so dependency resolution still
    // works. They are copies, so ingesting one duplicates every node under a
    // second set of ids — and a graph that double-counts the system is not a
    // model of it.
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const mirrorDir = join(fixture, '.lbr-mirrors', 'run-1', 'src');
    try {
      await mkdir(mirrorDir, { recursive: true });
      await writeFile(join(mirrorDir, 'service.ts'), `export const copied = 1;`);

      const { graph } = await ingestFixture();
      const names = [...graph.nodes()].map((n) => n.name);
      expect(names.every((n) => !n.includes('.lbr-mirrors'))).toBe(true);
    } finally {
      await rm(join(fixture, '.lbr-mirrors'), { recursive: true, force: true });
    }
  });
});

describe('ingest stays inside the tree it was pointed at', () => {
  it('does not follow a symlink out of the source and index host files', async () => {
    // Verified proof of concept from a security review: `ingest` runs no
    // commands at all, so a repository containing `escape -> /somewhere` could
    // have every .ts file under that target read, indexed, and written into a
    // graph that is then serialized and shared — with no build step and no
    // sandbox escape needed.
    const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const outside = await mkdtemp(join(tmpdir(), 'lbr-host-'));
    const repo = await mkdtemp(join(tmpdir(), 'lbr-evil-'));
    try {
      await mkdir(join(outside, 'internal'), { recursive: true });
      await writeFile(
        join(outside, 'internal', 'creds.ts'),
        `import x from '@acme/internal-billing-secrets';\nexport default x;`,
      );
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'app.ts'), 'export const app = 1;');
      await symlink(outside, join(repo, 'escape'), 'dir');

      const result = await new TypeScriptAdapter().ingest(repo);
      const names = result.nodes.map((n) => n.name);

      expect(names).toContain('src/app.ts');
      expect(names.every((n) => !n.includes('escape'))).toBe(true);
      expect(names.every((n) => !n.includes('creds'))).toBe(true);
      // Nor should the file's import strings leak in through an edge.
      expect(
        result.unresolved.every((u) => !u.reference.includes('internal-billing-secrets')),
      ).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
