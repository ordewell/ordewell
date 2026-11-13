import { execFileSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import type { CommandPolicyOptions } from './commandPolicy';
import { isInertDevice, type HostPath } from './pathScope';

/**
 * Which interpreter runs the planner's `bash` tool, and in which language.
 *
 * `AUTO_COMMANDS` — the read-only tier that runs with no prompt — is `ls`, `cat`,
 * `wc`, `head`, `tail`, `du`, `df`, `file`, `sort`, `uniq`, `basename`, `find`,
 * `grep`. That set is POSIX, and passing it to `shell: true` on Windows means
 * cmd.exe, where most of those names do not exist and `find` is an unrelated
 * program that returns plausible wrong output instead of an error. The planner's
 * whole research surface degraded to guessing, quietly.
 *
 * Rather than write a Windows dialect of every research command — a second
 * behavior to keep in step forever — this finds a POSIX shell to run the
 * existing ones in. Git for Windows ships a full one, and git is already a
 * prerequisite for everything Ordewell does, so in practice it is there. Failing
 * that, cmd.exe is used and the classifier is told so, because the one thing
 * that must never happen is classifying a command in one language and running it
 * in another: `commandPolicy` reads {@link ResearchShell.dialect} for exactly
 * that reason.
 *
 * POSIX resolves to `{ file: null }`, meaning "use `shell: true`" — byte for
 * byte what the adapters did before this module existed.
 *
 * Windows paths are built with `path.win32` explicitly, not the host-flavoured
 * `path`, so the probe is the same on a Windows host as it is under a Linux
 * test runner.
 */

export type ShellDialect = 'posix' | 'cmd';

export interface ResearchShell {
  /**
   * Executable that takes a command string, or null to use the host default
   * via `shell: true`.
   */
  file: string | null;
  /** Arguments preceding the command string. */
  args: string[];
  /** The language the command string will be interpreted in. */
  dialect: ShellDialect;
  /**
   * Directory holding this shell's POSIX utilities, when it brings its own.
   * Prepended to PATH for the search subprocesses (`grep`, `tree`) that
   * `execFile` starts without a shell, so they resolve too.
   */
  utilsDir: string | null;
  /**
   * Where a path this shell is handed lands on the host, for a shell that
   * reads paths its own way; undefined where a path means what the host says.
   * Path confinement judges the folder the command reaches through it, not the
   * one the same spelling names on the host's current drive (ADR-0010).
   */
  hostPath?: HostPath;
}

/**
 * How one command starts: the research shell itself, or the sandbox launcher
 * around it (ADR-0011 B6). Either way the command string is appended after
 * `args`, and `file: null` means `shell: true`.
 */
export interface ShellLaunch {
  file: string | null;
  args: readonly string[];
  /** Undefined inherits the host's environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * A sealed run's wall-time limit (ADR-0036 S1): the adapter kills the
   * launch with SIGKILL once it has run this long, in place of its own
   * timeout, and stops waiting for output a moment after it exits.
   */
  wallTimeMs?: number;
  /** A sealed run's memory limit, which its result names if the run was ended at it (ADR-0036 S1). */
  memoryBytes?: number;
}

/**
 * Git's discovery is told to take a bare repository only when named. A
 * repository can commit a bare one of its own (`vendor/evil.git`), and
 * `git -C vendor/evil.git diff` or a `cd` into it would otherwise run the
 * `diff.external` or textconv program its config names, with the planner's
 * silent, flag-checked `git` as the only gate. Every planner shell carries
 * this, sandboxed or not.
 */
export const PLANNER_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.bareRepository',
  GIT_CONFIG_VALUE_0: 'explicit',
};

const POSIX_SHELL: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };
const CMD_SHELL: ResearchShell = { file: null, args: [], dialect: 'cmd', utilsDir: null };

