import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { timeLimitText } from '../../models/ScriptTask';
import type { ResearchShell, ShellLaunch } from '../researchShell';
import { SEALED_RUN_MARK } from '../researchStepSummary';
import { BubblewrapBackend, findBubblewrap } from './bubblewrap';
import { SANDBOX_EXEC, SeatbeltBackend } from './seatbelt';
import { processAlive } from '../../utils/processTree';
import { execProbe, MEMORY_LIMIT_SIGNAL, type ProbeExec, type SandboxBackend, type SandboxGitEntry, type SandboxInvocation, type SandboxLaunch, type SandboxLimits, type SandboxProfile } from './SandboxBackend';

/**
 * The planner's shell inside an OS sandbox (ADR-0011): every command the
 * planner's `bash` tool, its research subagents and a harness planner's
 * `run_command` start runs where nothing outside one scratch directory per
 * session can be written. It sits underneath the classifier and changes
 * nothing about which commands are `auto`, `ask` or `refuse` (B1). Where it
 * runs, a command the envelope would refuse without asking can run sealed
 * instead, under a stricter profile of its own (ADR-0036 S1, S2).
 */

export const PLANNER_SANDBOX_DOCS = 'https://github.com/ordewell/ordewell/blob/main/docs/troubleshooting.md#planner-shell-not-sandboxed';

/** Where a sealed run starts: the workspace it reads, and the one other directory, if any, it may write (ADR-0036 S1). */
export interface SealedRunOptions {
  workspace: string;
  /** None by default, so the workspace stays read-only. A read-only task passes its own throwaway worktree (ADR-0046). */
  writable?: string;
  /**
   * The git worktree roots inside `writable` whose own `.git` a sealed run
   * must not rewrite into a repository of its own (ADR-0046). A repo group
   * passes one per repo; left out, the single `writable` worktree is used.
   */
  worktrees?: readonly string[];
  /**
   * Every `.git` entry the writable directory held before the task's first
   * sealed run, which a sealed run may not change (ADR-0046). The worktree
   * roots above cover their own `.git`; this covers a submodule's file and a
   * vendored repository, whose content a run could otherwise rearm.
   */
  gitEntries?: readonly SandboxGitEntry[];
  /**
   * A harness's short per-session temporary directory, writable besides the
   * scratch one (ADR-0036 N2). A native shell needs it: Claude Code writes the
   * shell's working directory there after every command.
   */
  tmpdir?: string;
  /**
   * The network the harness gives its own shell (ADR-0036 N3). A sealed run has
   * none (S1); only the native-shell opt-in asks for this profile with one.
   */
  network?: boolean;
  /**
   * Whether the keychain is in reach with that network. Defaults to true, as
   * for an approved command; a native shell passes false (N2.2).
   */
  keychain?: boolean;
  /** Whether that network reaches loopback and this machine's Unix sockets. Defaults to true; a native shell passes false (N2). */
  localNetwork?: boolean;
  /**
   * The limits the sealed run is held to (ADR-0036 S1). {@link SEALED_LIMITS}
   * by default; a read-only task passes {@link TASK_SEALED_LIMITS}, since its
   * one shell is where it runs the project's tests (ADR-0046).
   */
  limits?: SandboxLimits;
}

export type SealedAvailability =
  | {
    available: true;
    /** The sealed profile on this host; without a scratch directory, nothing is writable. */
    profile: (opts: SealedRunOptions & { scratch?: string }) => SandboxProfile;
  }
  /** The session's one notice where the sandbox runs but cannot start a sealed run (S6). */
  | { available: false; notice: string };

export type PlannerSandboxAvailability =
  | {
    available: true;
    backend: SandboxBackend;
    /** The planner's profile on this host; without a scratch directory, nothing is writable. */
    profile: (opts: { scratch?: string; network: boolean }) => SandboxProfile;
    sealed: SealedAvailability;
  }
  /** The one notice the planner surface shows a session (B5). */
  | { available: false; notice: string };

