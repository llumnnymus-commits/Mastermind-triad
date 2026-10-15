import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGraph, planMirror, parseIntent, resolveImpact } from '@lbr/runtime-core';
import { LocalMirrorExecutor } from '../src/executor.js';
import { CommandRunner } from '../src/commands.js';
import { createWorkspace, resolveInWorkspace } from '../src/workspace.js';
import type { AllowedCommand } from '../src/commands.js';

/**
 * Regression tests for findings from a security review of this package.
 *
 * Each one encodes a verified proof of concept. The threat model throughout:
 * the graph is filled by adapters reading repositories from elsewhere, so node
 * attributes are attacker-controlled, and ingesting a repository must not
 * amount to running it.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const echoArgs: Record<string, AllowedCommand> = {
  build: { file: 'node', args: ['-e', 'console.log("built")'] },
  typecheck: { file: 'node', args: ['-e', 'console.log("ok")'] },
  test: { file: 'node', args: ['-e', 'console.log("ARGS:" + process.argv.slice(1).join("|"))'] },
};

describe('an appended argument cannot become an option', () => {
  it('refuses a value that the invoked tool would read as a flag', async () => {
    // `vitest run <filter>` takes a path substring; `vitest run --config=X`
    // takes a config file. A repository containing a file named `--config=…`
    // could otherwise redirect the runner at anything on the host, with
    // shell:false fully intact and entirely beside the point.
    const dir = await scratch('lbr-optinj-');
    const runner = new CommandRunner({ cwd: dir });
    const result = await runner.run(
      { file: 'node', args: ['-e', 'console.log("should not run")'] },
      ['--config=/etc/passwd'],
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('read as options rather than operands');
    expect(result.stdout).not.toContain('should not run');
  });

  it('still allows an ordinary operand through', async () => {
    const dir = await scratch('lbr-operand-');
    const runner = new CommandRunner({ cwd: dir });
    const result = await runner.run(
      { file: 'node', args: ['-e', 'console.log(process.argv[1])'] },
      ['./src/thing.test.ts'],
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('./src/thing.test.ts');
  });

  it('passes a verification path as an explicitly relative operand', async () => {
    // Belt and braces with the guard above: even a legitimate path is prefixed
    // so it cannot begin with a dash.
    const source = await scratch('lbr-operand-src-');
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src', 'a.test.ts'), 'export const a = 1;');

    const graph = ProjectGraph.from(
      [
        {
          id: 'evidence:test:a',
          kind: 'test',
          name: 'a',
          attributes: { path: 'src/a.test.ts' },
        },
      ],
      [],
    );
    const intent = parseIntent({
      id: 'i_operand',
      goal: 'x',
      rationale: 'x',
      source: 'human',
      raisedBy: 'actor:human:cli',
      targets: ['evidence:test:a'],
      actions: ['code_change'],
      successCondition: 'x',
    });
    const plan = planMirror(graph, intent, resolveImpact(graph, intent));
    const executor = new LocalMirrorExecutor({
      sourceRoot: source,
      graph,
      commands: echoArgs,
      parentDir: await scratch('lbr-operand-mirrors-'),
    });
    try {
      const outcome = await executor.runVerification('evidence:test:a', plan);
      expect(outcome.ok).toBe(true);
    } finally {
      await executor.dispose();
    }
  });
});

describe('containment is decided on the real filesystem, not the string', () => {
  it('refuses a path that reaches outside through a symlink', async () => {
    // A lexical check cannot see a link. `escape/secret.txt` contains no `..`
    // and is not absolute, so string containment accepts it while the file it
    // names sits outside the workspace entirely.
    const outside = await scratch('lbr-outside-');
    await writeFile(join(outside, 'secret.txt'), 'host data');

    const workspace = await scratch('lbr-ws-');
    await symlink(outside, join(workspace, 'escape'), 'dir');

    expect(await resolveInWorkspace(workspace, 'escape/secret.txt')).toBeUndefined();
  });

  it('still accepts an ordinary file that really is inside', async () => {
    const workspace = await scratch('lbr-ws-ok-');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), 'export const a = 1;');
    expect(await resolveInWorkspace(workspace, 'src/a.ts')).toBe(join(workspace, 'src/a.ts'));
  });

  it('accepts a file the plan expects but the mirror lacks, so connect can report it', async () => {
    // Containment must still be decidable for something that does not exist —
    // a missing file is exactly what `connect` is there to catch, and it is a
    // different failure from an escaping one.
    const workspace = await scratch('lbr-ws-missing-');
    expect(await resolveInWorkspace(workspace, 'src/not-yet.ts')).toBe(
      join(workspace, 'src/not-yet.ts'),
    );
  });
});

describe('a symlink out of the source tree never reaches the mirror', () => {
  it('drops the link and says it did', async () => {
    const outside = await scratch('lbr-link-target-');
    await writeFile(join(outside, 'host-secret.txt'), 'do not copy me');

    const source = await scratch('lbr-link-src-');
    await writeFile(join(source, 'real.ts'), 'export const real = 1;');
    await symlink(outside, join(source, 'escape'), 'dir');

    const plan = planMirror(
      ProjectGraph.from([], []),
      parseIntent({
        id: 'i_link',
        goal: 'x',
        rationale: 'x',
        source: 'human',
        raisedBy: 'actor:human:cli',
        targets: ['code:module:x'],
        actions: ['code_change'],
        successCondition: 'x',
      }),
      {
        intentId: 'i_link',
        targets: [],
        implicated: [],
        blastRadius: [],
        constraints: [],
        verifications: [],
        irreversible: [],
        live: [],
        structuralCount: 0,
        magnitude: 0,
        violations: [],
        domainsTouched: [],
      },
    );

    const workspace = await createWorkspace(plan, {
      sourceRoot: source,
      parentDir: await scratch('lbr-link-mirrors-'),
    });
    try {
      await expect(access(join(workspace.root, 'real.ts'))).resolves.toBeUndefined();
      await expect(access(join(workspace.root, 'escape'))).rejects.toThrow();
      expect(workspace.caveats.some((c) => c.includes('symlink'))).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });
});
