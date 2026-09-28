import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { AppliedChange, ChangeProposal } from '@lbr/runtime-core';
import { resolveInWorkspace } from './workspace.js';

/**
 * Mirrors are created with this prefix by `createWorkspace`.
 *
 * Checked before anything is written, as a structural guard against the worst
 * mistake this function could make: being handed a source root instead of a
 * mirror and editing the user's actual working tree. A validation run that
 * modifies the thing it is validating is not a validation run.
 */
const MIRROR_PREFIX = 'lbr-mirror-';

export interface ApplyOptions {
  /**
   * Skip the mirror-name guard.
   *
   * Exists for tests that construct a workspace by hand. A caller reaching for
   * this in production has almost certainly made the mistake the guard is for.
   */
  readonly allowNonMirror?: boolean;
}

/**
 * Write a proposal's edits into a mirror workspace.
 *
 * Every path is resolved through `resolveInWorkspace`, which realpaths against
 * the workspace root — the same check the executor already uses for
 * graph-supplied paths, reused rather than reimplemented. A proposal is model
 * output and its paths were already refused lexically at parse time; this is
 * the check that also sees through a symlink planted in the mirror by the
 * repository being validated.
 *
 * A refused edit does not throw. It is recorded and reported, because the
 * useful outcome is "the proposal tried to write outside the workspace" —
 * visible in the result and in lineage — rather than a stack trace that loses
 * which edits did land.
 */
export async function applyProposal(
  workspaceRoot: string,
  proposal: ChangeProposal,
  options: ApplyOptions = {},
): Promise<AppliedChange> {
  if (options.allowNonMirror !== true && !basename(workspaceRoot).startsWith(MIRROR_PREFIX)) {
    throw new Error(
      `refusing to apply a proposal outside a mirror: ${workspaceRoot} does not look like one ` +
        `(expected a directory named ${MIRROR_PREFIX}*). A validation run must never modify the tree it is validating.`,
    );
  }

  const written: string[] = [];
  const deleted: string[] = [];
  const refused: { path: string; reason: string }[] = [];

  for (const edit of proposal.edits) {
    const resolved = await resolveInWorkspace(workspaceRoot, edit.path);
    if (resolved === undefined) {
      refused.push({
        path: edit.path,
        reason: 'resolves outside the workspace once symlinks are followed',
      });
      continue;
    }

    if ('delete' in edit) {
      await rm(resolved, { force: true, recursive: true });
      deleted.push(edit.path);
      continue;
    }

    // Parent directories are created because a proposal legitimately adds new
    // files in new directories; they are inside the workspace by construction,
    // since `resolved` already is.
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, edit.contents, 'utf8');
    written.push(edit.path);
  }

  return { proposal, written, deleted, refused };
}