export interface ResearchShellDeps {
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  env?: NodeJS.ProcessEnv;
  /** What Git Bash's `mount` prints, then its `mount -p`, for the install at `root`; undefined when it cannot run. */
  readMounts?: (root: string) => [string, string] | undefined;
}

/**
 * A mount table: where each mount point sits on the host, whether Git Bash
 * matches it in any case (a `posix=0` mount: the drives, `/tmp`) or only as
 * spelled, and the prefix every drive letter sits under.
 */
export interface MountTable {
  points: Array<{ point: string; host: string; caseless: boolean }>;
  cygdrive: string;
}

function defaultReadMounts(root: string): [string, string] | undefined {
  const mount = path.win32.join(root, 'usr', 'bin', 'mount.exe');
  try {
    // Once per process, on the first command that names a POSIX path: about 65ms warm.
    const read = (args: string[]) => execFileSync(mount, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    return [read([]), read(['-p'])];
  } catch {
    return undefined;
  }
}

/**
 * The table `mount` and `mount -p` print, as `C:/Program Files/Git on / type
 * ntfs (binary,…)` lines and a `Prefix` heading over the drive prefix.
 * Undefined when the output holds no root mount, which no working install prints.
 */
export function parseMounts(mounts: string, prefix: string): MountTable | undefined {
  const points: MountTable['points'] = [];
  for (const line of mounts.split(/\r?\n/)) {
    const m = /^(.+?) on (\/.*?) type \S+ \(([^)]*)\)/.exec(line);
    if (!m) continue;
    const host = m[1].replace(/\//g, '\\');
    points.push({ point: m[2], host: /^[A-Za-z]:$/.test(host) ? `${host}\\` : host, caseless: m[3].split(',').includes('posix=0') });
  }
  if (!points.some((p) => p.point === '/')) return undefined;
  const cygdrive = /^\s*(\/\S*)\s+\S+\s+\S+/m.exec(prefix.split(/\r?\n/).slice(1).join('\n'))?.[1] ?? '/';
  return { points, cygdrive };
}

/** Git for Windows' own table, for when its `mount` cannot be asked. */
function defaultMounts(root: string, env: NodeJS.ProcessEnv): MountTable {
  const temp = env.TEMP || env.TMP;
  return {
    points: [
      { point: '/', host: root, caseless: false },
      { point: '/bin', host: path.win32.join(root, 'usr', 'bin'), caseless: false },
      ...(temp ? [{ point: '/tmp', host: temp, caseless: true }] : []),
    ],
    cygdrive: '/',
  };
}

/**
 * Where Git Bash reads `spelled` to be, run from the host folder `from`, or
 * undefined where its reading cannot be followed for certain (ADR-0010).
 *
 * A POSIX path goes through `table`: its longest mount point, or the drive a
 * letter under the drive prefix names, with `\` read as Git Bash reads it, a
 * separator. A device of the shell's own (`/dev/null`) is left as spelled, and
 * `//server/share` is the network path it names. Git Bash resolves `..` below
 * some mounts on disk and below others by name, so a POSIX path holding one,
 * and a relative one that climbs out of its drive, are undefined: so is the
 * rest of its own `/proc` and `/dev`, which name no folder. A drive, network or
 * root-relative path and a relative one that stays on its drive are read by
 * the host as Git Bash reads them, and `~` is the `HOME` Git Bash would use.
 */
export function mountedHostPath(table: MountTable, spelled: string, from?: string, home?: string): string | undefined {
  if (isInertDevice(spelled)) return spelled;
  if (spelled.startsWith('/')) return mountedAbsolute(table, spelled.replace(/\\/g, '/'));
  if (home && (spelled === '~' || /^~[\\/]/.test(spelled))) {
    const base = home.startsWith('/') ? mountedAbsolute(table, home) : home;
    return base === undefined ? undefined : path.win32.join(base, spelled.slice(1));
  }
  if (from === undefined || /^[A-Za-z]:/.test(spelled) || spelled.startsWith('\\') || spelled.startsWith('~')) return spelled;
  return staysOnDrive(table, spelled.replace(/\\/g, '/'), from) ? spelled : undefined;
}

function mountedAbsolute(table: MountTable, posix: string): string | undefined {
  if (/^\/\/[^/]/.test(posix)) return posix.replace(/\//g, '\\');
  const segments = posix.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return undefined;
  const prefix = table.cygdrive.endsWith('/') ? table.cygdrive : `${table.cygdrive}/`;
  const top = segments[0]?.toLowerCase();
  if (top === 'proc' && segments[1]?.toLowerCase() === 'cygdrive') return mountedAbsolute(table, prefix + segments.slice(2).join('/'));
  if (top === 'proc' || top === 'dev') return undefined;

  const normal = `/${segments.join('/')}`;
  const under = ({ point, caseless }: MountTable['points'][number]) => {
    if (point === '/') return true;
    const [at, here] = caseless ? [point.toLowerCase(), normal.toLowerCase()] : [point, normal];
    return here === at || here.startsWith(`${at}/`);
  };
  let best: { point: string; host: string } | undefined = table.points.filter(under).sort((a, b) => b.point.length - a.point.length)[0];
  const drive = normal.toLowerCase().startsWith(prefix.toLowerCase()) ? /^([a-z])(?:\/|$)/i.exec(normal.slice(prefix.length)) : null;
  if (drive && (!best || prefix.length + 1 > best.point.length)) {
    best = { point: normal.slice(0, prefix.length + 1), host: `${drive[1].toUpperCase()}:\\` };
  }
  if (!best) return undefined;
  const rest = normal.slice(best.point.length).split('/').filter(Boolean);
  return rest.length ? path.win32.join(best.host, ...rest) : best.host;
}

/**
 * Whether a relative path with no `..` past it, or one whose `..` stays on the
 * drive of `from`, lands where the host would put it. Git Bash climbs from its
 * own spelling of `from`, `/c/x` for `C:\x`, and from the drive's top on into
 * its own root: `../../c/Users` from `F:\a` is `C:\Users` to it. Below one of
 * its other mounts, it climbs in ways no one reading can follow.
 */
function staysOnDrive(table: MountTable, relative: string, from: string): boolean {
  if (!relative.split('/').includes('..')) return true;
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(from);
  const underMount = table.points.some((p) => {
    if (/^[A-Za-z]:\\$/.test(p.host)) return false;
    const rel = path.win32.relative(p.host, from);
    return !rel.startsWith('..') && !path.win32.isAbsolute(rel);
  });
  if (!drive || underMount) return false;
  const top = `/${drive[1].toLowerCase()}`;
  const climbed = path.posix.join(`${top}/${from.slice(drive[0].length).replace(/\\/g, '/')}`, relative);
  return climbed === top || climbed.startsWith(`${top}/`);
}

/**
 * How Git Bash reads a path, read from its own `mount` on the first path that
 * needs it, since most commands name none; Git for Windows' defaults stand in
 * when it cannot be asked.
 */
function gitBashHostPath(root: string, env: NodeJS.ProcessEnv, readMounts: (root: string) => [string, string] | undefined): HostPath {
  let table: MountTable | undefined;
  return (spelled, from) => {
    // A relative path that climbs nowhere, and a drive or network path, read the same to the host.
    if (!spelled.startsWith('/') && !spelled.startsWith('~') && !/(^|[\\/])\.\.([\\/]|$)/.test(spelled)) return spelled;
    if (!table) {
      const read = readMounts(root);
      table = (read && parseMounts(...read)) ?? defaultMounts(root, env);
    }
    return mountedHostPath(table, spelled, from, env.HOME);
  };
}

function defaultExists(candidate: string): boolean {
  try {
    return fsSync.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Where Git for Windows puts its shell, per install flavour. `bin/bash.exe` is
 * the wrapper users get on PATH; `usr/bin/bash.exe` is the same shell in the
 * MSYS tree, listed because a minimal/portable install may omit the former.
 *
 * `C:\Windows\System32\bash.exe` is deliberately absent and must stay absent:
 * that is the WSL launcher. It runs commands inside a Linux VM with its own
 * filesystem view (`/mnt/c/...`), so a workspace path means something different
 * there — which would put every command outside the root that path confinement
 * is checking against, and every relative path against the wrong tree.
 */
function gitBashRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git',
  ].filter((r): r is string => !!r);
  return [...new Set(roots)];
}

let cached: ResearchShell | null = null;

/**
 * The shell the planner's `bash` tool should use on this host. Resolved once per
 * process — the answer cannot change while Ordewell runs, and the probe costs a
 * handful of `stat` calls.
 */
export function resolveResearchShell(deps: ResearchShellDeps = {}): ResearchShell {
  // A call with a seam of its own is a probe, and neither reads nor fills the cache.
  const probe = !!(deps.platform || deps.exists || deps.env || deps.readMounts);
  if (cached && !probe) return cached;

  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    if (!probe) cached = POSIX_SHELL;
    return POSIX_SHELL;
  }

  const exists = deps.exists ?? defaultExists;
  const env = deps.env ?? process.env;

  for (const root of gitBashRoots(env)) {
    for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
      const file = path.win32.join(root, ...rel);
      if (!exists(file)) continue;
      const utilsDir = path.win32.join(root, 'usr', 'bin');
      const resolved: ResearchShell = {
        file,
        // `-c`, not `-lc`: a login shell sources the user's profile, which can
        // change directory out from under a command whose cwd is the workspace.
        args: ['-c'],
        dialect: 'posix',
        utilsDir: exists(path.win32.join(utilsDir, 'grep.exe')) ? utilsDir : null,
        hostPath: gitBashHostPath(root, env, deps.readMounts ?? defaultReadMounts),
      };
      if (!probe) cached = resolved;
      return resolved;
    }
  }

  if (!probe) cached = CMD_SHELL;
  return CMD_SHELL;
}

