import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { withFileLock } from '../utils/fileLock';
import { ensureStateDirIgnored } from '../utils/fsHelpers';
import { ensurePrivateDir, writePrivateFile } from '../utils/privateFile';
import { groupAlive, onRunnerGroupStarted, processAlive, runnerGroups } from '../utils/processTree';
import { sessionDataDir } from '../utils/sessionStore';

/**
 * One live host per session (ADR-0049). A host — the process that runs
 * Sessions: a daemon, the VS Code extension host — holds a session's lease
 * while it has that session open, in `lease.json` beside the session's other
 * state. Another host opening the same session is refused while the holder
 * lives, and takes the lease over once it is gone.
 */

/** How often a holder refreshes the leases it holds. */
export const LEASE_HEARTBEAT_MS = 10_000;
/**
 * A lease not refreshed for this long is stale: its holder is gone, or its pid
 * now names another process. Several heartbeats, so a host whose event loop is
 * busy for a moment keeps its session.
 */
export const LEASE_STALE_MS = 60_000;

const LEASE_FILE = 'lease.json';

/** What kind of process a host is, for the words a refusal names it in. `ownerPid` is the TUI a private daemon serves. */
export type LeaseHostKind =
  | { kind: 'daemon'; port: number; ownerPid?: number }
  | { kind: 'vscode' };

/** A session's lease as its file records it. */
export interface SessionLeaseRecord {
  /** Minted once per host, so a restarted process at a reused pid is not mistaken for the holder. */
  hostId: string;
  pid: number;
  host?: LeaseHostKind;
  /** When this host took the lease. */
  since: string;
  /** Refreshed every {@link LEASE_HEARTBEAT_MS}; stale past {@link LEASE_STALE_MS}. */
  heartbeatAt: string;
  /**
   * The process groups of the runners the holder had started and not seen
   * end. A host killed outright cannot stop them, and they go on writing in
   * the session's worktrees, so a takeover waits for them.
   */
  runnerGroups: number[];
}

/** Who holds a session: a live host, or one that is gone while runners it started still run. */
export interface SessionHeld {
  holder: SessionLeaseRecord;
  /** Set when the holder is gone: the process groups of its runners that are still alive. */
  orphanedRunners?: number[];
}

/** A host named in the user's words: what it is, and the pid to look for. */
export function describeHolder(record: SessionLeaseRecord): string {
  const host = record.host;
  if (host?.kind === 'daemon') {
    return host.ownerPid !== undefined
      ? `a TUI (pid ${host.ownerPid}), through its daemon on port ${host.port} (pid ${record.pid})`
      : `the Ordewell daemon on port ${host.port} (pid ${record.pid})`;
  }
  if (host?.kind === 'vscode') return `a VS Code window (extension host pid ${record.pid})`;
  return `an Ordewell process (pid ${record.pid})`;
}

function localTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** Why a session cannot be opened here, as every surface says it. */
export function describeHeld(held: SessionHeld): string {
  const holder = describeHolder(held.holder);
  const groups = held.orphanedRunners ?? [];
  if (groups.length > 0) {
    return `The Ordewell host that last ran this session, ${holder}, is gone, but runners it started are still running `
      + `(process group${groups.length === 1 ? '' : 's'} ${groups.join(', ')}). `
      + `Stop them first, for example with \`kill -TERM -- ${groups.map((g) => `-${g}`).join(' ')}\`, then open the session again.`;
  }
  return `This session is open in another Ordewell host: ${holder} has held it since ${localTime(held.holder.since)}. `
    + 'Close it there, or stop that process, then open it here.';
}

/** What a host that lost its session to another is told. */
export function describeLost(held: SessionHeld): string {
  return `Another Ordewell host took this session over: ${describeHolder(held.holder)}, at ${localTime(held.holder.since)}. `
    + 'Its run here is stopped and nothing more of it is saved from here; carry on in that host.';
}

/**
 * Another live host holds the session's lease, or the host that held it is
 * gone and runners it started still run. The message is the plain words;
 * `held` carries the same as data, for a client to word itself.
 */