export interface PlannerSandboxDeps {
  platform?: NodeJS.Platform;
  /** An existing directory a sealed probe can mount as its workspace. */
  probeWorkspace?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** An existing path's canonical form and whether it is a directory, or null. */
  stat?: (p: string) => { canonical: string; directory: boolean } | null;
  uid?: number;
  exec?: ProbeExec;
}

function defaultExists(file: string): boolean {
  try {
    return fsSync.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultStat(p: string): { canonical: string; directory: boolean } | null {
  try {
    const canonical = fsSync.realpathSync(p);
    return { canonical, directory: fsSync.statSync(canonical).isDirectory() };
  } catch {
    return null;
  }
}

/**
 * What the commands the planner commonly reads with write as a side effect,
 * pointed at the scratch directory or told not to (B2). Each is a cache or a
 * log, so a fresh one per session costs time, never correctness.
 */
function scratchEnv(scratch: string, platform: NodeJS.Platform): Record<string, string> {
  return {
    TMPDIR: scratch,
    // `git status` and `git diff` take the index lock to refresh stat data.
    GIT_OPTIONAL_LOCKS: '0',
    // npm writes a debug log under its cache for every command, `npm ls` too,
    // and records its update check there.
    npm_config_cache: path.join(scratch, 'npm'),
    npm_config_update_notifier: 'false',
    // `go list` opens the build cache.
    GOCACHE: path.join(scratch, 'go-build'),
    // Where Linux tools that follow the XDG layout (pip among them) keep caches.
    XDG_CACHE_HOME: path.join(scratch, 'cache'),
    // Python otherwise writes bytecode beside the sources, in the workspace.
    PYTHONPYCACHEPREFIX: path.join(scratch, 'pycache'),
    // The `/usr/bin` shims of Apple's command-line tools (`git` among them)
    // cache lookups in the user's temporary directory, ignoring TMPDIR, and
    // print an error on every call when they cannot.
    ...(platform === 'darwin' ? { xcrun_db: path.join(scratch, 'xcrun_db') } : {}),
  };
}

/**
 * Where Linux's local services listen, hidden from a command without the
 * network (B3). `--unshare-net` cuts every socket reached by address, but a
 * socket that is a file stays reachable through the read-only root, and these
 * act on the caller's behalf: the session bus starts programs through
 * `systemd-run --user`, the system bus reaches logind and PackageKit, an X
 * server takes typed keystrokes, and the Docker daemon mounts anything. An
 * approved command keeps them, since its credentials may live behind the
 * session bus (git's libsecret helper, `gh`'s keyring). macOS needs no list:
 * its profile denies unix sockets with the rest of the network.
 */
function localServices(env: NodeJS.ProcessEnv, stat: NonNullable<PlannerSandboxDeps['stat']>, uid: number | undefined): string[] {
  const runtimeDir = env.XDG_RUNTIME_DIR && path.posix.isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : undefined;
  const candidates = [runtimeDir, uid === undefined ? undefined : `/run/user/${uid}`, '/run/dbus', '/tmp/.X11-unix', '/run/docker.sock'];
  const found = candidates.flatMap((p) => (p ? [stat(p)?.canonical] : [])).filter((p): p is string => !!p && p !== '/');
  return [...new Set(found)];
}

/** The planner's profile (B2, B3): the host readable, scratch writable, the network only for an approved command. */
export function plannerShellProfile(
  host: { platform: NodeJS.Platform; services: readonly string[] },
  opts: { scratch?: string; network: boolean },
): SandboxProfile {
  return {
    write: opts.scratch ? [opts.scratch] : [],
    read: 'host',
    masked: opts.network ? [] : host.services,
    network: opts.network,
    env: opts.scratch ? scratchEnv(opts.scratch, host.platform) : {},
  };
}

/**
 * What a sealed run may read outside the workspace (S1): what programs need
 * to start, and none of the user's files. Linux's are named where programs
 * look for them, links included (`/bin`, `/lib64`), since bubblewrap mounts
 * each where it is named; macOS's are canonical, as Seatbelt matches them.
 * Those not on this host are left out.
 */
const SEALED_READS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  linux: [
    '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32',
    '/etc/alternatives', '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d',
    '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/localtime',
    // NixOS keeps every program in its store.
    '/nix/store', '/run/current-system',
  ],
  darwin: [
    '/System', '/usr', '/bin', '/sbin', '/dev', '/private/etc',
    // Apple's `/usr/bin` shims (`git`, `python3`) find their tools through these.
    '/private/var/select', '/private/var/db/xcode_select_link', '/Library/Developer/CommandLineTools',
    '/private/var/db/timezone', '/Library/Frameworks', '/opt/homebrew',
  ],
};

/**
 * Inside those, where Homebrew keeps the data of the services the user runs
 * with it. Its `etc` stays readable: git and OpenSSL stop on a configuration
 * file the sandbox denies rather than one that is missing.
 */
const SEALED_MASKS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['/usr/local/var', '/opt/homebrew/var'],
};

