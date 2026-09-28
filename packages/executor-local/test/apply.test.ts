import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChangeProposal } from '@lbr/runtime-core';
import { applyProposal } from '../src/apply.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A directory named the way createWorkspace names mirrors. */
async function mirror(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'lbr-apply-'));
  dirs.push(parent);
  const root = join(parent, 'lbr-mirror-test-abc');
  await mkdir(root, { recursive: true });
  return root;
}

function proposal(edits: unknown[]): ReturnType<typeof parseChangeProposal> {
  return parseChangeProposal({
    intentId: 'i_apply',
    rationale: 'test',
    edits,
  });
}

describe('applying a proposal', () => {
  it('creates a file, including its directories', async () => {
    const root = await mirror();
    const result = await applyProposal(
      root,
      proposal([{ path: 'src/deep/new.ts', contents: 'export const x = 1;' }]),
    );

    expect(result.written).toEqual(['src/deep/new.ts']);
    expect(await readFile(join(root, 'src/deep/new.ts'), 'utf8')).toBe('export const x = 1;');
  });

  it('overwrites an existing file', async () => {
    const root = await mirror();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'old');

    await applyProposal(root, proposal([{ path: 'src/a.ts', contents: 'new' }]));

    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('new');
  });

  it('deletes a file', async () => {
    const root = await mirror();
    await writeFile(join(root, 'gone.ts'), 'x');

    const result = await applyProposal(root, proposal([{ path: 'gone.ts', delete: true }]));

    expect(result.deleted).toEqual(['gone.ts']);
    await expect(access(join(root, 'gone.ts'))).rejects.toThrow();
  });
});

describe('a proposal cannot reach outside the mirror', () => {
  it('refuses a path that escapes through a symlink, and says which', async () => {
    // A proposal is model output, and the repository being validated can plant
    // a symlink in its own tree. The lexical check at parse time cannot see
    // one; this is the check that can.
    const root = await mirror();
    const outside = await mkdtemp(join(tmpdir(), 'lbr-outside-'));
    dirs.push(outside);
    await writeFile(join(outside, 'host.txt'), 'original');
    await symlink(outside, join(root, 'escape'), 'dir');

    const result = await applyProposal(
      root,
      proposal([{ path: 'escape/host.txt', contents: 'overwritten' }]),
    );

    expect(result.written).toEqual([]);
    expect(result.refused[0]!.path).toBe('escape/host.txt');
    expect(result.refused[0]!.reason).toContain('outside the workspace');
    expect(await readFile(join(outside, 'host.txt'), 'utf8')).toBe('original');
  });

  it('rejects an absolute path before it is ever applied', () => {
    expect(() => proposal([{ path: '/etc/passwd', contents: 'x' }])).toThrow(
      /relative to the workspace/,
    );
  });

  it('rejects a path that climbs out', () => {
    expect(() => proposal([{ path: '../../escape.ts', contents: 'x' }])).toThrow(/climb out/);
  });

  it('rejects a climb buried mid-path', () => {
    expect(() => proposal([{ path: 'src/../../escape.ts', contents: 'x' }])).toThrow(/climb out/);
  });

  it('allows a filename that merely begins with dots', () => {
    // `..foo` climbs nowhere. Refusing it would be the same off-by-one the
    // workspace containment check already had once.
    expect(() => proposal([{ path: 'src/..foo.ts', contents: 'x' }])).not.toThrow();
  });

  it('applies the edits it can and refuses only the bad one', async () => {
    const root = await mirror();
    const outside = await mkdtemp(join(tmpdir(), 'lbr-partial-'));
    dirs.push(outside);
    await symlink(outside, join(root, 'out'), 'dir');

    const result = await applyProposal(
      root,
      proposal([
        { path: 'good.ts', contents: 'fine' },
        { path: 'out/bad.ts', contents: 'nope' },
      ]),
    );

    expect(result.written).toEqual(['good.ts']);
    expect(result.refused).toHaveLength(1);
  });
});

describe('a proposal cannot be applied to a working tree', () => {
  it('refuses a directory that is not a mirror', async () => {
    // The worst mistake this function could make is being handed a source root
    // and editing the tree it is supposed to be validating.
    const notAMirror = await mkdtemp(join(tmpdir(), 'lbr-realrepo-'));
    dirs.push(notAMirror);
    await writeFile(join(notAMirror, 'important.ts'), 'do not touch');

    await expect(
      applyProposal(notAMirror, proposal([{ path: 'important.ts', contents: 'clobbered' }])),
    ).rejects.toThrow(/refusing to apply a proposal outside a mirror/);

    expect(await readFile(join(notAMirror, 'important.ts'), 'utf8')).toBe('do not touch');
  });

  it('can be overridden deliberately, for tests that build a workspace by hand', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'lbr-plain-'));
    dirs.push(plain);
    const result = await applyProposal(plain, proposal([{ path: 'a.ts', contents: 'x' }]), {
      allowNonMirror: true,
    });
    expect(result.written).toEqual(['a.ts']);
  });
});
