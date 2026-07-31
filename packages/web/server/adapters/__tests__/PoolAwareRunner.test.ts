import { describe, it, expect, vi } from 'vitest';
import { PoolAwareRunner } from '../PoolAwareRunner';
import type { ITerminalRunner } from '@ordewell/core';
import { FakeTerminalSession } from '@ordewell/core/testing';

function fakeInnerRunner(): ITerminalRunner & { _session: FakeTerminalSession } {
  const session = new FakeTerminalSession();
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

  it('tags every spawn with its plan session id so transports can scope task resources', async () => {
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

  it('broadcasts task_output from inner session', async () => {
    const inner = fakeInnerRunner();
    const broadcast = vi.fn();
    const runner = new PoolAwareRunner('session-3', broadcast, inner);

    const session = await runner.spawn({
      taskId: 't3',
      runner: 'claude-code',
      prompt: 'test',
      cwd: '/tmp',
    });

    const emitSession = session as FakeTerminalSession;
    emitSession.emitOutput('hello world');
    emitSession.emitOutput('more output');

    expect(broadcast).toHaveBeenCalledWith({ type: 'task_output', taskId: 't3', text: 'hello world' });
    expect(broadcast).toHaveBeenCalledWith({ type: 'task_output', taskId: 't3', text: 'more output' });
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
