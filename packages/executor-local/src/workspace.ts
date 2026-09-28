import { lstatSync, realpathSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename, dirname, sep } from 'node:path';
import type { MirrorPlan } from '@lbr/runtime-core';

export interface WorkspaceOptions {
  /** The project being mirrored. Never written to. */
  readonly sourceRoot: string;
  /**
   * Where mirrors are created.
   *
   * Defaults to `.lbr-mirrors` inside the nearest ancestor of the source that
   * has a `node_modules`, NOT the OS temp directory, and the reason is
   * resolution rather than convenience. Node finds a dependency by walking up
   * from the importing file through every `node_modules` on the way to the
   * filesystem root. A workspace hoists most packages to the repository root
   * and leaves a partial `node_modules` in each package, so a single symlink
   * reproduces one link of that chain and breaks the rest — the mirror then
   * fails to build with "cannot find module", which reads as a broken project
   * rather than a misplaced mirror. Creating the mirror inside the repository
   * keeps the whole chain intact.
   *
   * Pass an explicit directory for a project that resolves differently.
   */
  readonly parentDir?: string;
  /** Directories not copied into the mirror. */
  readonly exclude?: readonly string[];
  /**
   * Link `node_modules` from the source instead of copying it.
   *
   * Default true, and an honest compromise rather than a free win: copying a
   * dependency tree costs minutes per run, and linking means the mirror shares
   * installed packages with the source. A change that alters dependencies is
   * therefore NOT isolated by this executor, and `MirrorWorkspace.caveats`
   * reports that rather than leaving it for someone to discover.
   */
  readonly linkNodeModules?: boolean;
  /**
   * Where to link `node_modules` from, when the source directory has none of
   * its own.
   *
   * Workspaces hoist dependencies to the repository root, so mirroring one
   * package of a monorepo produces a tree whose `node_modules` lives several
   * directories above it. Without this the mirror builds nothing and the
   * failure looks like a broken project rather than a misplaced link. Left
   * unset, the nearest ancestor containing `node_modules` is used — the same
   * rule Node itself applies when resolving.
   */
  readonly nodeModulesFrom?: string;
}

const DEFAULT_EXCLUDE = ['node_modules', '.git', 'dist', 'coverage', '.turbo', '.lbr-mirrors'];

export interface MirrorWorkspace {
  readonly root: string;
  /** Isolation properties this workspace does NOT provide. */
  readonly caveats: readonly string[];
  dispose(): Promise<void>;
}

/**
 * Materialize a mirror workspace for a plan.
 *
 * What this genuinely provides: validation runs against a copy, so a build, a
 * test, or a generated file cannot mutate the working tree the change came
 * from. That is the property the isolation step exists for at the source level.
 *
 * What it does not provide, and says so: process, network, and filesystem
 * isolation from the rest of the machine. A container or micro-VM executor
 * implementing the same interface would; this one runs commands as the host
 * user. `caveats` carries that so a caller can decide whether the executor is
 * strong enough for the code it is about to run, rather than inferring safety
 * from the word "mirror".
 */
export async function createWorkspace(
  plan: MirrorPlan,
  options: WorkspaceOptions,
): Promise<MirrorWorkspace> {
  const sourceRoot = resolve(options.sourceRoot);
  const parent = options.parentDir ?? (await defaultParentDir(sourceRoot));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, `lbr-mirror-${sanitize(plan.intentId)}-`));

  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDE);

  // Mirrors live inside the repository, so mirroring a directory that contains
  // the mirror parent would copy every previous mirror into the new one, and
  // the one after that would copy those. Excluding the parent by name covers
  // the default; deriving it from the actual parent covers a caller who
  // configured somewhere else.
  const parentInsideSource = relative(sourceRoot, resolve(parent));
  if (parentInsideSource !== '' && !parentInsideSource.startsWith('..')) {
    exclude.add(parentInsideSource.split(sep)[0]!);
  }

  // Copied entry by entry rather than as one tree.
  //
  // Mirrors live inside the repository so module resolution survives, which
  // means the destination can be a subdirectory of the source — and `cp`
  // refuses that outright with EINVAL, whatever the filter says. Mirroring a
  // repository root is an ordinary thing to want, so the top level is walked
  // and each surviving entry copied individually; the mirror parent is simply
  // one of the entries that gets skipped.
  const realSource = (await realpathOrUndefined(sourceRoot)) ?? sourceRoot;
  const escapingLinks: string[] = [];

  for (const entry of await readdir(sourceRoot)) {
    if (exclude.has(entry)) continue;
    await cp(join(sourceRoot, entry), join(root, entry), {
      recursive: true,
      // Dereference nothing: copying through a symlink that points outside the
      // source tree would pull the target's contents into the mirror.
      dereference: false,
      filter: (source) => {
        const rel = relative(sourceRoot, source);
        if (rel.split(sep).some((segment) => exclude.has(segment))) return false;
        // Not dereferencing keeps a link's *contents* out, but reproducing the
        // link itself puts a door to the host inside the mirror — and anything
        // that later resolves a path through it walks straight out again. A
        // link that leaves the source tree is dropped, and said so rather than
        // dropped quietly, since a missing file is otherwise a puzzle.
        if (escapesSource(realSource, source)) {
          escapingLinks.push(rel);
          return false;
        }
        return true;
      },
    });
  }

  const caveats = [
    'commands run as the host user — no process, network, or filesystem isolation from the machine',
  ];

  if (escapingLinks.length > 0) {
    caveats.push(
      `${escapingLinks.length} symlink(s) leaving the source tree were not copied: ${escapingLinks.slice(0, 5).join(', ')}`,
    );
  }

  if (options.linkNodeModules ?? true) {
    const sourceModules =
      options.nodeModulesFrom !== undefined
        ? join(resolve(options.nodeModulesFrom), 'node_modules')
        : await findNearestNodeModules(sourceRoot);
    if (sourceModules !== undefined && (await exists(sourceModules))) {
      await symlink(sourceModules, join(root, 'node_modules'), 'dir');
      caveats.push(
        `node_modules is linked from ${sourceModules}, so a change to dependencies is not isolated by this workspace`,
      );
    } else {
      caveats.push('no node_modules was found to link; commands needing dependencies will fail');
    }
  }

  if (plan.snapshotsRequired.length > 0) {
    // Stated rather than silently skipped. A plan that asks for a database
    // snapshot and gets a source-tree copy has not been honoured, and a
    // validation pass that reports success on that basis is lying.
    caveats.push(
      `plan requires data snapshots this executor cannot restore: ${plan.snapshotsRequired.join(', ')}`,
    );
  }

  if (plan.externalStubs.length > 0) {
    caveats.push(
      `plan requires stubbing third-party services this executor cannot intercept: ${plan.externalStubs.join(', ')}`,
    );
  }

  return {
    root,
    caveats,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
      // Leave no trace in the user's repository. `rmdir` fails on a non-empty
      // directory, which is exactly the wanted behaviour: a concurrent mirror
      // still in there means this is not ours to remove.
      await rmdir(parent).catch(() => undefined);
    },
  };
}

