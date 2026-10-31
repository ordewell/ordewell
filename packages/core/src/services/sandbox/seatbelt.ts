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

/** Absolute, so a `sandbox-exec` earlier on PATH can never stand in for the real one. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * Closed by default, not "allow default, deny writes". With everything else
 * allowed, a command that cannot write a file can still ask a system service
 * to write one: `defaults write` goes through cfprefsd and changes the user's
 * preferences, `open` and Apple events reach LaunchServices and other apps,
 * and each of those writes as the user, outside any profile. Denying by
 * default leaves only the services named here, which read on the command's
 * behalf. Modelled on Chromium's and Codex's Seatbelt policies.
 *
 * What may be read comes after, from the profile. `ps` and `top` cannot
 * start either way, because the kernel will not run a setuid program in a
 * sandbox.
 */
const BASE_PROFILE = `(version 1)
(deny default)
; A command inherits the task's bootstrap port, which reaches launchd, and
; launchd runs a job it loads outside this sandbox, as the user. The default
; deny does not cover loading one, so this does: launchctl submit, bootstrap
; and the other job-creation routes fail, and a misclassified or sealed
; command cannot turn the bootstrap port into code that runs unsandboxed.
; Reading launchd's existing jobs over that port is gated by no Seatbelt
; operation and remains a residual (ADR-0011, ADR-0036).
(deny job-creation)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))
(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.sysmond")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership"))
(allow network-outbound (literal "/private/var/run/syslog"))
; No ioctl on /dev/tty: TIOCSTI there would type into the user's terminal.
(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (subpath "/dev/fd"))
(allow file-write-data file-ioctl (literal "/dev/dtracehelper"))
; macOS's /bin/sh is bash 3.2, which writes a here-document to /tmp whatever
; TMPDIR says, after checking that /tmp itself is writable. Only its own
; file names are allowed there.
(allow file-write* (literal "/private/tmp") (regex #"^/private/tmp/sh-thd-[0-9]+$"))`;

/**
 * Reads open (ADR-0011 B2): every file, other processes, and the user's
 * preferences, which cfprefsd reads for the caller.
 */
const HOST_READS = `(allow process-info*)
(allow file-read* file-test-existence file-map-executable)
(allow user-preference-read)
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow mach-lookup
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (local-name "com.apple.cfprefsd.agent"))`;

/**
 * Reads confined to the profile's list (ADR-0036 S1), the paths added after
 * this. A program also lists the root and resolves its links (`/etc`, `/tmp`,
 * `/var`), and `realpath` stats every directory above a listed one: those
 * reveal names, never contents. The user's preferences, which cfprefsd would
 * read from their home for the command, stay out of reach, and so does what
 * `proc_info` tells about the user's other processes. Their command lines do
 * not: `sysctl` hands those out (`kern.procargs2`) under no rule a profile
 * can deny, though never their environments.
 */
const LISTED_READS = `(allow process-info* (target same-sandbox))
(allow file-read* (literal "/"))
(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") (literal "/private/tmp"))
(allow file-read* (regex #"^/private/tmp/sh-thd-[0-9]+$"))`;

/** The host's temporary directories hidden, but for the shell's own here-documents (see BASE_PROFILE). */
const PRIVATE_TMP = `(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))
(allow file-read-metadata (literal "/private/tmp"))
(allow file-read* file-write* (regex #"^/private/tmp/sh-thd-[0-9]+$"))
(allow file-write* (literal "/private/tmp"))`;

/**
 * What an approved command's network needs beyond the sockets themselves:
 * name resolution and TLS trust.
 */
const NETWORK_PROFILE = `(allow network-outbound network-inbound network-bind system-socket)
(allow mach-lookup
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.TrustEvaluationAgent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))`;

/**
 * The network without this machine's own services. Name resolution and
 * logging still need their two sockets.
 */
const NO_LOCAL_NETWORK = `(deny network-outbound (remote ip "localhost:*") (remote unix-socket))
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (literal "/private/var/run/syslog"))`;

/**
 * The keychain, where `gh` and git's credential helper keep the user's tokens.
 * An approved command gets it; a native shell does not, since N2.2 requires
 * that it cannot act on the user's accounts (ADR-0036).
 */
const KEYCHAIN_PROFILE = `(allow mach-lookup
  (global-name "com.apple.SecurityServer"))`;