/**
 * The host variables a sealed run keeps: where programs are, and how to
 * print. None holds a credential, which a sealed run must not have (S1); its
 * `HOME` is the scratch directory.
 */
const SEALED_ENV: readonly string[] = [
  'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
  'TZ', 'TERM', 'USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING',
];

/**
 * Time enough for a loop over a repository's files, a pipeline or a short
 * script, not for a build. The memory is real memory across the run; the
 * address space is per process and far above what V8 reserves for ordinary
 * programs (ADR-0036 S1, which records the measurement).
 */
export const SEALED_LIMITS: SandboxLimits = { processes: 256, memoryBytes: 4 * 1024 ** 3, addressSpaceBytes: 256 * 1024 ** 3, wallTimeMs: 60_000 };

/**
 * A read-only task's sealed runs (ADR-0046): the same resources, with the ten
 * minutes a script task gets by default, since its one shell is where the task
 * runs the project's tests and a suite does not fit in a minute.
 */
export const TASK_SEALED_LIMITS: SandboxLimits = { ...SEALED_LIMITS, wallTimeMs: 10 * 60_000 };

/**
 * A sealed run's profile (S1): the workspace read-only, or a throwaway
 * overlay over it where the host has one; the scratch directory writable and
 * its `HOME`; outside the workspace only {@link SEALED_READS}; no network, a
 * /tmp of its own, and limits.
 */
export function sealedShellProfile(
  host: { platform: NodeJS.Platform; reads: readonly string[]; masked: readonly string[]; overlay: boolean },
  opts: SealedRunOptions & { scratch?: string },
): SandboxProfile {
  const writable = opts.writable;
  const worktrees = opts.worktrees ?? (writable ? [writable] : []);
  // Only entries under the writable directory are held: one a link points
  // outside it needs no protection, and binding it could reveal a file the
  // read list withholds (ADR-0046).
  const gitEntries = writable ? (opts.gitEntries ?? []).filter((entry) => strictlyWithin(entry.path, writable)) : [];
  // A repo group's task workspace root holds no worktree's `.git`, and is where
  // the runner's own git starts: binding only its worktrees leaves the root
  // read-only, so a sealed run cannot plant a repository there (ADR-0046). One
  // repository keeps its writable directory whole.
  const groupRoot = writable !== undefined && worktrees.length > 0 && worktrees.every((worktree) => strictlyWithin(worktree, writable));
  return {
    write: [opts.scratch, ...(groupRoot ? worktrees : writable ? [writable] : []), opts.tmpdir].filter((p): p is string => !!p),
    // Seatbelt refuses a link by its type; under bubblewrap the task shell removes those leading out once the run ends (ADR-0046).
    ...(writable && host.platform === 'darwin' ? { linkless: [writable] } : {}),
    // Keep each worktree's `.git` the repository's, so git run outside the sandbox never loads one a sealed run planted (ADR-0046).
    ...(worktrees.length ? { gitWorktrees: worktrees } : {}),
    // And every other `.git` the checkout brought: a submodule's file, a vendored repository (ADR-0046).
    ...(gitEntries.length ? { gitEntries } : {}),
    // The whole writable directory, since a repo group's runner starts its git at the task workspace's root, which holds no worktree's `.git`.
    ...(writable && host.platform === 'darwin' ? { gitless: [writable] } : {}),
    read: [...host.reads, opts.workspace],
    ...(host.overlay ? { throwaway: [opts.workspace] } : {}),
    masked: host.masked,
    network: opts.network === true,
    ...(opts.keychain === undefined ? {} : { keychain: opts.keychain }),
    ...(opts.localNetwork === undefined ? {} : { localNetwork: opts.localNetwork }),
    privateTmp: true,
    env: opts.scratch ? { ...scratchEnv(opts.scratch, host.platform), HOME: opts.scratch } : {},
    inheritEnv: SEALED_ENV,
    limits: opts.limits ?? SEALED_LIMITS,
  };
}

