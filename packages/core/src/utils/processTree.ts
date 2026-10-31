import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';

/**
 * Stopping an agent process, on every platform.
 *
 * POSIX gets SIGTERM, then SIGKILL after a grace period — sent to the runner's
 * whole process group when it was started by {@link spawnInOwnGroup}, because
 * the direct child is a CLI and what kept running after Stop was everything it
 * had started: shells, MCP servers, test runs, dev servers. Windows has no signals — `ChildProcess.kill` calls TerminateProcess
 * on the direct child only — and on Windows the direct child is frequently not
 * the agent. A `claude.cmd` shim launched through cmd.exe puts an interpreter
 * between Ordewell and the `node cli.js` doing the work, so terminating the child
 * left the real agent running: still holding the workspace, still spending the
 * user's subscription, invisible to the surface that thought it had stopped.
 * `taskkill /T` walks the tree instead.
 *
 * Both paths are best-effort and idempotent by construction. A process that has
 * already exited is not an error here — every caller is on a dispose path.
 */

/** Grace period between the polite stop and the forced one. */
const HARD_KILL_DELAY_MS = 5000;

function isNoSuchProcess(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ESRCH';
}

/**
 * Whether `proc` has reported its own end. A process killed by a signal
 * reports `exitCode` null and `signalCode` set, and is as gone as one that
 * exited with a code. Only a reported value counts: an object that reports
 * neither is treated as running — the cost of a redundant kill is nothing,
 * the cost of skipping a live one is an orphaned agent.
 */
function hasExited(proc: ChildProcess): boolean {
  return typeof proc.exitCode === 'number' || typeof proc.signalCode === 'string';
}

