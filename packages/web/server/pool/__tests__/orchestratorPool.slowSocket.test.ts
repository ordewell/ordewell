import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WebSocket } from 'ws';
import { saveSession, type LegacyPlanState, type SessionMessage } from '@ordewell/core';
import { OrchestratorPool, SLOW_SOCKET_BYTES } from '../orchestratorPool';

const roots: string[] = [];
const pools: OrchestratorPool[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const pool of pools.splice(0)) pool.destroyAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function openPool(): OrchestratorPool {
  const root = mkdtempSync(join(tmpdir(), 'ordewell-slow-'));
  mkdirSync(join(root, '.git'));
  roots.push(root);
  const plan: LegacyPlanState = { status: 'approved', tasks: [], runners: ['codex'], generatedAt: '', lastUpdated: '' };
  saveSession(plan, 'Goal', root, 's1');
  const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
  pools.push(pool);
  pool.adoptSavedSession('s1', root);
  return pool;
}

// The pool's one door for a session's frames; the Session reaches it through its broadcaster.
function broadcastOf(pool: OrchestratorPool): (message: SessionMessage) => void {
  const door = pool as unknown as { broadcast(id: string, workspace: string | undefined, message: SessionMessage): void };
  return (message) => door.broadcast('s1', undefined, message);
}

function socket(bufferedAmount = 0) {
  const frames: Array<Record<string, unknown>> = [];
  const ws = { OPEN: 1, readyState: 1, bufferedAmount, send: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>) };
  return { ws: ws as unknown as WebSocket, socket: ws, frames, broadcasts: () => frames.filter((f) => f.stream !== undefined && f.type !== 'account_limits') };
}

const out = (taskId: string, text: string): SessionMessage => ({ type: 'task_output', taskId, text });
const status = (state: string): SessionMessage => ({ type: 'status_update', tasks: [{ id: 't1', status: state }] } as unknown as SessionMessage);

/** What a surface ends up holding: each task's text as appended, and the last status. */
function fold(frames: Array<Record<string, unknown>>) {
  const outputs: Record<string, string> = {};
  let last: unknown;
  for (const f of frames) {
    if (f.type === 'task_output') outputs[f.taskId as string] = (outputs[f.taskId as string] ?? '') + (f.text as string);
    else if (f.type === 'status_update') last = f.tasks;
  }
  return { outputs, last };
}

describe('a socket that is not keeping up', () => {
  it('is sent each chunk of output as it comes while its buffer is low', () => {
    const pool = openPool();
    const fast = socket();
    pool.subscribe('s1', fast.ws);
    const tell = broadcastOf(pool);

    tell(out('a', 'one')); tell(out('a', 'two'));

    expect(fast.broadcasts().map((f) => f.text)).toEqual(['one', 'two']);
  });

  it('is told a run of one task\'s output as one numbered frame, with the same bytes in the same order', () => {
    const pool = openPool();
    const slow = socket(SLOW_SOCKET_BYTES + 1);
    const fast = socket();
    pool.subscribe('s1', slow.ws);
    pool.subscribe('s1', fast.ws);
    const tell = broadcastOf(pool);
    const chunks = Array.from({ length: 50 }, (_, i) => `line ${i}\n`);

    for (const chunk of chunks) tell(out('a', chunk));
    vi.advanceTimersByTime(1000);

    const expected = chunks.join('');
    expect(fold(slow.broadcasts()).outputs).toEqual({ a: expected });
    expect(slow.broadcasts().length).toBeLessThan(10);
    expect(fold(fast.broadcasts()).outputs).toEqual({ a: expected });
  });

  it('keeps its output ahead of whatever follows it, and every number it was given', () => {
    const pool = openPool();
    const slow = socket(SLOW_SOCKET_BYTES + 1);
    pool.subscribe('s1', slow.ws);
    const tell = broadcastOf(pool);

    tell(status('running'));
    tell(out('a', 'x1')); tell(out('a', 'x2'));
    tell(status('failed'));
    tell(out('b', 'y1'));
    tell(out('a', 'x3')); tell(out('a', 'x4'));
    tell({ type: 'execution_stopped' } as SessionMessage);
    vi.advanceTimersByTime(1000);

    expect(slow.broadcasts().map((f) => `${f.type}:${f.text ?? ''}`)).toEqual([
      'status_update:', 'task_output:x1x2', 'status_update:', 'task_output:y1', 'task_output:x3x4', 'execution_stopped:',
    ]);
    expect(slow.broadcasts().map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('ends with the state a keeping-up socket ends with, over a whole run of mixed messages', () => {
    const pool = openPool();
    const slow = socket(SLOW_SOCKET_BYTES + 1);
    const fast = socket();
    pool.subscribe('s1', slow.ws);
    pool.subscribe('s1', fast.ws);
    const tell = broadcastOf(pool);

    for (let i = 0; i < 30; i++) {
      tell(out(i % 3 === 0 ? 'a' : 'b', `${i};`));
      if (i % 7 === 0) tell(status(`s${i}`));
    }
    vi.advanceTimersByTime(1000);

    expect(fold(slow.broadcasts())).toEqual(fold(fast.broadcasts()));
    expect(fold(slow.broadcasts()).last).toEqual([{ id: 't1', status: 's28' }]);
    const seqs = slow.broadcasts().map((f) => f.seq as number);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('is told held output within a moment even when nothing follows it', () => {
    const pool = openPool();
    const slow = socket(SLOW_SOCKET_BYTES + 1);
    pool.subscribe('s1', slow.ws);
    const tell = broadcastOf(pool);

    tell(out('a', 'last words'));
    expect(slow.broadcasts()).toEqual([]);
    vi.advanceTimersByTime(1000);

    expect(slow.broadcasts().map((f) => f.text)).toEqual(['last words']);
  });

  it('goes back to frame-by-frame once its buffer drains', () => {
    const pool = openPool();
    const slow = socket(SLOW_SOCKET_BYTES + 1);
    pool.subscribe('s1', slow.ws);
    const tell = broadcastOf(pool);
    tell(out('a', 'held'));
    slow.socket.bufferedAmount = 0;

    tell(out('a', 'now'));
    vi.advanceTimersByTime(1000);

    expect(slow.broadcasts().map((f) => f.text)).toEqual(['heldnow']);
    tell(out('a', 'later'));
    expect(slow.broadcasts().map((f) => f.text)).toEqual(['heldnow', 'later']);
  });
});
