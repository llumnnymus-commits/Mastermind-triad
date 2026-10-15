import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRunner } from '../src/commands.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lbr-cmd-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the command runner is not a shell', () => {
  it('treats a shell metacharacter as a literal argument', async () => {
    // The attack this class exists to make impossible. A graph node populated
    // by an adapter reading someone else's repository is untrusted input; if
    // any of it reached a shell, ingesting a repository would be equivalent to
    // running it.
    const runner = new CommandRunner({ cwd: dir });
    const nasty = '; touch pwned';
    const result = await runner.run(
      { file: 'node', args: ['-e', 'console.log(process.argv[1])'] },
      [nasty],
    );

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe(nasty); // arrived whole, uninterpreted
    expect(await readdir(dir)).not.toContain('pwned');
  });

  it('does not expand globs or variables', async () => {
    await writeFile(join(dir, 'real-file.txt'), 'x');
    const runner = new CommandRunner({ cwd: dir });
    const result = await runner.run(
      { file: 'node', args: ['-e', 'console.log(process.argv[1])'] },
      ['*.txt'],
    );
    expect(result.stdout.trim()).toBe('*.txt');
  });

  it('reports a non-zero exit as a failure with its output', async () => {
    const runner = new CommandRunner({ cwd: dir });
    const result = await runner.run({
      file: 'node',
      args: ['-e', 'console.error("boom"); process.exit(3)'],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('kills a command that overruns its timeout', async () => {
    const runner = new CommandRunner({ cwd: dir });
    const result = await runner.run({
      file: 'node',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe('the child environment is rebuilt, not inherited', () => {
  it('withholds host secrets from the mirror', async () => {
    // A mirror runs code the runtime is evaluating. Inheriting process.env
    // hands that code every credential the host holds, in exchange for nothing
    // a build actually needs.
    process.env['LBR_TEST_FAKE_SECRET'] = 'super-secret-value';
    try {
      const runner = new CommandRunner({ cwd: dir });
      expect(runner.environment['LBR_TEST_FAKE_SECRET']).toBeUndefined();

      const result = await runner.run({
        file: 'node',
        args: ['-e', 'console.log(process.env.LBR_TEST_FAKE_SECRET ?? "absent")'],
      });
      expect(result.stdout.trim()).toBe('absent');
    } finally {
      delete process.env['LBR_TEST_FAKE_SECRET'];
    }
  });

  it('passes through what a build genuinely needs', async () => {
    const runner = new CommandRunner({ cwd: dir });
    expect(runner.environment['PATH']).toBeDefined();
  });

  it('lets a host widen the allowlist deliberately', async () => {
    process.env['LBR_TEST_OPTED_IN'] = 'yes';
    try {
      const runner = new CommandRunner({ cwd: dir, envAllowlist: ['LBR_TEST_OPTED_IN'] });
      expect(runner.environment['LBR_TEST_OPTED_IN']).toBe('yes');
    } finally {
      delete process.env['LBR_TEST_OPTED_IN'];
    }
  });
});

describe('the working directory is fixed', () => {
  it('runs every command in the configured directory', async () => {
    const runner = new CommandRunner({ cwd: dir });
    const result = await runner.run({ file: 'node', args: ['-e', 'console.log(process.cwd())'] });
    // macOS reports /private/var for /var, so compare on the suffix.
    expect(result.stdout.trim().endsWith(dir.replace(/^\/private/, ''))).toBe(true);
  });
});
