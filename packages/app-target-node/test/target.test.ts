import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseChangeProposal } from '@lbr/runtime-core';
import { nodeAppTarget, selectTarget } from '../src/index.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('the scaffold', () => {
  it('produces the files a working project needs', () => {
    const paths = nodeAppTarget.scaffold('notes').map((e) => e.path).sort();
    expect(paths).toEqual(['package.json', 'src/main.test.ts', 'src/main.ts', 'tsconfig.json']);
  });

  it('passes through the same validation as any other change', () => {
    // The scaffold travels as FileEdits deliberately: a scaffold written by a
    // privileged side-channel would be the one change in the system that
    // nothing checked.
    expect(() =>
      parseChangeProposal({
        intentId: 'scaffold',
        rationale: 'scaffold',
        edits: nodeAppTarget.scaffold('notes'),
      }),
    ).not.toThrow();
  });

  it('sanitizes a name that would produce an invalid package', () => {
    const edits = nodeAppTarget.scaffold('My Notes App!!');
    const pkg = edits.find((e) => e.path === 'package.json')!;
    const parsed = JSON.parse('contents' in pkg ? pkg.contents : '{}') as { name: string };
    expect(parsed.name).toBe('my-notes-app');
  });

  it('falls back to a usable name when nothing survives sanitizing', () => {
    const edits = nodeAppTarget.scaffold('!!!');
    const pkg = edits.find((e) => e.path === 'package.json')!;
    const parsed = JSON.parse('contents' in pkg ? pkg.contents : '{}') as { name: string };
    expect(parsed.name).toBe('app');
  });

  it('rejects an unknown target by name rather than silently doing nothing', () => {
    expect(() => selectTarget('android')).toThrow(/unknown app target 'android'/);
  });
});

describe('the scaffold really is a working project', () => {
  it('compiles and its test passes as a standalone project', async () => {
    // The claim that matters. A scaffold that does not build makes every
    // subsequent step fail for a reason that has nothing to do with the step.
    const dir = await mkdtemp(join(tmpdir(), 'lbr-scaffold-'));
    dirs.push(dir);

    for (const edit of nodeAppTarget.scaffold('scaffold-check')) {
      if ('delete' in edit) continue;
      await mkdir(dirname(join(dir, edit.path)), { recursive: true });
      await writeFile(join(dir, edit.path), edit.contents);
    }

    // Installed for real rather than borrowing the monorepo's node_modules.
    // Linking hid the fact that the scaffold was not a standalone project: it
    // compiled here and would not have compiled anywhere else.
    await run('npm', [...nodeAppTarget.installCommand.slice(1)], { cwd: dir, timeout: 600_000 });

    const build = await run('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: dir, timeout: 120_000 });
    expect(build.stderr).toBe('');

    const test = await run('npx', ['vitest', 'run'], { cwd: dir, timeout: 120_000 });
    expect(`${test.stdout}${test.stderr}`).toMatch(/1 passed/);

    const started = await run(process.execPath, ['dist/main.js'], { cwd: dir, timeout: 30_000 });
    expect(started.stdout.trim()).toBe('scaffold-check');
    // A real `npm install` and two real compilers; vitest's 5s default cuts it
    // off mid-install and reports a timeout where there is no failure.
  }, 600_000);
});
