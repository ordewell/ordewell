import * as fsSync from 'fs';
import * as path from 'path';
import {
  assertLimits,
  assertProfilePaths,
  execProbe,
  launchEnv,
  MEMORY_LIMIT_SIGNAL,
  probeByRunning,
  SandboxUnsupportedError,
  type ProbeExec,
  type SandboxBackend,
  type SandboxInvocation,
  type SandboxLaunch,
  type SandboxLimits,
  type SandboxProbe,
  type SandboxProfile,
} from './SandboxBackend';

/**
 * Where distributions install `bwrap`, tried before PATH. A `bwrap` that
 * PATH finds first could be any program at all, and a sandbox that silently
 * is not one is the failure this module exists to prevent.
 */
const SYSTEM_BWRAP = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap', '/run/current-system/sw/bin/bwrap'];

/** The `bwrap` to launch, or null when none is installed. Only absolute PATH entries count: a relative one resolves against the workspace. */
export function findBubblewrap(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | null {
  const onPath = (env.PATH ?? '').split(path.posix.delimiter)
    .filter((dir) => path.posix.isAbsolute(dir))
    .map((dir) => path.posix.join(dir, 'bwrap'));
  return [...new Set([...SYSTEM_BWRAP, ...onPath])].find(exists) ?? null;
}

function defaultIsDirectory(p: string): boolean {
  try {
    return fsSync.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Parents before children, so a deeper mount is never covered by one made after it. */
function shallowFirst(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.split('/').length - b.split('/').length);
}

/**
 * Where the watcher finds `sleep`, in place of a PATH the host gave it: the
 * watcher runs outside the sandbox, and a relative PATH entry can name a
 * directory the sandbox may write.
 */
const WATCHER_PATH = '/usr/bin:/bin:/run/current-system/sw/bin';

/**
 * Sums the sandbox's resident memory about once a second, in the shell's own
 * builtins, and past the limit ends bubblewrap by {@link MEMORY_LIMIT_SIGNAL},
 * which takes the sandbox down as the caller's kill does, and the namespace's
 * first process, in case bubblewrap is past hearing it. Nothing in the
 * namespace can leave it, so nothing can hide from the sum as a process can
 * leave a process group. Its streams are its own, since one it held open would
 * keep the caller waiting for the run's output.
 */
function memoryWatcher(limits: SandboxLimits): string {
  const memory = Math.ceil(limits.memoryBytes / 1024);
  return `{ PATH=${WATCHER_PATH}
  field() { f=; while read -r k w _; do if [ "$k" = "$1" ]; then f=$w; return; fi; done < "$2/status"; }
  root=
  while [ -d /proc/$$ ]; do
    sleep 1
    if [ ! -d "$root" ]; then
      root=
      for p in /proc/[0-9]*; do
        [ "$p/ns/pid" -ef /proc/$$/ns/pid ] && continue
        field PPid: "$p"
        if [ "$f" = "$$" ]; then root=$p; break; fi
      done
      [ -n "$root" ] || continue
    fi
    kb=0
    for p in /proc/[0-9]*; do
      [ "$p/ns/pid" -ef "$root/ns/pid" ] || continue
      field VmRSS: "$p"
      kb=$((kb + \${f:-0}))
    done
    if [ $kb -gt ${memory} ]; then kill -${MEMORY_LIMIT_SIGNAL.slice(3)} $$; kill -KILL \${root##*/}; break; fi
  done
} </dev/null >/dev/null 2>&1 &`;
}

/**
 * Runs before bubblewrap, outside it, then becomes it, so the caller's kill
 * at the wall-time limit and `--die-with-parent` reach the sandbox's PID
 * namespace, and every process in it, unchanged (ADR-0036 S1). The memory
 * watcher starts first, with none of the limits on it, and without a way to
 * wait or to compare namespaces the limit cannot be held, so nothing runs.
 * Older kernels count the process limit against all of the user's processes
 * and newer ones against the sandbox's own, so it is set above every process
 * the host runs now: never already spent, and still a bound. Dash names that
 * limit `-p` where bash names it `-u`. Only numbers from {@link SandboxLimits}
 * enter the text, and the command reaches it as the last of its arguments.
 */
function limitsPrelude(limits: SandboxLimits): string {
  const processes = `$(($(set -- /proc/[0-9]*; echo $#) + ${limits.processes}))`;
  const refused = `{ echo 'The sealed run could not be held to its limits, so it did not run.' >&2; exit 125; }`;
  return `(PATH=${WATCHER_PATH}; command -v sleep >/dev/null && [ / -ef / ]) 2>/dev/null \\
  || ${refused}
${memoryWatcher(limits)}
{ ulimit -u ${processes} 2>/dev/null || ulimit -p ${processes}; } && ulimit -v ${Math.ceil(limits.addressSpaceBytes / 1024)} \\
  || ${refused}
exec "$@"`;
}

/**
 * Linux's bubblewrap (ADR-0011 B4). Every path is its own argv entry, so none
 * is ever parsed as an option or a list.
 *
 * Three flags beyond the read-only root carry the guarantee:
 * - `--unshare-pid`, without which an unprivileged `--proc` cannot mount at
 *   all, and which keeps the host's processes out of the fresh `/proc`: their
 *   `/proc/<pid>/root` links lead into a mount namespace where the
 *   filesystem is writable.
 * - `--new-session`, so the command has no controlling terminal to type into
 *   with TIOCSTI.
 * - `--unshare-ipc`, so the host's System V shared memory is out of reach.
 *
 * A throwaway directory is an overlay whose upper layer is a tmpfs
 * (`--overlay-src`, `--tmp-overlay`, bubblewrap 0.10 and later on a kernel
 * that lets a user namespace mount one); an older one fails the probe, and the
 * caller asks again with the directory read-only.
 */
export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap';
  private readonly exec: ProbeExec;
  private readonly isDirectory: (p: string) => boolean;

  constructor(private readonly bwrap: string, deps: { exec?: ProbeExec; isDirectory?: (p: string) => boolean } = {}) {
    this.exec = deps.exec ?? execProbe;
    this.isDirectory = deps.isDirectory ?? defaultIsDirectory;
  }

  probe(profile: SandboxProfile): Promise<SandboxProbe> {
    return probeByRunning(this, profile, this.exec);
  }

  wrap(invocation: SandboxInvocation, profile: SandboxProfile): SandboxLaunch {
    // A mount grants a directory whole; refusing one kind of file in it would take a seccomp filter.
    if (profile.linkless?.length) throw new SandboxUnsupportedError(this.name, 'a writable directory without links');
    if (profile.gitless?.length) throw new SandboxUnsupportedError(this.name, 'a writable directory where no .git may be created');
    // Sharing the host's network namespace shares its loopback; keeping one without the other needs a network of its own.
    if (profile.network && profile.localNetwork === false) throw new SandboxUnsupportedError(this.name, "the network without this machine's own services");
    assertProfilePaths(this.name, profile);
    if (profile.limits) assertLimits(this.name, profile.limits);

    const args = ['--new-session', '--die-with-parent', '--unshare-pid', '--unshare-ipc'];
    if (!profile.network) args.push('--unshare-net');
    if (profile.read === 'host') args.push('--ro-bind', '/', '/');
    args.push('--dev', '/dev', '--proc', '/proc');
    // Before the read list and the writable directories, which may live under /tmp.
    if (profile.privateTmp) args.push('--tmpfs', '/tmp');
    const throwaway = new Set(profile.throwaway);
    const readOnly = profile.read === 'host' ? [] : profile.read.filter((p) => !throwaway.has(p));
    for (const p of shallowFirst([...readOnly, ...throwaway])) args.push(...(throwaway.has(p) ? ['--overlay-src', p, '--tmp-overlay', p] : ['--ro-bind', p, p]));
    // An empty directory over a directory, /dev/null over anything else: a socket that is a file can only be covered by another file.
    for (const p of shallowFirst(profile.masked ?? [])) args.push(...(this.isDirectory(p) ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
    for (const p of shallowFirst(profile.write)) args.push('--bind', p, p);
    // After the writable binds that cover them: a worktree's `.git` file and
    // every `.git` entry the checkout brought stay the repository's, so git
    // outside the sandbox cannot be made to load one the command rewrote.
    // Refusing a new `.git` would take a seccomp filter (ADR-0046).
    const readOnlyGit = new Set([
      ...(profile.gitWorktrees ?? []).map((worktree) => path.posix.join(worktree, '.git')),
      ...(profile.gitEntries ?? []).map((entry) => entry.path),
    ]);
    for (const gitPath of readOnlyGit) args.push('--ro-bind', gitPath, gitPath);
    args.push('--', invocation.shell, ...invocation.shellArgs);

    const env = launchEnv(invocation, profile);
    if (!profile.limits) return { file: this.bwrap, args, env };
    return { file: '/bin/sh', args: ['-c', limitsPrelude(profile.limits), 'ordewell-sealed', this.bwrap, ...args], env, wallTimeMs: profile.limits.wallTimeMs, memoryBytes: profile.limits.memoryBytes };
  }
}
