import { describe, it, expect } from 'vitest';
import { access, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MirrorPlan } from '@lbr/runtime-core';
import { createWorkspace, resolveInWorkspace, resolveLexically } from '../src/workspace.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture-project');

function plan(overrides: Partial<MirrorPlan> = {}): MirrorPlan {
  return {
    intentId: 'intent_ws',
    nodes: [],
    snapshotsRequired: [],
    externalStubs: [],
    constraints: [],
    verificationPlan: [],
    safetyViolations: [],
    ...overrides,
  };
}

describe('workspace path resolution', () => {
  const root = '/tmp/some-workspace';

  it('refuses a path that climbs out of the workspace', () => {
    // Node attributes come from adapters reading real repositories, so a
    // `path` is untrusted. Without this, a file-existence probe becomes a
    // filesystem oracle.
    expect(resolveLexically(root, '../../../../etc/passwd')).toBeUndefined();
    expect(resolveLexically(root, 'src/../../escape.ts')).toBeUndefined();
  });

  it('refuses an absolute path outright', () => {
    expect(resolveLexically(root, '/etc/passwd')).toBeUndefined();
  });

  it('refuses the workspace root itself', () => {
    expect(resolveLexically(root, '.')).toBeUndefined();
  });

  it('accepts an ordinary path inside the workspace', () => {
    expect(resolveLexically(root, 'src/alpha.ts')).toBe(join(root, 'src/alpha.ts'));
  });

  it('accepts traversal that stays inside after normalizing', () => {
    expect(resolveLexically(root, 'src/nested/../alpha.ts')).toBe(join(root, 'src/alpha.ts'));
  });

  it('does not mistake a leading double dot in a name for traversal', () => {
    // `..foo` climbs nowhere; testing `startsWith('..')` without the separator
    // rejects a legitimate filename.
    expect(resolveLexically(root, '..foo/bar.ts')).toBe(join(root, '..foo/bar.ts'));
  });
});

describe('materializing a workspace', () => {
  it('copies the source tree so validation never touches the original', async () => {
    const workspace = await createWorkspace(plan(), { sourceRoot: fixture });
    try {
      expect(workspace.root).not.toBe(fixture);
      await expect(access(join(workspace.root, 'src/alpha.ts'))).resolves.toBeUndefined();

      // Mutating the mirror must not reach the source.
      await writeFile(join(workspace.root, 'src/alpha.ts'), 'export const alpha = 999;');
      const original = await readFile(join(fixture, 'src/alpha.ts'), 'utf8');
      expect(original).toContain('alpha = 1');
    } finally {
      await workspace.dispose();
    }
  });

  it('excludes build output and dependency directories', async () => {
    const source = await mkdtemp(join(tmpdir(), 'lbr-src-'));
    try {
      await writeFile(join(source, 'keep.ts'), 'export const keep = 1;');
      const nested = join(source, 'dist');
      await writeFile(join(source, 'package.json'), '{}');
      await import('node:fs/promises').then((fs) => fs.mkdir(nested, { recursive: true }));
      await writeFile(join(nested, 'stale.js'), 'stale');

      const workspace = await createWorkspace(plan(), { sourceRoot: source });
      try {
        await expect(access(join(workspace.root, 'keep.ts'))).resolves.toBeUndefined();
        await expect(access(join(workspace.root, 'dist/stale.js'))).rejects.toThrow();
      } finally {
        await workspace.dispose();
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('states the isolation it does not provide', async () => {
    const workspace = await createWorkspace(plan(), { sourceRoot: fixture });
    try {
      expect(workspace.caveats.some((c) => c.includes('no process, network'))).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it('reports a snapshot requirement it cannot satisfy rather than ignoring it', async () => {
    // A plan asking for a database snapshot that nothing restored has not been
    // carried out, whatever the tests then say.
    const workspace = await createWorkspace(
      plan({ snapshotsRequired: ['service:database:accounts'] }),
      { sourceRoot: fixture },
    );
    try {
      expect(workspace.caveats.some((c) => c.includes('cannot restore'))).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it('reports third-party stubs it cannot intercept', async () => {
    const workspace = await createWorkspace(
      plan({ externalStubs: ['service:external_service:stripe'] }),
      { sourceRoot: fixture },
    );
    try {
      expect(workspace.caveats.some((c) => c.includes('cannot intercept'))).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });

  it('removes the workspace on dispose', async () => {
    const workspace = await createWorkspace(plan(), { sourceRoot: fixture });
    await workspace.dispose();
    await expect(access(workspace.root)).rejects.toThrow();
  });
});

describe('mirrors do not nest', () => {
  it('excludes the mirror parent when mirroring a tree that contains it', async () => {
    // Without this, mirroring the repository root copies every previous mirror
    // into the new one, and the next run copies those.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const source = await mkdtemp(join(tmpdir(), 'lbr-nest-'));
    try {
      await writeFile(join(source, 'keep.ts'), 'export const keep = 1;');
      await mkdir(join(source, '.lbr-mirrors', 'previous-run'), { recursive: true });
      await writeFile(join(source, '.lbr-mirrors', 'previous-run', 'stale.ts'), 'stale');

      const workspace = await createWorkspace(plan(), {
        sourceRoot: source,
        parentDir: join(source, '.lbr-mirrors'),
      });
      try {
        await expect(access(join(workspace.root, 'keep.ts'))).resolves.toBeUndefined();
        await expect(access(join(workspace.root, '.lbr-mirrors'))).rejects.toThrow();
      } finally {
        await workspace.dispose();
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});

describe('disposal leaves no trace', () => {
  it('removes the mirror parent it created when nothing else is using it', async () => {
    // Mirrors are created inside the user's repository. A command that feels
    // read-only should not leave a directory behind in it.
    const source = await mkdtemp(join(tmpdir(), 'lbr-trace-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(source, 'a.ts'), 'export const a = 1;');
      const parentDir = join(source, '.lbr-mirrors');

      const workspace = await createWorkspace(plan(), { sourceRoot: source, parentDir });
      await workspace.dispose();

      await expect(access(parentDir)).rejects.toThrow();
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('keeps the parent when a concurrent mirror still lives there', async () => {
    const source = await mkdtemp(join(tmpdir(), 'lbr-concurrent-'));
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(source, 'a.ts'), 'export const a = 1;');
      const parentDir = join(source, '.lbr-mirrors');

      const first = await createWorkspace(plan(), { sourceRoot: source, parentDir });
      const second = await createWorkspace(plan(), { sourceRoot: source, parentDir });

      await first.dispose();
      // The second mirror is still in there, so the parent must survive.
      await expect(access(second.root)).resolves.toBeUndefined();

      await second.dispose();
      await expect(access(parentDir)).rejects.toThrow();
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});
