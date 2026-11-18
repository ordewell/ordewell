import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PoolAwareRunner } from '../PoolAwareRunner';
import type { IRunner } from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';

function fakeInnerRunner(): IRunner & { _session: FakeRunnerSession } {
  const session = new FakeRunnerSession();
  return {
    activeCount: 0,
    spawn: vi.fn().mockResolvedValue(session),
    stop: vi.fn(),
    stopAll: vi.fn(),
    _session: session,
  };
}

describe('PoolAwareRunner', () => {
  it('counts only its own live sessions, not every session on a shared inner runner', async () => {
    const inner = fakeInnerRunner();
    inner.activeCount = 3; // other plans' sessions on the shared runner
    const runner = new PoolAwareRunner('session-1', vi.fn(), inner);
    expect(runner.activeCount).toBe(0);

    await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'test', cwd: '/tmp' });
    expect(runner.activeCount).toBe(1);

    inner._session.emitExit(0);
    expect(runner.activeCount).toBe(0);
  });

  it('stopAll stops only its own sessions — a shared inner runner serves other plans too', async () => {
    const inner = fakeInnerRunner();
    const runner = new PoolAwareRunner('session-1', vi.fn(), inner);
    await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'test', cwd: '/tmp' });

    runner.stopAll();

    expect(inner.stopAll).not.toHaveBeenCalled();
    expect(inner.stop).toHaveBeenCalledWith(inner._session.id);
    expect(runner.activeCount).toBe(0);
  });

  it('tags every spawn with its plan session id so the runner can scope task resources', async () => {
    const inner = fakeInnerRunner();
    const runner = new PoolAwareRunner('session-1', vi.fn(), inner);
    await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'test', cwd: '/tmp' });

    expect(inner.spawn).toHaveBeenCalledWith(expect.objectContaining({ planSessionId: 'session-1' }));
  });

  it('delegates per-session stop to inner runner (orchestrator cancelTask path)', () => {
    const inner = fakeInnerRunner();
    const runner = new PoolAwareRunner('session-1', vi.fn(), inner);
    runner.stop('ordewell-t1');
    expect(inner.stop).toHaveBeenCalledWith('ordewell-t1');
  });

  it('broadcasts task_started on spawn with task meta from opts', async () => {
    const inner = fakeInnerRunner();
    const broadcast = vi.fn();
    const runner = new PoolAwareRunner('session-1', broadcast, inner);

    await runner.spawn({
      taskId: 't1',
      runner: 'claude-code',
      prompt: 'test',
      modelId: 'sonnet',
      cwd: '/tmp',
      order: 2,
      title: 'My Task',
    });

    expect(broadcast).toHaveBeenCalledWith({
      type: 'task_started',
      taskId: 't1',
      order: 2,
      title: 'My Task',
      runner: 'claude-code',
      modelId: 'sonnet',
    });
  });

  it('broadcasts task_started with default meta when opts omitted', async () => {
    const inner = fakeInnerRunner();
    const broadcast = vi.fn();
    const runner = new PoolAwareRunner('session-2', broadcast, inner);

    await runner.spawn({
      taskId: 't2',
      runner: 'opencode',
      prompt: 'test',
      cwd: '/tmp',
    });

    expect(broadcast).toHaveBeenCalledWith({
      type: 'task_started',
      taskId: 't2',
      order: 0,
      title: '',
      runner: 'opencode',
      modelId: undefined,
    });
  });

  describe('task_output', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const outputs = (broadcast: ReturnType<typeof vi.fn>, taskId: string) =>
      broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'task_output' && m.taskId === taskId);

    async function spawned(taskId: string, broadcast = vi.fn(), inner = fakeInnerRunner()) {
      const runner = new PoolAwareRunner('session-3', broadcast, inner);
      const session = await runner.spawn({ taskId, runner: 'claude-code', prompt: 'test', cwd: '/tmp' }) as FakeRunnerSession;
      return { runner, session, broadcast };
    }

    it('sends the chunks of a window as one frame holding their bytes in order', async () => {
      const { session, broadcast } = await spawned('t3');

      session.emitOutput('hello ');
      session.emitOutput('world');
      session.emitOutput('\nmore');
      expect(outputs(broadcast, 't3')).toEqual([]);
      vi.advanceTimersByTime(100);

      expect(outputs(broadcast, 't3')).toEqual([{ type: 'task_output', taskId: 't3', text: 'hello world\nmore' }]);
    });

    it('starts a new window after a flush, and says nothing for a quiet one', async () => {
      const { session, broadcast } = await spawned('t3');

      session.emitOutput('a');
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(500);
      session.emitOutput('b');
      vi.advanceTimersByTime(100);

      expect(outputs(broadcast, 't3').map((m) => m.text)).toEqual(['a', 'b']);
    });

    it('flushes what a task printed when its attempt ends, before the end is told', async () => {
      const { session, broadcast } = await spawned('t3');

      session.emitOutput('last words');
      session.emitExit(1);

      expect(outputs(broadcast, 't3').map((m) => m.text)).toEqual(['last words']);
      vi.advanceTimersByTime(1000);
      expect(outputs(broadcast, 't3')).toHaveLength(1);
    });

    it('flushes when the runner stops the session', async () => {
      const inner = fakeInnerRunner();
      const { runner, session, broadcast } = await spawned('t3', vi.fn(), inner);

      session.emitOutput('partial');
      await runner.stop(session.id);

      expect(outputs(broadcast, 't3').map((m) => m.text)).toEqual(['partial']);
    });

    it('keeps each task\'s output to its own frames', async () => {
      const broadcast = vi.fn();
      const inner = fakeInnerRunner();
      const runner = new PoolAwareRunner('session-3', broadcast, inner);
      const first = await runner.spawn({ taskId: 'a', runner: 'claude-code', prompt: 'p', cwd: '/tmp' }) as FakeRunnerSession;
      inner._session = new FakeRunnerSession();
      inner.spawn = vi.fn().mockResolvedValue(inner._session);
      const second = await runner.spawn({ taskId: 'b', runner: 'claude-code', prompt: 'p', cwd: '/tmp' }) as FakeRunnerSession;

      first.emitOutput('A1');
      second.emitOutput('B1');
      first.emitOutput('A2');
      vi.advanceTimersByTime(100);

      expect(outputs(broadcast, 'a').map((m) => m.text)).toEqual(['A1A2']);
      expect(outputs(broadcast, 'b').map((m) => m.text)).toEqual(['B1']);
    });
  });

  it('spawn accepts unknown RunnerId string, not just hardcoded runner names', async () => {
    const inner = fakeInnerRunner();
    const broadcast = vi.fn();
    const runner = new PoolAwareRunner('session-5', broadcast, inner);

    await runner.spawn({
      taskId: 't5',
      runner: 'third-party-runner-plugin',
      prompt: 'test',
      cwd: '/tmp',
    });

    expect(inner.spawn).toHaveBeenCalledWith(expect.objectContaining({
      runner: 'third-party-runner-plugin',
    }));
  });
});
