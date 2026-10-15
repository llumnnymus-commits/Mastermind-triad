import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRunner } from '../src/commands.js';
import { NO_SANDBOX, namespaceSandbox, detectSandbox } from '../src/sandbox.js';

/**
 * These assert the isolation is real, by observing it from inside a confined
 * process — not that the right flags were assembled. A sandbox verified by
 * checking its own argv is a sandbox nobody has tested.
 */

let dir: string;
let supported = false;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lbr-sandbox-'));
  supported = (await detectSandbox()).name !== NO_SANDBOX.name;
});

const netProbe = `
const net = require('node:net');
const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 2000 });
s.on('connect', () => { console.log('REACHABLE'); process.exit(0); });
s.on('error', (e) => { console.log('BLOCKED:' + e.code); process.exit(0); });
s.on('timeout', () => { console.log('TIMEOUT'); process.exit(0); });
`;

describe('detection is a probe, not an assumption', () => {
  it('reports what this machine actually supports', async () => {
    // Namespace creation is refused on hardened kernels and in some container
    // runtimes, and the failure is a non-zero exit rather than a missing
    // binary — so it has to be tried.
    const profile = await detectSandbox();
    expect([NO_SANDBOX.name, 'namespaces']).toContain(profile.name);
  });

  it('states what it lacks whichever profile it picked', async () => {
    const profile = await detectSandbox();
    expect(profile.lacks.length).toBeGreaterThan(0);
  });
});

describe('the sandbox actually confines', () => {
  it('blocks network egress from a confined command', async ({ skip }) => {
    if (!supported) return skip();
    // A build script is the most convenient exfiltration point a repository
    // has: it runs automatically and nobody reads its output.
    const probe = join(dir, 'net.js');
    await writeFile(probe, netProbe);

    const confined = new CommandRunner({ cwd: dir, sandbox: namespaceSandbox() });
    const result = await confined.run({ file: 'node', args: [probe] });

    expect(result.stdout).not.toContain('REACHABLE');
    expect(result.stdout.trim()).toMatch(/BLOCKED|TIMEOUT/);
  });

  it('leaves the network reachable without a sandbox, so the test above means something', async () => {
    const probe = join(dir, 'net2.js');
    await writeFile(probe, netProbe);

    const plain = new CommandRunner({ cwd: dir });
    const result = await plain.run({ file: 'node', args: [probe] });

    expect(result.stdout.trim()).toBe('REACHABLE');
  });

  it('permits egress when a caller deliberately asks for it', async ({ skip }) => {
    if (!supported) return skip();
    const probe = join(dir, 'net3.js');
    await writeFile(probe, netProbe);

    const permitted = new CommandRunner({
      cwd: dir,
      sandbox: namespaceSandbox({ allowNetwork: true }),
    });
    const result = await permitted.run({ file: 'node', args: [probe] });

    expect(result.stdout.trim()).toBe('REACHABLE');
  });

  it('hides host processes from a confined command', async ({ skip }) => {
    if (!supported) return skip();
    const count = `console.log(require('node:fs').readdirSync('/proc').filter(n => /^\\d+$/.test(n)).length)`;

    const plain = await new CommandRunner({ cwd: dir }).run({ file: 'node', args: ['-e', count] });
    const confined = await new CommandRunner({ cwd: dir, sandbox: namespaceSandbox() }).run({
      file: 'node',
      args: ['-e', count],
    });

    expect(Number(confined.stdout.trim())).toBeLessThan(Number(plain.stdout.trim()));
    expect(Number(confined.stdout.trim())).toBeLessThan(10);
  });
});

describe('confinement does not weaken the guarantees already in place', () => {
  it('still refuses an argument that would be read as an option', async ({ skip }) => {
    if (!supported) return skip();
    const runner = new CommandRunner({ cwd: dir, sandbox: namespaceSandbox() });
    const result = await runner.run({ file: 'node', args: ['-e', 'console.log(1)'] }, [
      '--config=/etc/passwd',
    ]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('read as options rather than operands');
  });

  it('still withholds host secrets', async ({ skip }) => {
    if (!supported) return skip();
    process.env['LBR_SANDBOX_SECRET'] = 'do-not-leak';
    try {
      const runner = new CommandRunner({ cwd: dir, sandbox: namespaceSandbox() });
      const result = await runner.run({
        file: 'node',
        args: ['-e', 'console.log(process.env.LBR_SANDBOX_SECRET ?? "absent")'],
      });
      expect(result.stdout.trim()).toBe('absent');
    } finally {
      delete process.env['LBR_SANDBOX_SECRET'];
    }
  });

  it('still separates unshare flags from the command, so a dash-leading command survives', () => {
    // Without the `--` separator, unshare would consume the wrapped command's
    // own flags as its own.
    const wrapped = namespaceSandbox().wrap({ file: 'node', args: ['-e', 'x'] });
    expect(wrapped.file).toBe('unshare');
    const separator = wrapped.args.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    expect(wrapped.args.slice(separator + 1)).toEqual(['node', '-e', 'x']);
  });

  it('preserves the command timeout through the wrapper', () => {
    const wrapped = namespaceSandbox().wrap({ file: 'node', args: [], timeoutMs: 1234 });
    expect(wrapped.timeoutMs).toBe(1234);
  });
});