/** Whether `child` lies below `parent` rather than being it. */
function strictlyWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The protected `.git` entries made canonical, as Seatbelt matches the path
 * the kernel resolves. One gone since the snapshot is left out: there is
 * nothing to protect, and the check after the run stops the shell for it.
 */
function canonicalGitEntries(entries: readonly SandboxGitEntry[]): SandboxGitEntry[] {
  return entries.flatMap((entry) => {
    try {
      const p = fsSync.realpathSync(entry.path);
      return [{ path: p, directory: fsSync.statSync(p).isDirectory() }];
    } catch {
      return [];
    }
  });
}

const LEAD = "The planner's shell runs without an OS sandbox on this machine";
const STILL = "Its commands are still held to Ordewell's command rules, as everywhere, but nothing at the OS level stops one that gets past them from writing, and a command those rules refuse, such as a loop or a script for an interpreter, is refused rather than run sealed.";
const RESTART = 'then restart Ordewell: the sandbox is checked once per process.';

function unavailable(cause: string, fix?: string): PlannerSandboxAvailability {
  return { available: false, notice: [`${LEAD}: ${cause}. ${STILL}`, ...(fix ? [fix] : []), PLANNER_SANDBOX_DOCS].join('\n\n') };
}

/** Bubblewrap's own words when the kernel will not give it a user namespace. */
const USERNS_FAILURE = /uid map|user namespace|RTM_NEWADDR|Operation not permitted|Permission denied/i;

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 200) ?? text;
}

async function detect(deps: PlannerSandboxDeps): Promise<PlannerSandboxAvailability> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? defaultExists;
  const exec = deps.exec ?? execProbe;

  let backend: SandboxBackend;
  let services: string[] = [];
  const stat = deps.stat ?? defaultStat;
  if (platform === 'darwin') {
    if (!exists(SANDBOX_EXEC)) return unavailable(`${SANDBOX_EXEC} is missing`);
    backend = new SeatbeltBackend(exec);
  } else if (platform === 'linux') {
    const bwrap = findBubblewrap(env, exists);
    if (!bwrap) return unavailable('bubblewrap (bwrap) is not installed', `Install it (for example \`sudo apt install bubblewrap\`), ${RESTART}`);
    backend = new BubblewrapBackend(bwrap, { exec, isDirectory: (p) => stat(p)?.directory ?? false });
    services = localServices(env, stat, 'uid' in deps ? deps.uid : process.getuid?.());
  } else {
    return unavailable(`${platform === 'win32' ? 'Windows' : platform} has no sandbox Ordewell can put around it`);
  }

  const profile = (opts: { scratch?: string; network: boolean }) => plannerShellProfile({ platform, services }, opts);
  // The stricter of the two profiles, so a host that can start one can start both.
  const probe = await backend.probe(profile({ network: false }));
  if (probe.ok) return { available: true, backend, profile, sealed: await detectSealed(backend, platform, stat, deps.probeWorkspace) };

  const detail = firstLine(probe.detail);
  if (platform === 'linux' && USERNS_FAILURE.test(probe.detail)) {
    return unavailable(
      `bubblewrap could not start (${detail})`,
      `Ubuntu 24.04 and later restrict the user namespaces it needs. Install an AppArmor profile for bwrap, or run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\`, ${RESTART}`,
    );
  }
  return unavailable(`${backend.name} could not start (${detail})`);
}