export class SessionHeldError extends Error {
  constructor(readonly held: SessionHeld) {
    super(describeHeld(held));
    this.name = 'SessionHeldError';
  }
}

/** A Session's hold on the lease of the session it has open. */
export interface SessionLease {
  /**
   * Hold `sessionId`'s lease in `workspace`, letting go of the one held before
   * only once this one is held. Throws {@link SessionHeldError}. `commit` runs
   * holding both: when it throws, the one held before is still held, and a
   * lease this claim took is let go.
   */
  claim(sessionId: string, workspace: string, commit?: () => void): void;
  /**
   * Null while this Session holds `sessionId`'s lease, claiming it when no
   * live host holds it; otherwise who holds it. A lease another host took from
   * this one is never claimed back here: what this Session holds of it is
   * older than what that host saved. Never throws a refusal.
   */
  hold(sessionId: string, workspace: string): SessionHeld | null;
  release(): void;
}

/** For a Session whose saves go nowhere on disk (a test's): there is no shared state to own. */
export const UNLEASED: SessionLease = {
  claim(_sessionId, _workspace, commit) { commit?.(); },
  hold: () => null,
  release() {},
};

export interface LeaseHostOptions {
  /** Minted when absent; two hosts in one test process are given two. */
  id?: string;
  pid?: number;
  kind?: () => LeaseHostKind | undefined;
  /** Liveness probes, injected so a test can kill a holder without a process. */
  alive?: (pid: number) => boolean;
  groupAlive?: (pgid: number) => boolean;
  /** The runner groups recorded with each refresh; this process's own by default. */
  runnerGroups?: () => number[];
  now?: () => number;
}

/**
 * The lease hosts alive in this process. A record at this process's own pid
 * is live only when it names one of them; any other is a host that died here.
 */
const hostsHere = new Set<string>();

interface HeldLease {
  record: SessionLeaseRecord;
  workspace: string;
  holders: Set<HostedLease>;
}

function leaseFile(sessionId: string, workspace: string): string {
  return path.join(sessionDataDir(sessionId, workspace), LEASE_FILE);
}

function isRecord(value: unknown): value is SessionLeaseRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.hostId === 'string' && typeof r.pid === 'number' && typeof r.since === 'string'
    && typeof r.heartbeatAt === 'string' && Array.isArray(r.runnerGroups) && r.runnerGroups.every((g) => typeof g === 'number');
}

/** The record on disk; null when there is none, or none any host could have written (every write is a rename). */
function readRecord(file: string): SessionLeaseRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(file: string, record: SessionLeaseRecord): void {
  writePrivateFile(file, JSON.stringify(record, null, 2));
}

/**
 * One host's leases. Every change to a lease file — taking it, its heartbeat,
 * letting it go — is made holding that file's lock, so a takeover and the
 * old holder's heartbeat cannot both write.
 */
export class LeaseHost {
  readonly id: string;
  private readonly pid: number;
  private kindOf: () => LeaseHostKind | undefined;
  private readonly alive: (pid: number) => boolean;
  private readonly groupAlive: (pgid: number) => boolean;
  private readonly runnerGroups: () => number[];
  private readonly now: () => number;
  private readonly held = new Map<string, HeldLease>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(options: LeaseHostOptions = {}) {
    this.id = options.id ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.kindOf = options.kind ?? (() => undefined);
    this.alive = options.alive ?? processAlive;
    this.groupAlive = options.groupAlive ?? groupAlive;
    this.runnerGroups = options.runnerGroups ?? runnerGroups;
    this.now = options.now ?? Date.now;
    hostsHere.add(this.id);
  }

  /** Say what kind of host this is, for the refusals another host words. */
  describe(kind: LeaseHostKind): void {
    this.kindOf = () => kind;
  }

  /** A Session's handle. `onLost` hears, once, that another host took a lease this one held. */
  lease(onLost: (held: SessionHeld) => void): SessionLease {
    return new HostedLease(this, onLost);
  }