/**
 * Runs before the sandbox, outside it, under macOS's /bin/bash. It starts the
 * sandbox in a process group of its own, under the limits, and kills that
 * group when the command ends, when the caller kills this script at the
 * wall-time limit, or when the caller dies, which closes the pipe on its
 * standard input (ADR-0036 S1). Seatbelt has no PID namespace to take the
 * command's processes down with it; the group does, except for one that
 * leaves it with `setsid`, which keeps the profile. The group is killed until
 * it is empty, since the kernel skips a process still being forked, and a
 * fork bomb always has one. Each round stops the group before it kills it,
 * with no pause between rounds: the few that slip through a kill would
 * otherwise fill the group back to its process limit while the reaper waited,
 * and outlast it.
 *
 * About once a second a watcher sums the group's resident memory, and past the
 * limit it ends this script by {@link MEMORY_LIMIT_SIGNAL}, as the caller's
 * clock would, then the group: the caller reads the signal, and the group goes
 * the same way whichever comes first. The kernel's limits are set on the
 * command alone, so a fork bomb at its process limit leaves the watcher able
 * to start `ps`.
 *
 * macOS counts processes per user and maps hundreds of gigabytes into every
 * program as it starts, so both kernel limits are added to what is measured
 * here. Only numbers from {@link SandboxLimits} enter the text, and the
 * command reaches it as the last of its arguments.
 */
function limitsPrelude(limits: SandboxLimits): string {
  const memory = Math.ceil(limits.memoryBytes / 1024);
  const addressSpace = Math.ceil(limits.addressSpaceBytes / 1024);
  return `n=$(/bin/ps -U "$UID" -o pid= | /usr/bin/wc -l) && v=$(/bin/ps -o vsz= -p $$) \\
  || { echo 'The sealed run could not be held to its limits, so it did not run.' >&2; exit 125; }
reap() { i=0; while [ $i -lt 2000 ] && kill -STOP -$pid 2>/dev/null; do kill -KILL -$pid 2>/dev/null; i=$((i + 1)); done; }
watch=0
if [ -p /dev/stdin ] || [ -S /dev/stdin ]; then watch=1; fi
exec 3<&0
set -m
( ulimit -u $((n + ${limits.processes})) && ulimit -v $((v + ${addressSpace})) \\
    || { echo 'The sealed run could not be held to its limits, so it did not run.' >&2; exit 125; }
  exec "$@" ) </dev/null 3<&- &
pid=$!
set +m
if [ $watch = 1 ]; then { /bin/cat >/dev/null; reap; } <&3 >/dev/null 2>&1 & watcher=$!; fi
while kill -0 $$ 2>/dev/null; do
  /bin/sleep 1
  kb=0
  for rss in $(/bin/ps -o rss= -g $pid); do kb=$((kb + rss)); done
  if [ $kb -gt ${memory} ]; then kill -${MEMORY_LIMIT_SIGNAL.slice(3)} $$; reap; break; fi
done </dev/null >/dev/null 2>&1 3<&- &
memory=$!
exec 3<&-
wait $pid
status=$?
# Reap the watchers with their own waits, so monitor mode does not print a
# stray "Killed" line to the command's output that reads as a crash.
kill -KILL $memory 2>/dev/null; wait $memory 2>/dev/null
if [ $watch = 1 ]; then kill -KILL $watcher 2>/dev/null; wait $watcher 2>/dev/null; fi
reap
exit $status`;
}

/**
 * macOS's Seatbelt, through `sandbox-exec -p <profile>` (ADR-0011 B4). The
 * profile text is fixed: every path goes in as a `-D NAME=value` parameter and
 * is referred to as `(param "NAME")`, so no path is ever parsed as profile
 * syntax.
 */
export class SeatbeltBackend implements SandboxBackend {
  readonly name = 'Seatbelt';

  constructor(private readonly exec: ProbeExec = execProbe) {}

  probe(profile: SandboxProfile): Promise<SandboxProbe> {
    return probeByRunning(this, profile, this.exec);
  }