export interface KillTreeDeps {
  platform?: NodeJS.Platform;
  /** Runs `taskkill`. Injected so the Windows path is testable off Windows. */
  execFileImpl?: (file: string, args: string[], cb: (err: Error | null) => void) => void;
  /** Schedules the forced kill. Injected so tests need no timers. */
  setTimeoutImpl?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Signals a pid, or a process group as its negated id. Injected so the group path needs no real processes. */
  killImpl?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/** Processes {@link spawnInOwnGroup} made group leaders. */
const groupLeaders = new WeakSet<ChildProcess>();
/** Leaders already signalled: a group signal leaves `proc.killed` false, so it cannot say. */
const stopping = new WeakSet<ChildProcess>();
/**
 * Groups led by a runner, by id, for the host's teardown. Kept while the group
 * still has members, which a leader's exit does not end: a runner that crashes
 * leaves its shells and dev servers behind, and those are what teardown has to
 * reach. Dropped when the group is empty (its id is recyclable then, and no
 * longer ours to vouch for) or when {@link killTree} takes it over.
 */
const ownGroups = new Map<number, ChildProcess>();
let hostTeardownHooked = false;
/** Told of each runner group as it starts, so a session lease records it at once (ADR-0049). */
const groupStartListeners = new Set<() => void>();
/** What else goes with the host: see {@link onHostTeardown}. */
const teardownListeners = new Set<() => void>();

/**
 * Start a runner as the leader of a new process group, so {@link killTree}
 * reaches everything it starts. `spawn` is handed the `detached` flag to pass
 * to Node, which on POSIX is what makes a child a group (and session) leader.
 * Stdio pipes and the host's event loop are unaffected; only `unref` changes
 * the latter, and nothing here calls it.
 *
 * Not on Windows: there `detached` gives the child a console of its own, and
 * `taskkill /T` already walks the tree.
 */
export function spawnInOwnGroup(spawn: (detached: boolean) => ChildProcess, platform: NodeJS.Platform = process.platform): ChildProcess {
  if (platform === 'win32') return spawn(false);
  const proc = spawn(true);
  const pgid = proc.pid;
  // No pid: the spawn failed, and its 'error' event reports that.
  if (typeof pgid !== 'number') return proc;
  groupLeaders.add(proc);
  ownGroups.set(pgid, proc);
  // The leader's exit does not end the group: the shells, MCP servers and dev
  // servers it started outlive it, and those are exactly what Stop and host
  // teardown still have to reach. The entry is dropped only once the group is
  // empty — an id with no members left can be recycled, and is no longer ours
  // to signal.
  proc.once('exit', () => { if (!groupHasMembers(pgid)) forgetGroup(proc, pgid); });
  hookHostTeardown();
  for (const listener of groupStartListeners) listener();
  return proc;
}

/**
 * The process groups this host's runners lead that still have members. A
 * session lease records them (ADR-0049): the teardown below cannot run for a
 * host killed outright, and what it would have stopped runs on in the
 * session's worktrees.
 */
export function runnerGroups(): number[] {
  return [...ownGroups.keys()].filter((pgid) => groupHasMembers(pgid));
}

/** Hear of each runner group {@link spawnInOwnGroup} starts; the returned function stops it. */
export function onRunnerGroupStarted(listener: () => void): () => void {
  groupStartListeners.add(listener);
  return () => { groupStartListeners.delete(listener); };
}

/**
 * Stop something else as the host goes, with its runner groups but not among
 * them: {@link runnerGroups} never names it, so no lease is held by it. Here
 * rather than in a hook of the caller's, because two signal hooks would each
 * read the other as the host's own handler, and neither would end the host.
 * The returned function stops it being called. Nothing runs for a host killed
 * outright, as for the groups.
 */
export function onHostTeardown(stop: () => void): () => void {
  teardownListeners.add(stop);
  hookHostTeardown();
  return () => { teardownListeners.delete(stop); };
}

/** Whether a process answers to `pid`: one owned by another user, which refuses the signal, is alive too. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether any process is left in the group `pgid` leads. */
export function groupAlive(pgid: number): boolean {
  return groupHasMembers(pgid);
}

/** Whether any process still answers to `pgid`, as `kill(2)` sees it. */
function groupHasMembers(pgid: number, killImpl: (pid: number, signal: 0) => void = (pid, signal) => { process.kill(pid, signal); }): boolean {
  try {
    killImpl(-pgid, 0);
    return true;
  } catch (err) {
    return !isNoSuchProcess(err);
  }
}

/**
 * An empty group's id is recyclable, so it is no longer ours to signal: from
 * here on `proc` is an ordinary exited process to {@link killTree}.
 */
function forgetGroup(proc: ChildProcess, pgid: number): void {
  if (ownGroups.get(pgid) === proc) ownGroups.delete(pgid);
  groupLeaders.delete(proc);
}

/**
 * A detached runner has left the terminal's foreground group, so Ctrl-C (or a
 * closed terminal) no longer reaches it — the host has to pass that on to the
 * groups it leads. Polite only, and not again to a group already asked: a
 * host disposing its sessions on the way out has just sent SIGTERM, and a
 * second one reads to some CLIs as "quit without cleaning up".
 */
function hookHostTeardown(): void {
  if (hostTeardownHooked) return;
  hostTeardownHooked = true;
  const stopAll = () => {
    for (const [pgid, leader] of ownGroups) {
      if (stopping.has(leader)) continue;
      if (hasExited(leader) && !groupHasMembers(pgid)) continue;
      try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
    }
    ownGroups.clear();
    for (const stop of teardownListeners) {
      try { stop(); } catch { /* already gone */ }
    }
    teardownListeners.clear();
  };
  process.on('exit', stopAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      stopAll();
      // A host with a handler of its own decides how to exit. One without was
      // relying on the default, which listening has replaced, so this listener
      // steps aside and the signal is raised again to end the host as before.
      if (process.listenerCount(signal) > 1) return;
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

function defaultExecFile(file: string, args: string[], cb: (err: Error | null) => void): void {
  execFile(file, args, (err) => cb(err ?? null));
}

/**
 * Terminate `proc` and everything it started.
 *
 * Returns immediately; the forced follow-up (SIGKILL, or `taskkill /F`) is
 * scheduled and unref'd, so a disposed session is never the reason the host
 * process refuses to exit.
 */
export function killTree(proc: ChildProcess | null, deps: KillTreeDeps = {}): void {
  if (!proc) return;

  const platform = deps.platform ?? process.platform;
  // A group leader is the exception: its group outlives it, so a crashed
  // runner's shells, dev servers and MCP servers are still there to stop even
  // though the runner is not. That case falls through to the group path below.
  if (!groupLeaders.has(proc) && (proc.killed || hasExited(proc))) return;

  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms) as unknown as { unref?: () => void });
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  if (platform === 'win32') {
    // No pid means the process never started; there is no tree to walk.
    if (typeof proc.pid !== 'number') return;
    const pid = proc.pid;
    const run = deps.execFileImpl ?? defaultExecFile;

    // `/T` is the whole point: without it this is the TerminateProcess call
    // that already failed to reach the agent. The unforced pass first gives a
    // console app a chance to flush; `/F` follows if it did not take.
    run('taskkill', ['/pid', String(pid), '/T'], () => { /* exit code is not news */ });
    const hardKill = setTimeoutImpl(() => {
      run('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* already gone */ });
    }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    proc.once('exit', () => clearTimeoutImpl(hardKill));
    return;
  }

  if (groupLeaders.has(proc) && typeof proc.pid === 'number') {
    if (stopping.has(proc)) return;
    const pgid = proc.pid;
    const killImpl = deps.killImpl ?? ((pid: number, signal: NodeJS.Signals | 0) => { process.kill(pid, signal); });
    // Never signal a group we can't vouch for. While the leader lives its pid
    // holds the id; once it is gone, only a member still in the group does,
    // and an empty group's id may already be a stranger's. So once the leader
    // has exited, every signal is preceded by asking.
    const vouched = () => !hasExited(proc) || groupHasMembers(pgid, killImpl);
    if (!vouched()) {
      forgetGroup(proc, pgid);
      return;
    }
    stopping.add(proc);
    // Taken over here, so the host's teardown and this path do not both signal
    // it (from here on `stopping`, not `ownGroups`, is what says so).
    ownGroups.delete(pgid);
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        killImpl(-pgid, signal);
      } catch {
        try { proc.kill(signal); } catch { /* already gone */ }
      }
    };
    signalGroup('SIGTERM');
    // Survives the leader's exit: what it started can outlive it, and a
    // process ignoring SIGTERM is exactly the one that does. Asked again when
    // it fires, so a group that emptied during the grace period is left alone;
    // a stranger taking the id between that probe and the signal is the
    // residual risk.
    const hardKill = setTimeoutImpl(() => { if (vouched()) signalGroup('SIGKILL'); }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    if (!hasExited(proc)) {
      proc.once('exit', () => { if (!groupHasMembers(pgid, killImpl)) clearTimeoutImpl(hardKill); });
    }
    return;
  }

  try {
    proc.kill('SIGTERM');
    const hardKill = setTimeoutImpl(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, HARD_KILL_DELAY_MS);
    hardKill.unref?.();
    proc.once('exit', () => clearTimeoutImpl(hardKill));
  } catch {
    // Process already gone — nothing to clean up.
  }
}
