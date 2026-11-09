import * as fs from 'fs';
import * as path from 'path';
import { processAlive } from './processTree';
import { getSessionsDir, idSegment } from './sessionDir';

/**
 * A session's lease file as any process reads it (ADR-0049): the record a
 * host writes, and the judgement of whether that host still lives. The hosts
 * themselves take and refresh it in `services/sessionLease`; this half is
 * apart so a client that is no host can read it through `daemon-client`.
 */

/**
 * A lease not refreshed for this long is stale: its holder is gone, or its pid
 * now names another process. Several heartbeats, so a host whose event loop is
 * busy for a moment keeps its session.
 */
export const LEASE_STALE_MS = 60_000;

/**
 * What kind of process a host is, for the words a refusal names it in and the
 * surface the planner is told its user has. `ownerPid` is the TUI a private
 * daemon serves; `app` marks the daemon the desktop app forked.
 */
export type LeaseHostKind =
  | { kind: 'daemon'; port: number; ownerPid?: number; app?: 'desktop' }
  | { kind: 'vscode' };

/** A session's lease as its file records it. */
export interface SessionLeaseRecord {
  /** Minted once per host, so a restarted process at a reused pid is not mistaken for the holder. */
  hostId: string;
  pid: number;
  host?: LeaseHostKind;
  /** When this host took the lease. */
  since: string;
  /** Refreshed every heartbeat; stale past {@link LEASE_STALE_MS}. */
  heartbeatAt: string;
  /**
   * The process groups of the runners the holder had started and not seen
   * end. A host killed outright cannot stop them, and they go on writing in
   * the session's worktrees, so a takeover waits for them.
   */
  runnerGroups: number[];
  /**
   * Whether the holder's run is live: an attempt at work, a start pending, a
   * landing or Merge all under way. Much of that is only in the holder's
   * memory, so it says it here, for another host's landing interlock
   * (ADR-0062 G7). Absent from a holder that predates it.
   */
  runLive?: boolean;
}

const LEASE_FILE = 'lease.json';

/** A root session's lease file; a child writes none (ADR-0055 D13). */
export function leaseFile(sessionId: string, workspace: string): string {
  return path.join(getSessionsDir(workspace), idSegment(sessionId), LEASE_FILE);
}

function isRecord(value: unknown): value is SessionLeaseRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.hostId === 'string' && typeof r.pid === 'number' && typeof r.since === 'string'
    && typeof r.heartbeatAt === 'string' && Array.isArray(r.runnerGroups) && r.runnerGroups.every((g) => typeof g === 'number');
}

/** The record on disk; null when there is none, or none any host could have written (every write is a rename). */
export function readLeaseRecord(file: string): SessionLeaseRecord | null {
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

/** Whether the host that wrote `record` lives, judged by its heartbeat and its pid. */
export function holderLives(record: SessionLeaseRecord, now: number, alive: (pid: number) => boolean): boolean {
  const beat = Date.parse(record.heartbeatAt);
  if (Number.isNaN(beat) || now - beat > LEASE_STALE_MS) return false;
  return alive(record.pid);
}

export interface LiveHolderProbes {
  now?: () => number;
  alive?: (pid: number) => boolean;
}

/**
 * The host that holds `sessionId` in `workspace` now, or null when none does.
 * For a client that holds no lease of its own and only needs to know whom to
 * reach: it does not weigh orphaned runners, which only a host taking over must.
 */
export function readLiveHolder(sessionId: string, workspace: string, probes: LiveHolderProbes = {}): SessionLeaseRecord | null {
  const record = readLeaseRecord(leaseFile(sessionId, workspace));
  if (!record) return null;
  return holderLives(record, (probes.now ?? Date.now)(), probes.alive ?? processAlive) ? record : null;
}