/**
 * Resolve a path that came from graph data against the workspace, refusing
 * anything that escapes it.
 *
 * Node attributes are populated by adapters reading real repositories, so a
 * `path` attribute is untrusted input. Without this check a crafted value like
 * `../../../../etc/shadow` turns a file-existence probe into a filesystem
 * oracle, and any later read into an exfiltration primitive.
 *
 * Containment is decided on the real filesystem, not on the string. A purely
 * lexical check — `resolve` then `relative` — cannot see a symlink, and the
 * mirror copies symlinks verbatim rather than dereferencing them, so an
 * ingested repository containing `escape -> /home/someone` makes
 * `escape/internal/creds.ts` lexically inside the workspace and physically
 * outside it. Every subsequent `access`, read, or exec through that path
 * follows the link. The string test is kept only as a cheap first pass.
 */
export async function resolveInWorkspace(
  workspaceRoot: string,
  candidate: string,
): Promise<string | undefined> {
  const lexical = resolveLexically(workspaceRoot, candidate);
  if (lexical === undefined) return undefined;

  const realRoot = await realpathOrUndefined(workspaceRoot);
  if (realRoot === undefined) return undefined;

  const real = await realpathOfNearestExisting(lexical);
  if (real === undefined) return undefined;

  return contains(realRoot, real) ? lexical : undefined;
}

/** The string-only containment test. Exported for the cases with no filesystem yet. */
export function resolveLexically(workspaceRoot: string, candidate: string): string | undefined {
  if (isAbsolute(candidate)) return undefined;
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, candidate);
  return contains(root, resolved) ? resolved : undefined;
}

/**
 * True when `target` is strictly beneath `root`.
 *
 * The separator matters: testing `rel.startsWith('..')` alone also rejects a
 * legitimate `..foo/bar.ts`, since a path may perfectly well begin with two
 * dots without climbing anywhere.
 */
function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Real path of a candidate that may not exist yet.
 *
 * `realpath` fails outright on a missing file, but containment still has to be
 * decided for one — a test file the plan expects and the mirror lacks is
 * exactly the case `connect` exists to catch. So the deepest existing ancestor
 * is resolved and the remaining segments appended: the symlinks are all in the
 * part that exists.
 */
async function realpathOfNearestExisting(target: string): Promise<string | undefined> {
  const trailing: string[] = [];
  let current = target;
  for (;;) {
    const real = await realpathOrUndefined(current);
    if (real !== undefined) {
      return trailing.length === 0 ? real : join(real, ...trailing.reverse());
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    trailing.push(basename(current));
    current = parent;
  }
}

/**
 * Whether a source entry is a symlink whose target leaves the source tree.
 *
 * Synchronous because `cp`'s filter is; the cost is one `lstat` per entry.
 */
function escapesSource(realSource: string, source: string): boolean {
  try {
    if (!lstatSync(source).isSymbolicLink()) return false;
    return !contains(realSource, realpathSync(source));
  } catch {
    // A broken link resolves nowhere, so it leads nowhere worth copying.
    return true;
  }
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/**
 * Place the mirror where dependency resolution still works: beside the
 * `node_modules` the source resolves against, so walking up from the mirror
 * reaches the same packages the original would.
 */
async function defaultParentDir(sourceRoot: string): Promise<string> {
  const modules = await findNearestNodeModules(sourceRoot);
  if (modules === undefined) return tmpdir();
  return join(dirname(modules), '.lbr-mirrors');
}

/**
 * Walk up from a directory to the `node_modules` a dependency would actually
 * resolve from.
 */
async function findNearestNodeModules(from: string): Promise<string | undefined> {
  // A workspace package often has a `node_modules` holding only `.bin`, while
  // the packages themselves are hoisted to the repository root. "Nearest
  // existing" therefore finds a directory that is real and useless, so the
  // outermost one is preferred — that is where a hoisted tree actually lives.
  let current = resolve(from);
  let outermost: string | undefined;
  for (;;) {
    const candidate = join(current, 'node_modules');
    if (await exists(candidate)) outermost = candidate;
    const parent = dirname(current);
    if (parent === current) return outermost;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'intent';
}