  /**
   * Refresh every lease this host holds, with the runner groups it has now; a
   * lease another host has taken is lost. Run by a timer, and as each runner
   * starts. A file that cannot be refreshed now is tried again at the next.
   */
  beat(): void {
    for (const [file, entry] of [...this.held]) {
      let taker: SessionLeaseRecord | null = null;
      try {
        taker = withFileLock(file, () => {
          const current = readRecord(file);
          if (current && current.hostId !== this.id) return current;
          entry.record = this.refreshed(entry.record);
          writeRecord(file, entry.record);
          return null;
        }, 'refresh a session lease');
      } catch {
        continue;
      }
      if (taker) this.lose(file, entry, { holder: taker });
    }
  }

  /** Let every lease go: the host is shutting down. */
  releaseAll(): void {
    for (const entry of [...this.held.values()]) {
      for (const holder of [...entry.holders]) holder.release();
    }
    this.stopHeartbeat();
  }

  /**
   * @internal Take `file`'s lease for `holder`, or throw who holds it. A
   * record another host wrote over this one's means the Sessions holding it
   * here have lost it, whatever `holder` is granted.
   */
  acquire(file: string, workspace: string, holder: HostedLease): void {
    ensureStateDirIgnored(workspace);
    ensurePrivateDir(path.dirname(file));
    const outcome = withFileLock(file, (): { taken: SessionLeaseRecord | null } & ({ refusal: SessionHeld } | { record: SessionLeaseRecord }) => {
      const current = readRecord(file);
      const taken = current !== null && current.hostId !== this.id ? current : null;
      const refusal = taken ? this.judge(taken) : null;
      if (refusal) return { taken, refusal };
      const record = current && !taken ? this.refreshed(current) : this.fresh();
      writeRecord(file, record);
      return { taken, record };
    }, 'take a session lease');
    const entry = this.held.get(file);
    if (entry && outcome.taken) this.lose(file, entry, { holder: outcome.taken });
    if ('refusal' in outcome) throw new SessionHeldError(outcome.refusal);
    const { record } = outcome;
    const kept = this.held.get(file);
    if (kept) {
      kept.record = record;
      kept.holders.add(holder);
    } else {
      this.held.set(file, { record, workspace, holders: new Set([holder]) });
    }
    this.startHeartbeat();
  }

  /**
   * @internal Whether `holder` still holds `file`'s lease, read off the disk:
   * null when it does, who took it when another host did. A lease file gone
   * from under its holder (its session's directory removed) is written again.
   */
  check(file: string, holder: HostedLease): SessionHeld | null {
    const entry = this.held.get(file);
    const current = readRecord(file);
    if (current && current.hostId !== this.id) {
      const held = { holder: current };
      if (entry) this.lose(file, entry, held);
      return held;
    }
    if (current && entry?.holders.has(holder)) return null;
    try {
      this.acquire(file, entry?.workspace ?? holder.workspace, holder);
      return null;
    } catch (err) {
      if (err instanceof SessionHeldError) return err.held;
      throw err;
    }
  }

  /** @internal `holder` lets go of `file`; the file goes with the last holder in this host. */
  release(file: string, holder: HostedLease): void {
    const entry = this.held.get(file);
    if (!entry?.holders.delete(holder) || entry.holders.size > 0) return;
    this.held.delete(file);
    if (this.held.size === 0) this.stopHeartbeat();
    try {
      withFileLock(file, () => {
        if (readRecord(file)?.hostId === this.id) fs.rmSync(file, { force: true });
      }, 'release a session lease');
      // A session that was never saved leaves no directory behind for its lease.
      fs.rmdirSync(path.dirname(file));
    } catch {
      // Not empty, or already removed with its session. A lease that cannot be
      // removed is judged by its pid and heartbeat, which end with this host.
    }
  }

  /** Null for a holder another host may take over from; otherwise why it may not. */
  private judge(record: SessionLeaseRecord): SessionHeld | null {
    if (this.lives(record)) return { holder: record };
    const orphanedRunners = record.runnerGroups.filter((pgid) => this.groupAlive(pgid));
    return orphanedRunners.length > 0 ? { holder: record, orphanedRunners } : null;
  }

