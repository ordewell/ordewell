import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs, { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import WebSocket from 'ws';
import { DAEMON_SUBPROTOCOL, saveSession, type LegacyPlanState } from '@ordewell/core';
import { createWsHandler } from '../stream';
import { OrchestratorPool } from '../../pool/orchestratorPool';

/**
 * The pool keys its streams by session id, so a socket's workspace is judged
 * once, when it connects. A surface opens the socket before it adopts the
 * session (the TUI's `loadSession` does exactly that, so a running session goes
 * on reporting while it loads), which leaves the socket subscribed to an id
 * nobody holds yet. If another workspace then opens its own saved copy of that
 * id, the socket must not go on hearing it: the daemon's own greeting and every
 * broadcast after it are keyed by id alone.
 *
 * The plan carries recorded planner usage because loading it announces that
 * usage, and the load comes before the session takes the id: a frame sent then
 * reaches whoever is on the id unless the send itself asks whose it is.
 */

const plan = {
  status: 'approved',
  runners: ['opencode'],
  generatedAt: '2026-07-21T10:00:00.000Z',
  plannerUsage: {
    totals: { inputTokens: 1500, outputTokens: 200 },
    source: 'openai',
    model: 'some-model',
    lastPromptTokens: 1000,
    contextWindow: 100000,
  },
  tasks: [
    { id: 't1', order: 1, title: 'A', type: 'ai', status: 'completed', description: 'd', prompt: 'p', dependencies: [], assignedRunner: 'opencode', subtasks: [] },
    { id: 't2', order: 2, title: 'B', type: 'ai', status: 'pending', description: 'd', prompt: 'p', dependencies: ['t1'], assignedRunner: 'opencode', subtasks: [] },
  ],
} as unknown as LegacyPlanState;

/**
 * Refuses every write under `workspace` once a session file has landed in its
 * sessions directory: a load's own save goes through, and the save after it is
 * the disk refusing. Core reads `fs` through its ESM exports, which only
 * `syncBuiltinESMExports` carries a patch into.
 */
function refuseSavesAfterTheFirst(workspace: string): () => void {
  const sessions = join(workspace, '.ordewell', 'sessions');
  const { renameSync, writeFileSync } = fs;
  let landed = false;
  fs.renameSync = (from, to) => {
    renameSync(from, to);
    if (dirname(String(to)) === sessions && String(to).endsWith('.json')) landed = true;
  };
  fs.writeFileSync = (...args: Parameters<typeof writeFileSync>) => {
    if (landed && String(args[0]).startsWith(workspace)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    writeFileSync(...args);
  };
  syncBuiltinESMExports();
  return () => {
    fs.renameSync = renameSync;
    fs.writeFileSync = writeFileSync;
    syncBuiltinESMExports();
  };
}

describe('a socket that named a workspace while the id was unheld', () => {
  let a: string;
  let b: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let port: number;

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-ws-'));
    mkdirSync(join(dir, '.git'));
    return dir;
  };

  /** A socket on the shared id, once the daemon's greeting (`connected` and the empty account limits) says it is subscribed. */
  const subscribed = async (workspace?: string): Promise<{ socket: WebSocket; frames: Array<{ type?: string; message?: string }>; closed: Promise<number> }> => {
    const query = workspace === undefined ? '' : `?workspace=${encodeURIComponent(workspace)}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/session/shared${query}`, [DAEMON_SUBPROTOCOL]);
    const frames: Array<{ type?: string; message?: string }> = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));
    return { socket, frames, closed };
  };

  beforeEach(async () => {
    a = project();
    b = project();
    saveSession(plan, 'Goal', a, 'shared');
    saveSession(plan, 'Goal', b, 'shared');
    pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    server = http.createServer();
    server.on('upgrade', createWsHandler(pool));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    pool.destroyAll();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  it('hears nothing of the session another workspace opens under it', async () => {
    const frames: unknown[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/session/shared?workspace=${encodeURIComponent(b)}`, [DAEMON_SUBPROTOCOL]);
    try {
      socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
      const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      // `connected` and the empty account-limit greeting: the socket is subscribed.
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (frames.length >= 2) { clearInterval(timer); resolve(); }
        }, 10);
      });
      const before = frames.length;

      // A opens its own saved copy of the id, while B has only this socket on it.
      pool.adoptSavedSession('shared', a);
      await pool.session('shared', a).execute({ command: 'mark_complete', task: 't2', confirmed: true }, { kind: 'user' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(frames.slice(before)).toEqual([]);
      // Turned away as it would have been had it connected after A: its link learns why.
      expect(await closed).toBe(4409);
    } finally {
      socket.close();
    }
  });

  it('goes on hearing the session its own workspace opens under it', async () => {
    const frames: Array<{ type?: string }> = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/session/shared?workspace=${encodeURIComponent(a)}`, [DAEMON_SUBPROTOCOL]);
    try {
      socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
      });
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));

      pool.adoptSavedSession('shared', a);
      await pool.session('shared', a).execute({ command: 'mark_complete', task: 't2', confirmed: true }, { kind: 'user' });

      await vi.waitFor(() => expect(frames.map((frame) => frame.type)).toContain('status_update'));
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
    }
  });

  it('hears nothing of the notice the adopting load sends when the disk refuses its save', async () => {
    const own = await subscribed(a);
    const other = await subscribed(b);
    const before = other.frames.length;
    const restore = refuseSavesAfterTheFirst(a);
    try {
      pool.adoptSavedSession('shared', a);
    } finally {
      restore();
    }
    try {
      // The notice was sent: the load's own workspace hears it.
      await vi.waitFor(() => expect(own.frames.some((frame) => frame.type === 'notice' && frame.message?.includes('could not be saved'))).toBe(true));
      expect(await other.closed).toBe(4409);
      expect(other.frames.slice(before)).toEqual([]);
    } finally {
      own.socket.close();
      other.socket.close();
    }
  });

  it('leaves every frame to the sockets of a session no other workspace shares the id with', async () => {
    const named = await subscribed(a);
    const unnamed = await subscribed();
    try {
      pool.adoptSavedSession('shared', a);
      await pool.session('shared', a).execute({ command: 'mark_complete', task: 't2', confirmed: true }, { kind: 'user' });

      for (const { frames } of [named, unnamed]) {
        await vi.waitFor(() => expect(frames.map((frame) => frame.type)).toEqual(expect.arrayContaining(['planner_usage', 'status_update'])));
      }
      expect(named.socket.readyState).toBe(WebSocket.OPEN);
      expect(unnamed.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      named.socket.close();
      unnamed.socket.close();
    }
  });
});