/**
 * Whether this host's sandbox can also hold a sealed run, probed with the
 * sealed profile itself: its read list, its limits, and an overlay over the
 * workspace, then without the overlay where that one cannot start.
 */
async function detectSealed(
  backend: SandboxBackend,
  platform: NodeJS.Platform,
  stat: NonNullable<PlannerSandboxDeps['stat']>,
  probeWorkspace = os.tmpdir(),
): Promise<SealedAvailability> {
  const existing = (paths: readonly string[] | undefined) => (paths ?? []).filter((p) => stat(p) !== null);
  // Seatbelt matches the path the kernel resolves, a link as the link itself; bubblewrap mounts a link where it is named.
  const named = (paths: readonly string[]) => (platform === 'darwin'
    ? paths.map((p) => path.posix.join(stat(path.posix.dirname(p))?.canonical ?? path.posix.dirname(p), path.posix.basename(p)))
    : paths);
  const developerDir = platform === 'darwin' ? stat('/private/var/select/developer_dir')?.canonical : undefined;
  const reads = [...new Set([...named(existing(SEALED_READS[platform])), ...(developerDir ? [developerDir] : [])])];
  const masked = named(existing(SEALED_MASKS[platform]));
  const workspace = stat(probeWorkspace)?.canonical ?? probeWorkspace;

  let detail = '';
  for (const overlay of [true, false]) {
    const profile = (opts: SealedRunOptions & { scratch?: string }) => sealedShellProfile({ platform, reads, masked, overlay }, opts);
    const probe = await backend.probe(profile({ workspace }));
    if (probe.ok) return { available: true, profile };
    detail = firstLine(probe.detail);
  }
  return {
    available: false,
    notice: [
      `Sealed runs are unavailable on this machine: ${backend.name} could not start one (${detail}). The planner's commands still run in the sandbox, but one Ordewell's command rules refuse, such as a loop or a script for an interpreter, is refused rather than run sealed.`,
      PLANNER_SANDBOX_DOCS,
    ].join('\n\n'),
  };
}

let cached: Promise<PlannerSandboxAvailability> | null = null;

/**
 * Whether this host can sandbox the planner's shell, and how. Probed once per
 * process with a trivial command (B5): the answer cannot change while
 * Ordewell runs, and concurrent first commands share one probe. Injected
 * dependencies bypass the cache, as {@link resolveResearchShell}'s do.
 */
export function resolvePlannerSandbox(deps: PlannerSandboxDeps = {}): Promise<PlannerSandboxAvailability> {
  if (Object.keys(deps).length > 0) return detect(deps);
  cached ??= detect(deps);
  return cached;
}

/** Test seam: drop the per-process probe so the next call probes again. */
export function clearPlannerSandboxCache(): void {
  cached = null;
}

/** Scratch directories still on disk, removed when the process exits if their session never ended. */
const liveScratch = new Set<string>();
let firstScratch = true;

function removeScratch(dir: string): void {
  liveScratch.delete(dir);
  try {
    fsSync.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The OS temporary directory is cleaned eventually; a failed removal must not fail the session.
  }
}

/**
 * Remove what a process left behind that died without exiting: killed, or a
 * test worker torn down mid-run, where no exit hook runs. Each directory names
 * the process that made it, so only one whose process is gone is removed, and
 * only one this user owns.
 */
export function sweepOrphanScratch(root: string): void {
  let names: string[];
  try {
    names = fsSync.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^ordewell-planner-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    const dir = path.join(root, name);
    try {
      const stat = fsSync.lstatSync(dir);
      if (stat.isDirectory() && stat.uid === process.getuid?.()) fsSync.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another process's sweep got there first, or it is not ours to remove.
    }
  }
}

function createScratch(): string {
  if (firstScratch) {
    firstScratch = false;
    process.once('exit', () => { for (const dir of [...liveScratch]) removeScratch(dir); });
    sweepOrphanScratch(os.tmpdir());
  }
  // `mkdtemp` creates it 0700. Canonical, because Seatbelt matches the path
  // the kernel resolves (`/private/var/...`, not `/var/...`).
  const dir = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), `ordewell-planner-${process.pid}-`)));
  liveScratch.add(dir);
  return dir;
}

