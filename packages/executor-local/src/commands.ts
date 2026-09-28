import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A command the executor is permitted to run.
 *
 * Argv is a fixed array supplied by whoever configures the executor. It is
 * never assembled from graph data.
 */
export interface AllowedCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** Milliseconds before the command is killed. */
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

/**
 * Environment variables a mirror is allowed to see.
 *
 * A mirror exists to run code the runtime is evaluating, and on an ingested
 * third-party repository that code is not trusted. Inheriting `process.env`
 * wholesale hands it every credential the host process holds — cloud tokens,
 * registry auth, the platform signing key — in exchange for nothing, since a
 * build needs almost none of it. So the environment is rebuilt from an
 * allowlist rather than filtered by a denylist: a denylist is a promise to
 * predict every secret name anyone will ever introduce.
 */
const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'NODE_ENV',
  'CI',
] as const;

export interface CommandRunnerOptions {
  /** Working directory. Every command runs here; none may be given another. */
  readonly cwd: string;
  /** Extra environment variable names permitted through to the child. */
  readonly envAllowlist?: readonly string[];
  /** Values injected into the child environment explicitly. */
  readonly env?: Readonly<Record<string, string>>;
  readonly defaultTimeoutMs?: number;
  /** Bytes of stdout/stderr retained. Prevents a runaway build exhausting memory. */
  readonly maxBufferBytes?: number;
}

/**
 * Runs allowlisted commands in one fixed working directory.
 *
 * Three properties hold by construction rather than by care:
 *
 *   1. No shell. `execFile` with an argv array means a value containing
 *      `; rm -rf /` is an argument, not a command. There is no interpolation
 *      anywhere in this file for a reviewer to have to verify.
 *   2. Fixed cwd. A caller cannot redirect a command at another directory.
 *   3. Rebuilt environment. See the allowlist above.
 *
 * The commands themselves come from a map the host supplies. Graph data can
 * select a key from that map; it can never contribute argv.
 */
export class CommandRunner {
  readonly #cwd: string;
  readonly #env: Record<string, string>;
  readonly #defaultTimeoutMs: number;
  readonly #maxBufferBytes: number;

  constructor(options: CommandRunnerOptions) {
    this.#cwd = options.cwd;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.#maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;

    const allowed = new Set<string>([
      ...DEFAULT_ENV_ALLOWLIST,
      ...(options.envAllowlist ?? []),
    ]);
    this.#env = {};
    for (const name of allowed) {
      const value = process.env[name];
      if (value !== undefined) this.#env[name] = value;
    }
    Object.assign(this.#env, options.env ?? {});
  }

  get cwd(): string {
    return this.#cwd;
  }

  /** The environment a child will receive. Exposed so tests can assert on it. */
  get environment(): Readonly<Record<string, string>> {
    return { ...this.#env };
  }

  /**
   * Run one allowlisted command.
   *
   * `extraArgs` are appended, and are the one place caller-derived values
   * reach a child process. They are arguments to an already-chosen executable,
   * never a command in their own right, and they are validated by the caller
   * before arriving here — `LocalMirrorExecutor` resolves them from workspace
   * paths it has already confirmed lie inside the workspace.
   */
  async run(command: AllowedCommand, extraArgs: readonly string[] = []): Promise<CommandResult> {
    const started = Date.now();
    const args = [...command.args, ...extraArgs];

    try {
      const { stdout, stderr } = await run(command.file, args, {
        cwd: this.#cwd,
        env: this.#env,
        timeout: command.timeoutMs ?? this.#defaultTimeoutMs,
        maxBuffer: this.#maxBufferBytes,
        // Explicit, though false is the default: this is the property the
        // whole class exists to guarantee, so it is stated rather than assumed.
        shell: false,
        windowsHide: true,
      });
      return {
        ok: true,
        code: 0,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut: false,
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      const timedOut = failure.killed === true && failure.signal === 'SIGTERM';
      return {
        ok: false,
        code: typeof failure.code === 'number' ? failure.code : null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String(failure.message ?? error),
        durationMs: Date.now() - started,
        timedOut,
      };
    }
  }
}

/**
 * The commands a Node/TypeScript project mirror needs.
 *
 * Supplied as a default because every one of them is a fixed argv a reviewer
 * can read. A project needing something else passes its own map; it does not
 * get to pass a string.
 */
export const NODE_PROJECT_COMMANDS = {
  build: { file: 'npm', args: ['run', 'build', '--if-present'], timeoutMs: 600_000 },
  typecheck: { file: 'npm', args: ['run', 'typecheck', '--if-present'], timeoutMs: 300_000 },
  test: { file: 'npx', args: ['vitest', 'run'], timeoutMs: 600_000 },
} as const satisfies Record<string, AllowedCommand>;

export type NodeCommandName = keyof typeof NODE_PROJECT_COMMANDS;
