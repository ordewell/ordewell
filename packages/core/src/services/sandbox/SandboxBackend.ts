import { execFile } from 'child_process';
import * as path from 'path';

/**
 * The one seam an OS sandbox sits behind (ADR-0011 B6). A backend turns "run
 * this POSIX shell" into "run this launcher, which runs the shell under a
 * policy": the launcher and its policy become the `file` and the leading
 * `args`, and the caller appends the command string last, exactly as it would
 * to the bare shell. The string the classifier read is the string that runs.
 *
 * A sandbox shares nothing with another: no daemon, no image, no state beyond
 * what its profile names. A container, microVM or hosted backend for an
 * execution lease (#97) is another implementation of this interface, and its
 * callers do not change.
 */

/**
 * A `.git` entry the checkout brought, which a sealed run may not change
 * (ADR-0046). Whether it is a directory decides how a backend refuses a write
 * into it: its whole subtree, or just the file.
 */
export interface SandboxGitEntry {
  path: string;
  directory: boolean;
}

/**
 * What one command may touch. Every path is absolute, and canonical
 * (symlinks resolved) wherever the backend matches the path the kernel
 * resolves, as Seatbelt does.
 */
export interface SandboxProfile {
  /** Directories the command may write, recursively. Nothing else can be written. */
  write: readonly string[];
  /**
   * Of `write`, those the command may not put a symbolic link in, nor move
   * one into: what is read there outside the sandbox, as the user, would
   * follow it (ADR-0046). A backend that cannot refuse a link by its type
   * refuses the profile.
   */
  linkless?: readonly string[];
  /**
   * Of `write`, the worktree roots whose own `.git` a command may neither
   * write, replace, rename nor remove (ADR-0046). A worktree's `.git` is a
   * file pointing into its repository; a command that rewrote it would make
   * git load a repository of the command's own when it runs there outside the
   * sandbox, as the user. The root itself is held still too: a command that
   * renamed it could plant a `.git` outside the profile and move it back.
   */
  gitWorktrees?: readonly string[];
  /**
   * Of `write`, every `.git` entry the checkout brought — a submodule's file, a
   * vendored repository — which a command may not change either: the literal
   * path for a file, everything under it for a directory (ADR-0046).
   */
  gitEntries?: readonly SandboxGitEntry[];
  /**
   * Of `write`, directories in which a command may not create a `.git`, at
   * their root or beneath it, for the same reason (ADR-0046). A backend that
   * cannot refuse a name being created refuses the profile.
   */
  gitless?: readonly string[];
  /**
   * What the command may read besides `write`. `'host'` is the whole
   * filesystem: the planner's reads are confined by ADR-0008's path check,
   * not here (ADR-0011 B2). A list confines reads to those paths, for a
   * profile that must not see the user's files (ADR-0036 S1). Bubblewrap
   * mounts a listed link where it is named, so `/bin` still starts programs
   * on a system where it links to `/usr/bin`.
   */
  read: 'host' | readonly string[];
  /**
   * Listed directories mounted with a throwaway overlay: a write there
   * succeeds and is gone when the command ends, so a tool that writes a cache
   * beside the code still runs (ADR-0036 S1). A backend without one refuses
   * the profile, a host too old for one fails its probe, and either way the
   * caller asks again with the directory read-only.
   */
  throwaway?: readonly string[];
  /** Directories the command cannot see into although `read` covers them: where local services listen that would write on its behalf. */
  masked?: readonly string[];
  network: boolean;
  /** The host's `/tmp` out of the command's sight: an empty one of its own where the backend can mount one, none at all where it cannot. */
  privateTmp?: boolean;
  /**
   * Whether a networked command reaches the keychain, where `gh` and git's
   * credential helpers keep the user's tokens (B3). Defaults to true for an
   * approved command; a native shell must not have it (ADR-0036 N2.2).
   */
  keychain?: boolean;
  /**
   * Whether a networked command reaches what listens on this machine itself:
   * loopback addresses and Unix sockets. Defaults to true. A native shell must
   * not: the harness's own server and Ordewell's daemon listen there and act
   * outside the sandbox for whoever holds their password, which a macOS
   * command can read from their environments (ADR-0036 N2).
   */
  localNetwork?: boolean;
  /** Set over the environment the command inherits. */
  env: Readonly<Record<string, string>>;
  /** The variables the command keeps from the host's environment; absent keeps them all. Its credentials live there too. */
  inheritEnv?: readonly string[];
  limits?: SandboxLimits;
}

/**
 * Held by the kernel's resource limits, set before the launcher starts, by a
 * watcher beside the launcher, outside the sandbox, and by the caller's clock
 * (ADR-0036 S1).
 */
export interface SandboxLimits {
  /** Processes the command may start beyond those its user already runs, which the kernel's limit counts too. */
  processes: number;
  /**
   * Bytes of real memory the command may hold: resident memory summed across
   * its processes, which the watcher reads about once a second and ends the
   * command for passing ({@link MEMORY_LIMIT_SIGNAL}).
   */
  memoryBytes: number;
  /**
   * Bytes of address space any one of its processes may map: a backstop
   * against a runaway allocator, not a measure of memory, since V8 reserves
   * far more than it touches. On macOS, where every program maps hundreds of
   * gigabytes as it starts, it is counted on top of that.
   */
  addressSpaceBytes: number;
  /** Milliseconds before the caller kills the command, and with it every process it started. */
  wallTimeMs: number;
}