/** The research shell as one command should start, and whether that is inside the sandbox. */
export interface PlannerShellLaunch {
  launch: ShellLaunch;
  sandboxed: boolean;
}

/**
 * One session's view of the sandbox: its scratch directory, made on the first
 * command and removed when the session ends, and its one notice when the
 * sandbox, or a sealed run in it, cannot run here.
 */
export class PlannerShellSandbox {
  private scratch: string | null = null;
  private noticed = false;
  private notice: (message: string) => void = () => {};

  constructor(private readonly resolve: () => Promise<PlannerSandboxAvailability> = () => resolvePlannerSandbox()) {}

  setNotice(notice: (message: string) => void): void {
    this.notice = notice;
  }

  /** The same host's sandbox for another caller, with a scratch directory of its own: a read-only task's (ADR-0046). */
  withOwnScratch(): PlannerShellSandbox {
    return new PlannerShellSandbox(this.resolve);
  }

  /**
   * The launch for one command (B6): the research shell wrapped in the
   * sandbox, with the network as the caller's tier allows (B3), or the shell
   * itself where no sandbox runs, after saying so once (B5). Throws when the
   * sandbox runs here but this command cannot be put in it, so a command is
   * never run outside a sandbox that exists.
   */
  async launch(shell: ResearchShell, opts: { network: boolean }): Promise<PlannerShellLaunch> {
    const availability = await this.resolve();
    if (!availability.available) {
      this.say(availability.notice);
      return { launch: shell, sandboxed: false };
    }
    if (!availability.sealed.available) this.say(availability.sealed.notice);
    const launch = availability.backend.wrap(
      this.invocation(shell),
      availability.profile({ scratch: this.scratchDir(), network: opts.network }),
    );
    return { launch, sandboxed: true };
  }

  /** Whether a command can run sealed here (ADR-0036 S6). Where it cannot, the session's one notice says so. */
  async canSeal(): Promise<boolean> {
    const availability = await this.resolve();
    if (!availability.available) this.say(availability.notice);
    else if (!availability.sealed.available) this.say(availability.sealed.notice);
    return availability.available && availability.sealed.available;
  }

