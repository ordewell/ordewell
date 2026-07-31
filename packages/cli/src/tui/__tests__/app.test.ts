import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../app';
import type { Effect } from '../reducer';

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

  it('redraws after every action', async () => {
    const h = harness();
    h.app.start();
    h.app.dispatch({ type: 'key', key: { name: 'char', char: 'h' } });
    await new Promise<void>((r) => queueMicrotask(() => r()));
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1].join('\n')).toContain('h');
  });

  it('performs the effects an action produces', () => {
    const h = harness();
    h.app.start();
    h.app.dispatch({ type: 'notice', message: 'x' });
    h.performed.length = 0;

    for (const char of '/refresh') h.app.dispatch({ type: 'key', key: { name: 'char', char } });
    h.app.dispatch({ type: 'key', key: { name: 'enter' } });

    expect(h.performed).toEqual([{ type: 'refresh' }]);
  });

  it('exposes the current state', () => {
    const h = harness();
    h.app.dispatch({ type: 'notice', message: 'hello' });
    expect(h.app.getState().messages.at(-1)?.content).toBe('hello');
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

  it('keeps running when an effect rejects', async () => {
    const frames: string[][] = [];
    const app = createApp({
      initial: { rows: 24, cols: 80 },
      draw: (frame) => frames.push(frame),
      perform: async () => { throw new Error('boom'); },
      onExit: vi.fn(),
    });

    app.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.getState().exiting).toBe(false);
  });
});
