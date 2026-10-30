import { describe, it, expect, vi } from 'vitest';
import { replayTaskLog } from '@ordewell/core';
import { stripAnsi } from '../ansi';
import { createApp } from '../app';
import { style } from '../ansi';
import type { Effect } from '../reducer';
import { lastMessage, messagesOf } from './chat';

/** The paint interval `createApp` keeps between message-driven frames. */
const FRAME_BUDGET_MS = 33;

function harness(over: Parameters<typeof createApp>[0]['initial'] = {}) {
  const frames: string[][] = [];
  const performed: Effect[] = [];
  const onExit = vi.fn();

  const app = createApp({
    initial: { rows: 24, cols: 80, ...over },
    draw: (frame) => frames.push(frame),
    perform: async (effect) => { performed.push(effect); },
    onExit,
  });

  return { app, frames, performed, onExit };
}

describe('createApp', () => {
  it('draws a frame as soon as it starts', () => {
    const h = harness();
    h.app.start();
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toHaveLength(24);
  });

  it('loads runners, settings and models on startup', () => {
    const h = harness();
    h.app.start();
    expect(h.performed).toContainEqual({ type: 'refresh' });
  });

  it('re-reads the enabled runners and the allowlist when the shared settings file changes', () => {
    const h = harness();
    h.app.start();
    h.performed.length = 0;

    h.app.dispatch({ type: 'sharedSettingsChanged' });

    expect(h.performed).toEqual([{ type: 'loadScope' }]);
  });

  it('reports each new session once, so the CLI can default to it', () => {
    const onSessionChange = vi.fn();
    const app = createApp({ initial: { rows: 24, cols: 80 }, draw: () => {}, perform: async () => {}, onExit: () => {}, onSessionChange });

    app.dispatch({ type: 'sessionStarted', sessionId: 's1', goal: 'Add multiply' });
    app.dispatch({ type: 'notice', message: 'unrelated' });
    app.dispatch({ type: 'sessionStarted', sessionId: 's2', goal: 'Add reverse' });

    expect(onSessionChange.mock.calls.map(([id, state]) => [id, state.goal])).toEqual([['s1', 'Add multiply'], ['s2', 'Add reverse']]);
  });

  it('startup refresh posts no notice', async () => {
    const h = harness();
    h.app.start();
    expect(messagesOf(h.app.getState())).toEqual([]);
  });

  it('redraws after every action', async () => {
    const h = harness();
    h.app.start();
    h.app.dispatch({ type: 'key', key: { name: 'char', char: 'h' } });
    await new Promise<void>((r) => queueMicrotask(() => r()));
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1].join('\n')).toContain('h');
  });

  it('paints a keystroke at once, without waiting for the frame budget', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.app.start();
      const before = h.frames.length;

      h.app.dispatch({ type: 'key', key: { name: 'char', char: 'h' } });

      expect(h.frames).toHaveLength(before + 1);
      expect(h.frames.at(-1)?.join('\n')).toContain('h');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of incoming messages into frames at the paint budget', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.app.start();
      const before = h.frames.length;

      // A macrotask apart, as websocket messages arrive — the old microtask
      // batching painted every one of them.
      for (let i = 0; i < 60; i++) {
        h.app.dispatch({ type: 'notice', message: `line ${i}` });
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(FRAME_BUDGET_MS);

      const painted = h.frames.length - before;
      expect(painted).toBeGreaterThan(0);
      expect(painted).toBeLessThanOrEqual(3);
      expect(h.frames.at(-1)?.join('\n')).toContain('line 59');
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs the effects an action produces', () => {
    const h = harness();
    h.app.start();
    h.app.dispatch({ type: 'notice', message: 'x' });
    h.performed.length = 0;

    for (const char of '/refresh') h.app.dispatch({ type: 'key', key: { name: 'char', char } });
    h.app.dispatch({ type: 'key', key: { name: 'enter' } });

    expect(h.performed).toEqual([{ type: 'refresh', announce: true }]);
  });

  it('exposes the current state', () => {
    const h = harness();
    h.app.dispatch({ type: 'notice', message: 'hello' });
    expect(lastMessage(h.app.getState())?.text).toBe('hello');
  });

  it('calls onExit when the state says to quit', () => {
    const h = harness();
    h.app.start();
    h.app.dispatch({ type: 'key', key: { name: 'ctrl-c' } });
    expect(h.onExit).toHaveBeenCalled();
  });

  it('stops drawing once it is exiting', () => {
    const h = harness();
    h.app.start();
    h.app.dispatch({ type: 'key', key: { name: 'ctrl-c' } });
    const drawn = h.frames.length;

    h.app.dispatch({ type: 'notice', message: 'too late' });
    expect(h.frames).toHaveLength(drawn);
  });

  it('animates the spinner for a lone running task, not just a full-plan run', () => {
    vi.useFakeTimers();
    try {
      // `f` starts one task without putting the session into 'executing'; the
      // pane still has to show it as running.
      const h = harness({
        status: 'idle',
        tasks: [{ id: 't1', order: 1, title: 'Add the login route', type: 'ai', status: 'in_progress', dependencies: [] }],
      });
      h.app.start();

      vi.advanceTimersByTime(500);
      expect(h.app.getState().spinnerFrame).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the spinner alone while no task is running', () => {
    vi.useFakeTimers();
    try {
      const h = harness({ tasks: [{ id: 't1', order: 1, title: 'Done', type: 'ai', status: 'completed', dependencies: [] }] });
      h.app.start();
      const drawn = h.frames.length;

      vi.advanceTimersByTime(500);
      expect(h.app.getState().spinnerFrame).toBe(0);
      expect(h.frames).toHaveLength(drawn);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the status row spinner', () => {
    const quiet = { id: 't1', order: 1, title: 'Add the login route', type: 'ai' as const, status: 'in_progress' as const, dependencies: [], idleSince: '2026-08-18T00:00:00.000Z' };

    it('turns during a planner turn, with colour on or off', () => {
      for (const colour of [true, false]) {
        const before = style.enabled;
        style.enabled = colour;
        vi.useFakeTimers();
        try {
          const h = harness({ planner: 'planning' });
          h.app.start();

          vi.advanceTimersByTime(500);
          expect(h.app.getState().spinnerFrame).toBeGreaterThan(0);
        } finally {
          vi.useRealTimers();
          style.enabled = before;
        }
      }
    });

    it('holds still while the chat is idle', () => {
      vi.useFakeTimers();
      try {
        const h = harness({ tasks: [{ id: 't1', order: 1, title: 'Done', type: 'ai', status: 'completed', dependencies: [] }] });
        h.app.start();
        const drawn = h.frames.length;

        vi.advanceTimersByTime(2000);
        expect(h.app.getState().spinnerFrame).toBe(0);
        expect(h.frames).toHaveLength(drawn);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps counting the elapsed time of a quiet runner the chat is open on (#81)', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-30T10:03:05.000Z'));
        const h = harness({
          focus: 'chat',
          rows: 30,
          cols: 100,
          tasks: [quiet],
          taskView: {
            taskId: 't1', attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
            view: replayTaskLog([{ type: 'turn_start', message: 'Go', startedAt: '2026-10-30T10:00:00.000Z' }]),
          },
        });
        h.app.start();
        const timeOf = () => h.frames.at(-1)?.map(stripAnsi).join('\n').match(/~ Stalled (\S+ \S+)/)?.[1];
        expect(timeOf()).toBe('3m 05s');

        vi.advanceTimersByTime(5100);
        expect(timeOf()).toBe('3m 10s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds still when the only running task is quiet: its marker is static', () => {
      vi.useFakeTimers();
      try {
        const h = harness({ status: 'idle', tasks: [quiet] });
        h.app.start();
        const drawn = h.frames.length;

        vi.advanceTimersByTime(2000);
        expect(h.app.getState().spinnerFrame).toBe(0);
        expect(h.frames).toHaveLength(drawn);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('keeps running when an effect rejects', async () => {
    const frames: string[][] = [];
    const app = createApp({
      initial: { rows: 24, cols: 80 },
      draw: (frame) => frames.push(frame),
      perform: async () => { throw new Error('boom'); },
      onExit: vi.fn(),
    });

    app.start();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(app.getState().exiting).toBe(false);
  });
});