/** The unsandboxed shell: a POSIX shell that takes the command string after `shellArgs`. */
export interface SandboxInvocation {
  shell: string;
  shellArgs: readonly string[];
  /** The environment the shell would have run with. */
  env: NodeJS.ProcessEnv;
}

/**
 * How a launch ends when its watcher ended it at the memory limit (ADR-0036
 * S1). A signal rather than an exit status, which could be any command's own:
 * only what runs outside the sandbox can send it to the launcher, since
 * Seatbelt lets a command signal its own sandbox alone and bubblewrap's PID
 * namespace hides the launcher from it.
 */
export const MEMORY_LIMIT_SIGNAL = 'SIGUSR2';

/** What to spawn instead. The command string is appended after `args`. */
export interface SandboxLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The profile's wall-time limit: the caller kills the launch with SIGKILL once it has run this long. */
  wallTimeMs?: number;
  /** The profile's memory limit, past which the launch ends by {@link MEMORY_LIMIT_SIGNAL}. */
  memoryBytes?: number;
}

export type SandboxProbe = { ok: true } | { ok: false; detail: string };

export interface SandboxBackend {
  /** How the notice and a skipped test name it. */
  readonly name: string;
  /** Start a trivial command under `profile`: whether this host can run the sandbox at all (ADR-0011 B5). */
  probe(profile: SandboxProfile): Promise<SandboxProbe>;
  /** Builds the launch without starting anything, and throws {@link SandboxUnsupportedError} for a profile it cannot enforce. */
  wrap(invocation: SandboxInvocation, profile: SandboxProfile): SandboxLaunch;
}

/**
 * A profile asks for something this backend cannot hold the command to. A
 * backend refuses rather than run the command under less than it was asked
 * for, so a caller can never mistake a weaker sandbox for the one it built.
 */
export class SandboxUnsupportedError extends Error {
  constructor(backend: string, what: string) {
    super(`${backend} cannot enforce ${what}`);
    this.name = 'SandboxUnsupportedError';
  }
}

/**
 * Paths reach a backend as argv entries and never as policy text, so a quote,
 * newline or parenthesis in one cannot become syntax. What is left to check
 * is that each is absolute: a relative path would resolve against whatever
 * directory the launcher starts in, and one starting with `-` would read as
 * an option.
 */
export function assertProfilePaths(backend: string, profile: SandboxProfile): void {
  const paths = [...profile.write, ...(profile.linkless ?? []), ...(profile.gitWorktrees ?? []), ...(profile.gitEntries ?? []).map((entry) => entry.path), ...(profile.gitless ?? []), ...(profile.read === 'host' ? [] : profile.read), ...(profile.throwaway ?? []), ...(profile.masked ?? [])];
  for (const p of paths) {
    if (!path.posix.isAbsolute(p) || p.includes('\0')) throw new SandboxUnsupportedError(backend, `the path ${JSON.stringify(p)}`);
  }
}

/**
 * Limits reach the prelude script as numbers, so each must be a positive
 * integer: anything else would be shell text in a script that runs outside
 * the sandbox.
 */
export function assertLimits(backend: string, limits: SandboxLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new SandboxUnsupportedError(backend, `the limit ${name}=${String(value)}`);
  }
}

/** The environment a wrapped command starts with: what the profile keeps of the shell's, then what it sets. */
export function launchEnv(invocation: SandboxInvocation, profile: SandboxProfile): NodeJS.ProcessEnv {
  const kept = profile.inheritEnv === undefined
    ? invocation.env
    : Object.fromEntries(profile.inheritEnv.flatMap((name) => (invocation.env[name] === undefined ? [] : [[name, invocation.env[name]]])));
  return { ...kept, ...profile.env };
}

export type ProbeExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>;

/** A probe that hangs must not hold up the first command for long; no answer means no sandbox. */
const PROBE_TIMEOUT_MS = 10_000;

export const execProbe: ProbeExec = (file, args, env) => new Promise((resolve) => {
  try {
    execFile(file, args, { env, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
      resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err?.message ?? '') });
    });
  } catch (err) {
    resolve({ code: null, output: err instanceof Error ? err.message : String(err) });
  }
});

/** The probe both local backends run: `/bin/sh -c true`, wrapped as a real command would be. */
export async function probeByRunning(backend: SandboxBackend, profile: SandboxProfile, exec: ProbeExec): Promise<SandboxProbe> {
  let launch: SandboxLaunch;
  try {
    launch = backend.wrap({ shell: '/bin/sh', shellArgs: ['-c'], env: process.env }, profile);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const { code, output } = await exec(launch.file, [...launch.args, 'true'], launch.env);
  return code === 0 ? { ok: true } : { ok: false, detail: output || (code === null ? 'it did not finish' : `it exited ${code}`) };
}
