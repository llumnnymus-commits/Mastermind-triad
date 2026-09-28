import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'dist', 'cli.js');
const fixtureSource = join(here, 'fixture');

/**
 * The CLI is exercised as a subprocess rather than by importing its internals.
 *
 * It is the surface people actually use, and argument parsing, exit codes and
 * the "nothing was written" guarantees are only real when the real binary runs.
 * A unit test of an extracted helper would prove none of them.
 */
async function lbr(args: string[], cwd = process.cwd()): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cliEntry, ...args], {
      cwd,
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A throwaway copy of the fixture, so a run that writes cannot affect the next test. */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lbr-cli-fixture-'));
  scratch.push(dir);
  await cp(fixtureSource, dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  await readFile(cliEntry).catch(() => {
    throw new Error(`CLI is not built at ${cliEntry} — run \`npm run build\` first`);
  });
});

describe('argument handling', () => {
  it('prints usage and exits non-zero with no command', async () => {
    const result = await lbr([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('usage:');
  });

  it('lists every command in usage', async () => {
    const { stderr } = await lbr(['nonsense-command']);
    for (const command of ['ingest', 'impact', 'validate', 'run']) {
      expect(stderr).toContain(`lbr ${command}`);
    }
  });

  it('requires a goal for run', async () => {
    const dir = await project();
    const result = await lbr(['run', dir], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('usage:');
  });

  it('requires a target to anchor the impact walk', async () => {
    // Without one the walk would have to start from the whole surface, which
    // on a real repository is too broad to mean anything.
    const dir = await project();
    const result = await lbr(['run', dir, '--goal', 'do something'], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--target');
  });

  it('explains itself when a file matches nothing, and suggests real ones', async () => {
    const dir = await project();
    const result = await lbr(['impact', dir, 'does-not-exist.ts'], dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no node matches');
    expect(result.stderr).toContain('src/');
  });
});

describe('ingest', () => {
  it('reports what it found', async () => {
    const dir = await project();
    const { stdout } = await lbr(['ingest', dir], dir);
    expect(stdout).toMatch(/ingested \d+ nodes, \d+ edges/);
  });

  it('says plainly when no policy is declared', async () => {
    const dir = await project();
    const { stdout } = await lbr(['ingest', dir], dir);
    expect(stdout).toContain('no policy declared');
  });

  it('writes a serialized graph on request', async () => {
    const dir = await project();
    const out = join(dir, 'graph.json');
    await lbr(['ingest', dir, '--out', out], dir);
    const parsed = JSON.parse(await readFile(out, 'utf8')) as { version: number; nodes: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.nodes.length).toBeGreaterThan(0);
  });
});

describe('impact', () => {
  it('reports a blast radius for a file things depend on', async () => {
    const dir = await project();
    const { stdout } = await lbr(['impact', dir, 'src/core.ts'], dir);
    expect(stdout).toContain('BREAKS IF THIS IS WRONG');
    expect(stdout).toContain('src/app.ts');
  });

  it('says so plainly when nothing depends on a file', async () => {
    const dir = await project();
    const { stdout } = await lbr(['impact', dir, 'src/unrelated.ts'], dir);
    expect(stdout).toContain('nothing depends on this file');
  });

  it('re-classifies the same blast radius under a different action', async () => {
    const dir = await project();
    const routine = await lbr(['impact', dir, 'src/core.ts'], dir);
    const destructive = await lbr(['impact', dir, 'src/core.ts', '--action', 'data_delete'], dir);
    expect(routine.stdout).not.toContain('approval required');
    expect(destructive.stdout).toContain('approval required');
  });
});

describe('run does not write without being told to', () => {
  it('proposes but changes nothing without --apply', async () => {
    const dir = await project();
    const before = await readFile(join(dir, 'src/core.ts'), 'utf8');

    const proposal = join(dir, 'p.json');
    await writeFile(
      proposal,
      JSON.stringify({
        intentId: 'x',
        rationale: 'would rewrite core',
        edits: [{ path: 'src/core.ts', contents: 'export const core = 999;' }],
      }),
    );

    const { stdout } = await lbr(
      ['run', dir, '--goal', 'change core', '--target', 'src/core.ts', '--proposal', proposal],
      dir,
    );

    expect(stdout).toContain('NOT APPLIED');
    expect(await readFile(join(dir, 'src/core.ts'), 'utf8')).toBe(before);
  });

  it('reports having no proposer rather than silently doing nothing', async () => {
    const dir = await project();
    const { stdout } = await lbr(
      ['run', dir, '--goal', 'change core', '--target', 'src/core.ts'],
      dir,
    );
    expect(stdout).toContain('NO PROPOSER');
  });
});

describe('run applies a real change, and only inside the mirror', () => {
  it('leaves the source tree untouched even when it applies', async () => {
    // The guarantee the whole mirror exists for.
    const dir = await project();
    const before = await readFile(join(dir, 'src/core.ts'), 'utf8');

    const proposal = join(dir, 'p.json');
    await writeFile(
      proposal,
      JSON.stringify({
        intentId: 'x',
        rationale: 'add a constant',
        edits: [{ path: 'src/core.ts', contents: `${before}\nexport const added = 2;\n` }],
      }),
    );

    const { stdout } = await lbr(
      [
        'run', dir,
        '--goal', 'add a constant to core',
        '--target', 'src/core.ts',
        '--proposal', proposal,
        '--apply',
      ],
      dir,
    );

    expect(stdout).toContain('APPLIED');
    expect(stdout).toContain('the working tree is untouched');
    expect(await readFile(join(dir, 'src/core.ts'), 'utf8')).toBe(before);
  });

  it('produces a real diff, which validate never could', async () => {
    const dir = await project();
    const before = await readFile(join(dir, 'src/core.ts'), 'utf8');
    const proposal = join(dir, 'p.json');
    await writeFile(
      proposal,
      JSON.stringify({
        intentId: 'x',
        rationale: 'add a constant',
        edits: [{ path: 'src/core.ts', contents: `${before}\nexport const added = 2;\n` }],
      }),
    );

    const { stdout } = await lbr(
      ['run', dir, '--goal', 'add a constant', '--target', 'src/core.ts', '--proposal', proposal, '--apply'],
      dir,
    );

    expect(stdout).toMatch(/DIFF\s+\d+ node\(s\) added, [1-9]/);
  });

  it('persists lineage that outlives the run', async () => {
    const dir = await project();
    const before = await readFile(join(dir, 'src/core.ts'), 'utf8');
    const proposal = join(dir, 'p.json');
    await writeFile(
      proposal,
      JSON.stringify({
        intentId: 'x',
        rationale: 'add a constant',
        edits: [{ path: 'src/core.ts', contents: `${before}\nexport const added = 2;\n` }],
      }),
    );

    await lbr(
      ['run', dir, '--goal', 'add a constant', '--target', 'src/core.ts', '--proposal', proposal, '--apply'],
      dir,
    );

    const records = await readdir(join(dir, '.lbr/lineage'));
    expect(records.length).toBe(1);
    const stored = JSON.parse(await readFile(join(dir, '.lbr/lineage', records[0]!), 'utf8')) as {
      version: number;
      record: { intent: { goal: string } };
    };
    expect(stored.version).toBe(1);
    expect(stored.record.intent.goal).toBe('add a constant');
  });
});

describe('scope adherence catches a change that exceeded what it claimed', () => {
  it('fails when a proposal edits a file nothing predicted', async () => {
    // The check the whole substrate is built around, and which could never run
    // before a change was actually applied. `src/unrelated.ts` is not reachable
    // from `src/core.ts`, so editing both is a scope escape.
    const dir = await project();
    const core = await readFile(join(dir, 'src/core.ts'), 'utf8');
    const unrelated = await readFile(join(dir, 'src/unrelated.ts'), 'utf8');

    const proposal = join(dir, 'p.json');
    await writeFile(
      proposal,
      JSON.stringify({
        intentId: 'x',
        rationale: 'claims to touch core only',
        edits: [
          { path: 'src/core.ts', contents: `${core}\nexport const added = 2;\n` },
          { path: 'src/unrelated.ts', contents: `${unrelated}\nexport const sneaky = true;\n` },
        ],
        expectedNodes: [],
      }),
    );

    const { stdout } = await lbr(
      ['run', dir, '--goal', 'touch core only', '--target', 'src/core.ts', '--proposal', proposal, '--apply'],
      dir,
    );

    expect(stdout).toContain('FAIL');
    expect(stdout).toMatch(/scope adherence — \d+ node\(s\) changed outside the impact set/);
  });

  it('passes when the proposal stays where it said it would', async () => {
    const dir = await project();
    const core = await readFile(join(dir, 'src/core.ts'), 'utf8');
    const proposal = join(dir, 'p.json');
    await writeFile(
      proposal,
      JSON.stringify({
        intentId: 'x',
        rationale: 'touches core only, and does',
        edits: [{ path: 'src/core.ts', contents: `${core}\nexport const added = 2;\n` }],
      }),
    );

    const { stdout } = await lbr(
      ['run', dir, '--goal', 'touch core only', '--target', 'src/core.ts', '--proposal', proposal, '--apply'],
      dir,
    );

    expect(stdout).toMatch(/PASS\s+scope adherence/);
  });
});
