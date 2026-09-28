import { access } from 'node:fs/promises';
import type {
  ExecutionOutcome,
  MirrorExecutor,
  MirrorPlan,
  NodeId,
  ProjectGraph,
} from '@lbr/runtime-core';
import { CommandRunner, NODE_PROJECT_COMMANDS, type AllowedCommand } from './commands.js';
import { createWorkspace, resolveInWorkspace, type MirrorWorkspace } from './workspace.js';

export interface LocalExecutorOptions {
  /** The project to mirror. */
  readonly sourceRoot: string;
  /** The graph the plan was computed against — used to look up node paths. */
  readonly graph: ProjectGraph;
  /** Commands the executor may run. Defaults to the Node/TypeScript set. */
  readonly commands?: Readonly<Record<string, AllowedCommand>>;
  /** Where mirrors are created. */
  readonly parentDir?: string;
  readonly envAllowlist?: readonly string[];
  /** Directory whose `node_modules` the mirror links. Defaults to the nearest ancestor's. */
  readonly nodeModulesFrom?: string;
}

/**
 * A MirrorExecutor that actually runs things.
 *
 * Until now validation was an interface with a passing stub behind it, which
 * proves the runtime's logic and nothing about whether a change works. This
 * materializes a real workspace and runs real commands against it.
 *
 * It is deliberately the weakest executor worth having: a source-tree copy and
 * host-process commands. A container or micro-VM implementation satisfies the
 * same interface and provides real isolation. What matters is that this one
 * reports what it cannot do — via `MirrorWorkspace.caveats`, surfaced in the
 * `connect` check — instead of returning a clean pass that implies guarantees
 * it never made.
 */
export class LocalMirrorExecutor implements MirrorExecutor {
  readonly #options: LocalExecutorOptions;
  readonly #commands: Readonly<Record<string, AllowedCommand>>;
  #workspace: MirrorWorkspace | undefined;
  #runner: CommandRunner | undefined;

  constructor(options: LocalExecutorOptions) {
    this.#options = options;
    this.#commands = options.commands ?? NODE_PROJECT_COMMANDS;
  }

  get workspace(): MirrorWorkspace | undefined {
    return this.#workspace;
  }

  /**
   * Build the change in isolation.
   *
   * Materializes the workspace on first use, so a plan that is never built
   * never pays for a copy.
   */
  async build(plan: MirrorPlan): Promise<ExecutionOutcome> {
    if (plan.safetyViolations.length > 0) {
      // Belt and braces: the validation runner checks this too, but an
      // executor that would materialize a workspace for an unsafe plan is one
      // bad refactor away from running it.
      return {
        ok: false,
        detail: `refusing to materialize a mirror for a plan that violates isolation: ${plan.safetyViolations.join('; ')}`,
      };
    }

    const workspace = await this.#ensureWorkspace(plan);
    const command = this.#commands['build'];
    if (command === undefined) {
      return { ok: true, detail: 'no build command configured; nothing to build' };
    }

    const result = await this.#runner!.run(command);
    return {
      ok: result.ok,
      detail: result.ok
        ? `built in ${workspace.root}`
        : truncate(result.stderr || result.stdout, 'build failed'),
      durationMs: result.durationMs,
    };
  }

  /**
   * For a library there is no process to start; the equivalent question is
   * whether the built artifact typechecks against its own declarations. A
   * service executor would start the process and wait on a health check.
   */
  async start(plan: MirrorPlan): Promise<ExecutionOutcome> {
    await this.#ensureWorkspace(plan);
    const command = this.#commands['typecheck'];
    if (command === undefined) {
      return { ok: true, detail: 'no start or typecheck command configured' };
    }
    const result = await this.#runner!.run(command);
    return {
      ok: result.ok,
      detail: result.ok ? 'typechecks clean' : truncate(result.stderr || result.stdout, 'typecheck failed'),
      durationMs: result.durationMs,
    };
  }