  private lives(record: SessionLeaseRecord): boolean {
    const beat = Date.parse(record.heartbeatAt);
    if (Number.isNaN(beat) || this.now() - beat > LEASE_STALE_MS) return false;
    // Another host at this very pid is one that lived here before and died,
    // its pid handed on to this process — unless it is a second host of this
    // process, as a test makes.
    if (record.pid === process.pid) return hostsHere.has(record.hostId);
    return this.alive(record.pid);
  }

  private lose(file: string, entry: HeldLease, held: SessionHeld): void {
    if (this.held.get(file) === entry) this.held.delete(file);
    if (this.held.size === 0) this.stopHeartbeat();
    for (const holder of entry.holders) holder.lost(file, held);
  }

  private fresh(): SessionLeaseRecord {
    const now = new Date(this.now()).toISOString();
    const kind = this.kindOf();
    return { hostId: this.id, pid: this.pid, ...(kind ? { host: kind } : {}), since: now, heartbeatAt: now, runnerGroups: this.runnerGroups() };
  }

  private refreshed(record: SessionLeaseRecord): SessionLeaseRecord {
    const kind = this.kindOf();
    return { ...record, ...(kind ? { host: kind } : {}), heartbeatAt: new Date(this.now()).toISOString(), runnerGroups: this.runnerGroups() };
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.beat(), LEASE_HEARTBEAT_MS);
    // A lease is never the reason a host stays up.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

class HostedLease implements SessionLease {
  private file: string | null = null;
  /** The workspace of the lease being claimed or held, for a lease file that has to be written again. */
  workspace = '';
  private lostLease: { file: string; held: SessionHeld } | null = null;

  constructor(private readonly host: LeaseHost, private readonly onLost: (held: SessionHeld) => void) {}

  claim(sessionId: string, workspace: string, commit?: () => void): void {
    const file = leaseFile(sessionId, workspace);
    if (this.file === file) {
      const held = this.host.check(file, this);
      if (held) throw new SessionHeldError(held);
      commit?.();
      return;
    }
    this.host.acquire(file, workspace, this);
    try {
      commit?.();
    } catch (err) {
      this.host.release(file, this);
      throw err;
    }
    const previous = this.file;
    this.file = file;
    this.workspace = workspace;
    this.lostLease = null;
    if (previous) this.host.release(previous, this);
  }

  hold(sessionId: string, workspace: string): SessionHeld | null {
    const file = leaseFile(sessionId, workspace);
    if (this.lostLease?.file === file) return this.lostLease.held;
    if (this.file === file) return this.host.check(file, this);
    try {
      this.claim(sessionId, workspace);
      return null;
    } catch (err) {
      if (err instanceof SessionHeldError) return err.held;
      throw err;
    }
  }

  release(): void {
    if (this.file) this.host.release(this.file, this);
    this.file = null;
    this.lostLease = null;
  }

  /** @internal Another host took `file`'s lease from this one. */
  lost(file: string, held: SessionHeld): void {
    if (this.file !== file) return;
    this.file = null;
    this.lostLease = { file, held };
    try {
      this.onLost(held);
    } catch {
      // Heard from a heartbeat timer or a save: a Session failing to stop its
      // run must not end the host, and it is refused every save and every
      // change to its run regardless.
    }
  }
}

let processHost: LeaseHost | null = null;

/**
 * This process's host: the one every Session that saves to the session store
 * holds its lease through. Its leases go when the process exits; a process
 * killed outright leaves them to be judged by its pid and heartbeat.
 */
export function processLeaseHost(): LeaseHost {
  if (processHost) return processHost;
  const host = new LeaseHost();
  process.once('exit', () => host.releaseAll());
  // Recorded as each runner starts, not only at the next beat: a host killed
  // within a beat of a spawn would otherwise leave that runner unnamed.
  // Deferred out of the spawn: a lease found lost there stops the very run
  // that is spawning.
  onRunnerGroupStarted(() => { setImmediate(() => host.beat()); });
  processHost = host;
  return host;
}
