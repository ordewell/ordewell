import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { DAEMON_SUBPROTOCOL, saveSession, type LegacyPlanState, type RunSnapshotFrame, type SessionFrame } from '@ordewell/core';
import { createWsHandler } from '../stream';
import { OrchestratorPool } from '../../pool/orchestratorPool';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-10-13T09:00:00.000Z',
    lastUpdated: '2026-10-13T09:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'completed', description: 'd', dependencies: [], assignedRunner: 'opencode', subtasks: [] },
      { id: 't2', order: 2, title: 'Wire it up', type: 'ai', status: 'pending', description: 'd', dependencies: ['t1'], assignedRunner: 'opencode', subtasks: [] },
    ],
  };
}

interface JoinedSocket {
  /** The first `count` frames it has received, resolving as soon as it has that many. */
  until(count: number): Promise<unknown[]>;
  close(): void;
}

interface FrameWaiter {
  count: number;
  timer?: NodeJS.Timeout;
  resolve: (frames: unknown[]) => void;
  reject: (error: Error) => void;
}

/**
 * A socket newly joined to the session. `until` lets a test wait for the
 * frames the server has actually sent instead of sleeping and hoping: the
 * handler subscribes only after its snapshot, both in one turn, so once the
 * snapshot arrives a later broadcast is certain to reach this socket.
 */
function joinSocket(port: number, sessionId: string): JoinedSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`, [DAEMON_SUBPROTOCOL]);
  const frames: unknown[] = [];
  const waiters = new Set<FrameWaiter>();
  const settle = (error?: Error) => {
    for (const waiter of [...waiters]) {
      if (!error && frames.length < waiter.count) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve(frames);
    }
  };
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
    settle();
  });
  socket.on('error', (error) => settle(error));
  return {
    until: (count) => new Promise<unknown[]>((resolve, reject) => {
      const waiter: FrameWaiter = { count, resolve, reject };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`got ${frames.length} of ${count} frames`));
      }, 5000);
      waiters.add(waiter);
      settle();
    }),
    close: () => socket.close(),
  };
}

/** The first `count` frames a new socket on the session receives. */
async function firstFrames(port: number, sessionId: string, count: number): Promise<unknown[]> {
  const socket = joinSocket(port, sessionId);
  try {
    return await socket.until(count);
  } finally {
    socket.close();
  }
}

describe('the session socket', () => {
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-stream-'));
    mkdirSync(join(workspace, '.git'));
    pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    server = http.createServer();
    const upgrade = createWsHandler(pool);
    server.on('upgrade', upgrade);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    pool.destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  });

  it('sends a joining client the run as it stands, right after connected', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);

    const [connected, snapshot] = await firstFrames(port, meta.id, 2);

    expect(connected).toEqual({ type: 'connected', sessionId: meta.id });
    const frame = snapshot as RunSnapshotFrame;
    expect(frame.type).toBe('run_snapshot');
    expect(frame.sessionId).toBe(meta.id);
    expect(frame.view.tasks.map((t) => [t.id, t.title, t.status])).toEqual([['t1', 'Add the limiter', 'completed'], ['t2', 'Wire it up', 'pending']]);
    expect(frame.approvals).toEqual([]);
  });

  it('numbers every broadcast of a session, and greets with the number the snapshot accounts for', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    await pool.session(meta.id).execute({ command: 'mark_complete', task: 't2' }, { kind: 'user' });

    const [, snapshot] = await firstFrames(port, meta.id, 2) as [unknown, RunSnapshotFrame];
    const later = joinSocket(port, meta.id);
    // Await its connected and snapshot frames, which is when it is subscribed:
    // no broadcast of the command below can fall between the two.
    await later.until(3);
    const broadcast = later.until(4);
    await pool.session(meta.id).execute({ command: 'mark_not_done', task: 't2' }, { kind: 'user' });
    const [, again, , next] = await broadcast as [unknown, RunSnapshotFrame, unknown, SessionFrame];
    later.close();

    expect(snapshot.seq).toBeGreaterThan(0);
    expect(again.seq).toBe(snapshot.seq);
    expect(next).toMatchObject({ stream: snapshot.stream, seq: snapshot.seq! + 1 });
  });

  // A compaction has no turn, so a surface that joins or reconnects while one
  // runs would otherwise show a planner that is simply silent. The replay is
  // the start as it was announced, the same message the live frame carried.
  it('replays the planner compaction in flight to a client that joins during it, after the snapshot', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    const started = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'manual', at: '2026-10-25T10:00:00.000Z' } } as const;
    vi.spyOn(pool, 'plannerCompaction').mockReturnValue(started);

    const frames = await firstFrames(port, meta.id, 4);

    expect(frames.map((f) => (f as { type: string }).type)).toEqual(['connected', 'run_snapshot', 'planner_compaction', 'account_limits']);
    expect(frames[2]).toEqual(started);
  });

  // A turn at the planner gate has no id to adopt either, and a first turn can
  // park there before its client's socket has joined.
  it('tells a client that joins while a planner turn waits on agent detection, after the snapshot', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    const waiting = { type: 'planner_detection', waiting: true } as const;
    vi.spyOn(pool, 'plannerDetection').mockReturnValue(waiting);

    const frames = await firstFrames(port, meta.id, 4);

    expect(frames.map((f) => (f as { type: string }).type)).toEqual(['connected', 'run_snapshot', 'planner_detection', 'account_limits']);
    expect(frames[2]).toEqual(waiting);
  });

  // The lifecycle rides the existing stream: both phases arrive numbered in
  // order, carrying the id a surface folds them into one block by.
  it('streams a compaction\'s start and end to a joined client in order, under one id', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    const socket = joinSocket(port, meta.id);
    await socket.until(3);
    const frames = socket.until(5);
    const broadcast = (pool as unknown as { broadcast(id: string, m: unknown): void }).broadcast.bind(pool);
    broadcast(meta.id, { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-10-25T10:00:00.000Z' } });
    broadcast(meta.id, { type: 'planner_compaction', compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'auto', outcome: 'condensed', at: '2026-10-25T10:00:05.000Z' } });
    const [, , , first, second] = await frames as [unknown, unknown, unknown, SessionFrame, SessionFrame];
    socket.close();

    expect([first, second].map((f) => f.type === 'planner_compaction' && [f.compaction.phase, f.compaction.id])).toEqual([['started', 'c1'], ['ended', 'c1']]);
    expect(second.seq).toBe(first.seq! + 1);
  });

  it('sends no compaction or detection frame when neither is under way', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    const socket = joinSocket(port, meta.id);
    await socket.until(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frames = await socket.until(3);
    socket.close();

    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({ type: 'account_limits', limits: [] });
  });
});