  wrap(invocation: SandboxInvocation, profile: SandboxProfile): SandboxLaunch {
    // Seatbelt filters what a process may touch; it has no mount namespace to lay an overlay over a directory.
    if (profile.throwaway?.length) throw new SandboxUnsupportedError(this.name, 'a throwaway overlay');
    assertProfilePaths(this.name, profile);
    if (profile.limits) assertLimits(this.name, profile.limits);

    const params: string[] = [];
    const filters = (prefix: string, kind: 'subpath' | 'literal', paths: readonly string[]): string => paths.map((p, i) => {
      params.push('-D', `${prefix}_${i}=${p}`);
      return `(${kind} (param "${prefix}_${i}"))`;
    }).join(' ');

    const rules = [BASE_PROFILE];
    if (profile.read === 'host') {
      rules.push(HOST_READS);
      if (profile.privateTmp) rules.push(PRIVATE_TMP);
    } else {
      // A listed read leaves the host's /tmp out of sight already, so `privateTmp` needs nothing more.
      rules.push(LISTED_READS);
      if (profile.read.length) rules.push(`(allow file-read* file-test-existence file-map-executable ${filters('READ', 'subpath', profile.read)})`);
      const above = directoriesAbove([...profile.read, ...profile.write]);
      if (above.length) rules.push(`(allow file-read-metadata ${filters('ABOVE', 'literal', above)})`);
    }
    if (profile.network) rules.push(NETWORK_PROFILE);
    if (profile.network && profile.keychain !== false) rules.push(KEYCHAIN_PROFILE);
    if (profile.network && profile.localNetwork === false) rules.push(NO_LOCAL_NETWORK);
    // The last matching rule wins, so a writable directory inside a masked one stays writable, as under bubblewrap.
    if (profile.masked?.length) rules.push(`(deny file-read* file-write* ${filters('MASKED', 'subpath', profile.masked)})`);
    if (profile.write.length) rules.push(`(allow file-read* file-test-existence file-map-executable file-write* ${filters('WRITABLE', 'subpath', profile.write)})`);
    // A rename lands as a create too, so a link made elsewhere cannot be moved in, nor one already there moved to resolve elsewhere.
    if (profile.linkless?.length) rules.push(`(deny file-write-create (require-all (vnode-type SYMLINK) (require-any ${filters('LINKLESS', 'subpath', profile.linkless)})))`);
    // A worktree's `.git` stays the repository's: the file cannot be written,
    // replaced, renamed or removed, and no other `.git` may be created, so git
    // outside the sandbox never loads a planted one (ADR-0046).
    if (profile.gitWorktrees?.length) {
      const gitDirs = profile.gitWorktrees.map((worktree) => path.posix.join(worktree, '.git'));
      rules.push(`(deny file-write* ${filters('GIT', 'literal', gitDirs)})`);
      // The root itself stays where it is: a command that renamed it could
      // plant a `.git` outside the profile and move the directory back, under
      // the path the sweep trusts (ADR-0046). Its contents stay writable.
      rules.push(`(deny file-write* ${filters('WORKTREE', 'literal', profile.gitWorktrees)})`);
    }
    if (profile.gitEntries?.length) {
      // Every `.git` the checkout brought stays byte for byte what it was: a
      // file by its literal path, a directory with everything under it, so a
      // submodule's pointer or a vendored repository's config cannot be armed
      // for git outside the sandbox (ADR-0046).
      const files = profile.gitEntries.filter((entry) => !entry.directory).map((entry) => entry.path);
      const dirs = profile.gitEntries.filter((entry) => entry.directory).map((entry) => entry.path);
      if (files.length) rules.push(`(deny file-write* ${filters('GITFILE', 'literal', files)})`);
      if (dirs.length) rules.push(`(deny file-write* ${filters('GITDIR', 'subpath', dirs)})`);
    }
    if (profile.gitless?.length) rules.push(`(deny file-write-create (require-all (regex #"/\\.git$") (require-any ${filters('GITLESS', 'subpath', profile.gitless)})))`);

    const sandboxed = [SANDBOX_EXEC, '-p', rules.join('\n'), ...params, invocation.shell, ...invocation.shellArgs];
    const env = launchEnv(invocation, profile);
    if (!profile.limits) return { file: sandboxed[0], args: sandboxed.slice(1), env };
    return { file: '/bin/bash', args: ['-c', limitsPrelude(profile.limits), 'ordewell-sealed', ...sandboxed], env, wallTimeMs: profile.limits.wallTimeMs, memoryBytes: profile.limits.memoryBytes };
  }
}

/** Every directory above the given paths, which `realpath` and the shell's own lookups stat on the way down. */
function directoriesAbove(paths: readonly string[]): string[] {
  const above = new Set<string>();
  for (const p of paths) {
    for (let dir = path.posix.dirname(p); dir !== '/' && !above.has(dir); dir = path.posix.dirname(dir)) above.add(dir);
  }
  return [...above];
}
