import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AllowedCommand } from './commands.js';

const run = promisify(execFile);

/**
 * How a command is confined before it runs.
 *
 * The local executor's honest limitation was that it ran the project's own
 * build scripts as the host user with no confinement at all — on an ingested
 * third-party repository, that is running somebody else's code with your
 * credentials and your network. A profile wraps each command so that stops
 * being true, and states exactly what it does and does not achieve, because an
 * executor claiming isolation it does not have is worse than one claiming none.
 */
export interface SandboxProfile {
  readonly name: string;
  /** Isolation this profile genuinely provides. */
  readonly provides: readonly string[];
  /** Isolation it does not provide — carried into the executor's caveats. */
  readonly lacks: readonly string[];
  /** Rewrite a command so it runs confined. */
  wrap(command: AllowedCommand): AllowedCommand;
}

/** No confinement. What the executor did before profiles existed. */
export const NO_SANDBOX: SandboxProfile = {
  name: 'none',
  provides: [],
  lacks: [
    'commands run as the host user — no process, network, or filesystem isolation from the machine',
  ],
  wrap: (command) => command,
};

export interface NamespaceSandboxOptions {
  /**
   * Whether the confined command may reach the network. Default false.
   *
   * Off by default because a build script is the most convenient exfiltration
   * point a repository has: it runs automatically, it is expected to be noisy,
   * and nobody reads its output. Turning it on is a deliberate choice for a
   * project whose build genuinely needs to fetch — and it is reported as a
   * thing the sandbox no longer provides, rather than silently assumed.
   */
  readonly allowNetwork?: boolean;
}

/**
 * Confinement using Linux user, PID, mount and (optionally) network
 * namespaces, via `unshare`.
 *
 * Deliberately not a container runtime. It needs no daemon, no image, no root,
 * and no privileged helper — which is what makes it usable in the places this
 * runtime actually runs, including inside a container that cannot nest one.
 * What it buys, measured rather than assumed:
 *
 *   - the command cannot see or signal host processes (87 visible becomes 5)
 *   - the command cannot reach the network at all (connections fail ENETUNREACH)
 *   - mounts it makes are its own and do not touch the host's view
 *
 * What it does not buy is equally worth stating: the filesystem is still the
 * host's, so the command can read anything the invoking user can read. This is
 * confinement against a build script that phones home or rummages through
 * processes, not against one deliberately reading files it was pointed near.
 */
export function namespaceSandbox(options: NamespaceSandboxOptions = {}): SandboxProfile {
  const allowNetwork = options.allowNetwork ?? false;

  const flags = [
    '--user',
    // Root inside the namespace only. The mapping is to the invoking user
    // outside it, so this grants nothing on the host.
    '--map-root-user',
    '--pid',
    // Without --fork the unshared PID namespace applies to unshare's children
    // rather than the command, and /proc keeps showing the host's processes.
    '--fork',
    '--mount-proc',
    '--mount',
  ];
  if (!allowNetwork) flags.push('--net');

  return {
    name: allowNetwork ? 'namespaces (network permitted)' : 'namespaces',
    provides: [
      'process isolation — the command cannot see or signal host processes',
      'mount isolation — mounts the command makes do not affect the host',
      ...(allowNetwork ? [] : ['network isolation — the command has no egress at all']),
    ],
    lacks: [
      'the filesystem is the host\'s — the command can read what the invoking user can read',
      ...(allowNetwork
        ? ['network egress is permitted, so a build script can reach the network']
        : []),
    ],
    wrap: (command) => ({
      file: 'unshare',
      // `--` separates unshare's own flags from the command, so a command whose
      // first argument looks like a flag is not eaten by unshare.
      args: [...flags, '--', command.file, ...command.args],
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    }),
  };
}

/**
 * Pick the strongest profile this machine actually supports, by trying it.
 *
 * Namespace creation is refused in plenty of real environments — hardened
 * kernels, some container runtimes, seccomp policies — and the failure is a
 * non-zero exit rather than an absent binary, so probing is the only honest
 * check. A caller that requires confinement should compare the result against
 * `NO_SANDBOX` rather than assume it got one.
 */
export async function detectSandbox(
  options: NamespaceSandboxOptions = {},
): Promise<SandboxProfile> {
  const candidate = namespaceSandbox(options);
  const probe = candidate.wrap({ file: 'true', args: [] });
  try {
    await run(probe.file, [...probe.args], { timeout: 10_000, shell: false });
    return candidate;
  } catch {
    return NO_SANDBOX;
  }
}