/** Test seam: drop the per-process cache so the next call re-probes. */
export function clearResearchShellCache(): void {
  cached = null;
}

/**
 * PATH for the search subprocesses the adapters start without a shell, with the
 * research shell's own utilities in front. Without this, `grep` — the fallback
 * when ripgrep is absent — is unresolvable on a Windows box even when a
 * perfectly good `grep.exe` sits in the Git tree beside the shell.
 */
export function researchToolsPath(shell: ResearchShell, basePath: string | undefined): string {
  // `utilsDir` is only ever set on the Windows branch, so the delimiter is `;`.
  if (!shell.utilsDir) return basePath ?? '';
  const segments = [shell.utilsDir, ...(basePath ?? '').split(path.win32.delimiter)].filter(Boolean);
  return [...new Set(segments)].join(path.win32.delimiter);
}

/**
 * A message explaining a degraded research surface, or null when there is
 * nothing to explain. Surfaced by the adapters on the first refused command so
 * the limitation is visible rather than inferred from bad answers.
 */
export function researchShellWarning(shell: ResearchShell): string | null {
  if (shell.dialect !== 'cmd') return null;
  return 'No POSIX shell was found on this machine, so research commands run through cmd.exe, '
    + 'where most read-only tools (ls, cat, wc, head, grep, find) do not exist. '
    + 'Installing Git for Windows provides one and restores the full research toolset.';
}

/**
 * What a research-shell command is classified under. One function, because a
 * subagent must never classify under different rules than its parent: the
 * shell's dialect, and whether a `CDPATH` in the environment can send a
 * relative `cd` somewhere the line never names.
 */
export function researchPolicyOptions(shell: ResearchShell): CommandPolicyOptions {
  return { dialect: shell.dialect, cdpathSet: !!process.env.CDPATH };
}