  /**
   * Confirm the mirror is actually what the plan asked for.
   *
   * Two things are checked, and the second is the one that matters. Every node
   * the plan materializes as `real` must exist in the workspace — a plan that
   * silently lost a file would otherwise validate a system missing the part
   * under test. And any caveat the workspace could not satisfy is reported as
   * a failure rather than a footnote, because a plan requiring a database
   * snapshot that nothing restored has not been carried out, whatever the
   * tests then say.
   */
  async connect(plan: MirrorPlan): Promise<ExecutionOutcome> {
    const workspace = await this.#ensureWorkspace(plan);
    const missing: NodeId[] = [];

    for (const planned of plan.nodes) {
      if (planned.mode !== 'real') continue;
      const path = this.#pathOf(planned.id);
      if (path === undefined) continue; // not a file-backed node
      const resolved = resolveInWorkspace(workspace.root, path);
      if (resolved === undefined) {
        missing.push(planned.id);
        continue;
      }
      if (!(await exists(resolved))) missing.push(planned.id);
    }

    const unmet = workspace.caveats.filter(
      (c) => c.includes('cannot restore') || c.includes('cannot intercept'),
    );

    if (missing.length > 0) {
      return {
        ok: false,
        detail: `${missing.length} node(s) planned as real are absent from the mirror: ${missing.join(', ')}`,
      };
    }
    if (unmet.length > 0) {
      return { ok: false, detail: `mirror cannot satisfy the plan: ${unmet.join('; ')}` };
    }

    return {
      ok: true,
      detail: `mirror satisfies the plan; caveats: ${workspace.caveats.join('; ')}`,
    };
  }

  /**
   * Run one verification node.
   *
   * The node's path is looked up in the graph and confirmed to lie inside the
   * workspace before it is used, then passed as a filter argument to an
   * already-chosen test command. Graph data selects which tests run; it never
   * contributes an executable.
   */
  async runVerification(id: NodeId, plan: MirrorPlan): Promise<ExecutionOutcome> {
    const workspace = await this.#ensureWorkspace(plan);
    const command = this.#commands['test'];
    if (command === undefined) {
      return { ok: false, detail: 'no test command configured, so nothing verifies this change' };
    }

    const path = this.#pathOf(id);
    if (path === undefined) {
      return {
        ok: false,
        detail: `verification node ${id} carries no path, so the executor cannot run it`,
      };
    }

    const resolved = resolveInWorkspace(workspace.root, path);
    if (resolved === undefined) {
      return {
        ok: false,
        detail: `verification node ${id} names a path outside the workspace: ${path}`,
      };
    }

    const result = await this.#runner!.run(command, [path]);
    return {
      ok: result.ok,
      detail: result.ok ? `${path} passed` : truncate(result.stdout || result.stderr, `${path} failed`),
      durationMs: result.durationMs,
    };
  }

  async dispose(): Promise<void> {
    await this.#workspace?.dispose();
    this.#workspace = undefined;
    this.#runner = undefined;
  }

  #pathOf(id: NodeId): string | undefined {
    const node = this.#options.graph.node(id);
    const path = node?.attributes['path'];
    return typeof path === 'string' ? path : undefined;
  }

  async #ensureWorkspace(plan: MirrorPlan): Promise<MirrorWorkspace> {
    if (this.#workspace === undefined) {
      this.#workspace = await createWorkspace(plan, {
        sourceRoot: this.#options.sourceRoot,
        parentDir: this.#options.parentDir,
        nodeModulesFrom: this.#options.nodeModulesFrom,
      });
      this.#runner = new CommandRunner({
        cwd: this.#workspace.root,
        envAllowlist: this.#options.envAllowlist,
      });
    }
    return this.#workspace;
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

function truncate(output: string, prefix: string): string {
  const cleaned = output.trim();
  if (cleaned === '') return prefix;
  const tail = cleaned.split('\n').slice(-12).join('\n');
  return `${prefix}: ${tail}`;
}
