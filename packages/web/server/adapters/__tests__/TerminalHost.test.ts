import { describe, it, expect, vi } from 'vitest';
import type { ITerminalRunner, TmuxRunner } from '@ordewell/core';
import { FakeTerminalSession } from '@ordewell/core/testing';
import { AdvisingRunner, startTerminalHost, TMUX_MISSING_ADVICE } from '../TerminalHost';

const fakeTmux = () => ({ ensureSession: vi.fn().mockResolvedValue(undefined) }) as unknown as TmuxRunner;

describe('startTerminalHost', () => {
  it('starts a tmux runner when tmux is on the host', () => {
    const tmux = fakeTmux();
    const host = startTerminalHost(3742, { hasTmuxImpl: () => true, createTmuxRunner: () => tmux });
    expect(host.runner).toBe(tmux);
    expect(host.advice).toBeUndefined();
    expect(tmux.ensureSession).toHaveBeenCalled();
  });

  it('starts without tmux: no runner, no refusal, no output, and the advice kept for a terminal run', () => {
    const create = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = startTerminalHost(3742, { hasTmuxImpl: () => false, createTmuxRunner: create });
    expect(host.runner).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(host.advice).toBe(TMUX_MISSING_ADVICE);
    err.mockRestore();
  });

  it('names what is unavailable and how to get it', () => {
    expect(TMUX_MISSING_ADVICE).toMatch(/install tmux/i);
    expect(TMUX_MISSING_ADVICE).toMatch(/no structured connector/i);
  });
});

describe('AdvisingRunner', () => {
  const inner = (): ITerminalRunner => ({
    activeCount: 2,
    spawn: vi.fn().mockResolvedValue(new FakeTerminalSession()),
    stop: vi.fn(),
    stopAll: vi.fn(),
  });
  const opts = { taskId: 't1', runner: 'claude-code', prompt: 'p', cwd: '/tmp' };

  it('says it once, before the first terminal spawn, and still spawns', async () => {
    const wrapped = inner();
    const advise = vi.fn();
    const runner = new AdvisingRunner(wrapped, 'no tmux', advise);
    expect(advise).not.toHaveBeenCalled();

    await runner.spawn(opts);
    await runner.spawn({ ...opts, taskId: 't2' });

    expect(advise).toHaveBeenCalledTimes(1);
    expect(advise).toHaveBeenCalledWith('no tmux');
    expect(wrapped.spawn).toHaveBeenCalledTimes(2);
  });

  it('passes the rest straight through', () => {
    const wrapped = inner();
    const runner = new AdvisingRunner(wrapped, 'no tmux', vi.fn());
    expect(runner.activeCount).toBe(2);
    runner.stop('s1');
    runner.stopAll();
    expect(wrapped.stop).toHaveBeenCalledWith('s1');
    expect(wrapped.stopAll).toHaveBeenCalled();
  });
});