  /**
   * The launch for one sealed run (S1), in this session's scratch directory.
   * Throws where sealed runs are unavailable, which {@link canSeal} answers
   * first, and for a shell the sandbox cannot wrap.
   */
  async launchSealed(shell: ResearchShell, opts: SealedRunOptions): Promise<ShellLaunch> {
    const availability = await this.resolve();
    if (!availability.available || !availability.sealed.available) throw new Error('sealed runs are unavailable on this machine');
    // Canonical, because Seatbelt matches the path the kernel resolves, and the workspace is where the command starts.
    const canonical = (p: string) => fsSync.realpathSync(p);
    return availability.backend.wrap(this.invocation(shell), availability.sealed.profile({
      scratch: this.scratchDir(),
      workspace: canonical(opts.workspace),
      ...(opts.writable ? { writable: canonical(opts.writable) } : {}),
      ...(opts.worktrees ? { worktrees: opts.worktrees.map(canonical) } : {}),
      ...(opts.gitEntries ? { gitEntries: canonicalGitEntries(opts.gitEntries) } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
    }));
  }

  /**
   * The launch for a harness's own shell (ADR-0036 N2): the same sealed profile
   * as a sealed run, with the network the harness gives it (N3), plus the
   * harness's short temporary directory. The workspace stays read-only. Throws
   * where the sandbox cannot run, so a caller never falls back to the bare shell.
   */
  async launchNativeShell(opts: { workspace: string; tmpdir: string; shell: string; shellArgs?: readonly string[]; env?: NodeJS.ProcessEnv }): Promise<SandboxLaunch> {
    const availability = await this.resolve();
    if (!availability.available || !availability.sealed.available) throw new Error('a sandbox for the native shell is unavailable on this machine');
    const profile = availability.sealed.profile({
      scratch: this.scratchDir(),
      workspace: fsSync.realpathSync(opts.workspace),
      tmpdir: fsSync.realpathSync(opts.tmpdir),
      network: true,
      // N2.2: the user's keychain stays out of reach even with the network.
      keychain: false,
      // N2: the harness's server and Ordewell's daemon would run a command
      // outside the sandbox for a shell that read their passwords.
      localNetwork: false,
    });
    // A sealed run's limits come with a prelude that kills the command when
    // the caller's stdin pipe closes, since that is how a run learns Ordewell
    // died. The harness is the caller here and may hand the launcher an empty
    // pipe, which would kill every command; the harness bounds its own shell's
    // time instead. The workspace stays read-only even where a sealed run may
    // take a throwaway overlay (S1): a native command writes nothing of the
    // workspace, not even into a layer that is discarded.
    return availability.backend.wrap(
      { shell: opts.shell, shellArgs: opts.shellArgs ?? ['-c'], env: opts.env ?? process.env },
      { ...profile, limits: undefined, throwaway: undefined },
    );
  }

  /** The scratch directory every launch here gets as `$TMPDIR` and `$HOME`, made if it is not there. */
  scratchPath(): string {
    return this.scratchDir();
  }

  /** The session ended: its scratch directory goes, and a next session starts with a fresh one and its own notice. */
  end(): void {
    if (this.scratch) removeScratch(this.scratch);
    this.scratch = null;
    this.noticed = false;
  }

  private say(notice: string): void {
    if (this.noticed) return;
    this.noticed = true;
    this.notice(notice);
  }

  private invocation(shell: ResearchShell): SandboxInvocation {
    // Wrapping puts the command in a POSIX shell, and a command classified as cmd.exe must never run in one.
    if (shell.dialect !== 'posix') throw new Error(`the sandbox runs a POSIX shell, and this one is ${shell.dialect}`);
    // `file: null` is Node's `shell: true`, which on POSIX is `/bin/sh -c`.
    return { shell: shell.file ?? '/bin/sh', shellArgs: shell.file === null ? ['-c'] : shell.args, env: process.env };
  }

  private scratchDir(): string {
    // Made again if something removed it meanwhile, as a temporary-file cleaner may.
    if (!this.scratch || !fsSync.existsSync(this.scratch)) this.scratch = createScratch();
    return this.scratch;
  }
}

/** The sandbox's own signatures in a failed command's output: a write it refused, or a network it withheld. */
const SANDBOX_DENIAL = /Operation not permitted|Read-only file system|Could not resolve host|Temporary failure in name resolution|Network is unreachable|nodename nor servname|ENOTFOUND|EAI_AGAIN/;

/**
 * A line appended to a sandboxed command's failure that looks like the
 * sandbox's doing, so the planner reads "the sandbox stopped this" rather
 * than "the repository is broken", and does not retry it.
 */
export function sandboxedFailureNote(output: string, network: boolean, forTask = false): string | null {
  if (!SANDBOX_DENIAL.test(output)) return null;
  if (forTask) return `The command ran sandboxed: it could write only its scratch directory ($TMPDIR)${network ? '' : ', with no network'}.`;
  return `The planner's shell is sandboxed: it cannot write outside its scratch directory ($TMPDIR)${network ? '' : ', and a command that runs without asking has no network'}. A change belongs in the plan as a task.`;
}

/**
 * Why a command ran sealed: the planner asked, the envelope would have
 * refused it or asked about it, or a read-only task's shell already ran one
 * sealed, after which all its commands are (ADR-0046).
 */
export type SealedRunReason = 'asked' | 'refused' | 'after';

const SEALED_RUN_REASONS: Record<SealedRunReason, string> = {
  asked: ' as asked',
  refused: ' instead of being refused',
  after: ', as every command of this task is after its first sealed run',
};

/**
 * The line a sealed run's result starts with (ADR-0036 S4): that it ran
 * sealed and what that means, so a loop of cloud calls that fails on the
 * network is understood rather than retried.
 */
export function sealedRunHeader(why: SealedRunReason, task?: { worktree: boolean; first: boolean }): string {
  const how = `${SEALED_RUN_MARK}${SEALED_RUN_REASONS[why]}`;
  if (!task) return `${how}: no network, no home directory, and nothing it writes reaches the workspace. $HOME and $TMPDIR are this session's scratch directory, the one place it can write, which later commands can read.]`;
  // A worktree's `.git` is a file pointing into the repository's own, which stays read-only (ADR-0046).
  const where = task.worktree
    ? "This task's worktree is writable and is thrown away when the task ends. git can read the repository but not record anything in it: a commit, an add or a stash fails, or is gone when the command ends."
    : 'The workspace is read-only: this task has no worktree of its own.';
  // Said once, by the run that sealed the task's shell; later headers name it (ADR-0046).
  const onward = task.first
    ? ` It may have written this task's ${task.worktree ? 'worktree' : 'scratch directory'}, so every later command of this task runs sealed too, without the network.`
    : '';
  return `${how}: no network and no home directory. ${where} $HOME and $TMPDIR are this task's scratch directory, which later commands can read.${onward}]`;
}

/** A read-only task's {@link SEALED_FAILURE_NOTE}: it has nowhere to send the work but its report (ADR-0046). */
export const TASK_SEALED_FAILURE_NOTE = "A sealed run cannot reach the network, the user's credentials or their files outside the workspace, and writes nothing but this task's worktree and scratch directory, so running it again fails the same way. If what it could not do matters, say so in your report.";

/**
 * Appended to a sealed run the wall-time limit ended (ADR-0036 S1), in place
 * of a failure note about reach: the command did not fail, it ran out of time,
 * so the way on is to run less at a time rather than not at all.
 */
export function sealedTimeLimitNote(wallTimeMs: number, forTask: boolean): string {
  const limit = timeLimitText(wallTimeMs);
  return forTask
    ? `The sealed run was ended at its time limit of ${limit}: what it had not finished did not happen. Run less at a time, in commands that each finish inside the limit, or say in your report what needs longer.`
    : `The sealed run was ended at its time limit of ${limit}: what it had not finished did not happen. A command that needs longer belongs in the plan as a task; to read something, run it in pieces that each finish in time.`;
}

/** A byte count in the largest binary unit it is a whole number of: "4 GiB", "200 MiB". */
function memoryLimitText(bytes: number): string {
  const units: [number, string][] = [[1024 ** 3, 'GiB'], [1024 ** 2, 'MiB'], [1024, 'KiB'], [1, 'bytes']];
  const [size, name] = units.find(([unit]) => bytes % unit === 0) ?? units[units.length - 1];
  return `${bytes / size} ${name}`;
}

/**
 * Appended to a sealed run the memory limit ended (ADR-0036 S1), in place of a
 * failure note about reach, or null for any other failure. Ended by the signal
 * only the launcher's watcher sends, so nothing a command prints or exits with
 * can claim it.
 */
export function sealedMemoryLimitNote(outcome: { signal?: NodeJS.Signals }, memoryBytes: number | undefined, forTask: boolean): string | null {
  if (outcome.signal !== MEMORY_LIMIT_SIGNAL || memoryBytes === undefined) return null;
  const limit = memoryLimitText(memoryBytes);
  return forTask
    ? `The sealed run was ended at its memory limit of ${limit}, counted across all its processes: what it had not finished did not happen. Run less at a time, with fewer parallel workers or in commands that each hold less, or say in your report what needs more.`
    : `The sealed run was ended at its memory limit of ${limit}, counted across all its processes: what it had not finished did not happen. A command that needs more belongs in the plan as a task; to read something, run it in pieces that each hold less.`;
}

/** Appended to a sealed run that failed: what it could never have done, and what to do in place of a retry. */
export const SEALED_FAILURE_NOTE = "A sealed run cannot reach the network, the user's credentials or their files outside the workspace, and cannot change the workspace, so running it sealed again fails the same way. To read something it could not, run each command on its own, without a loop or inline code, so Ordewell's command rules can judge it; a change belongs in the plan as a task.";
