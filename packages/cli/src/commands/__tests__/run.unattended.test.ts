import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Escalation, SupervisorLevel } from '@ordewell/core';
import type { ApiClient } from '../../apiClient';
import { handleRun, RUN_WAITS_EXIT } from '../run';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

const held: Escalation = {
  id: 'on-hold:t1:1',
  kind: 'on-hold',
  task: { id: 't1', ref: '#1', title: 'Migrate the schema' },
  attempt: 1,
  reason: 'On hold: cancelled; retry or force start to run it again',
  options: [{ id: 'retry', label: 'Retry' }, { id: 'force-start', label: 'Force start' }],
};
const input: Escalation = {
  id: 'input:t1:1',
  kind: 'input',
  task: { id: 't1', ref: '#1', title: 'Migrate the schema' },
  attempt: 1,
  reason: 'It asks: which database?',
  options: [{ id: 'reply', label: 'Reply', note: 'required' }],
};
const checkpoint: Escalation = {
  id: 'checkpoint:t1:1',
  kind: 'checkpoint',
  task: { id: 't1', ref: '#1', title: 'Migrate the schema' },
  attempt: 1,
  reason: 'Checkpoint: Drop the users table?',
  options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject', note: 'optional' }],
};

const waits = (...list: Escalation[]): Event => ({ type: 'status_update', tasks: [], escalations: list });
const turn = (id: string, ended = false): Event => (ended
  ? { type: 'planner_turn_ended', turnId: id, outcome: 'message' }
  : { type: 'planner_turn_started', turnId: id, supervisor: true });

/** A daemon at `level` whose run stream stays open: `send` puts events on it, and `close` ends it as a run's end would. */
function daemon(level: SupervisorLevel) {
  let onEvent: (e: Event) => void = () => {};
  let close: () => void = () => {};
  const api = {
    getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }),
    getSettings: vi.fn().mockResolvedValue({ run: { supervisorLevel: level } }),
    streamExecution: vi.fn((_id: string, listener: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
      onEvent = listener;
      close = resolve;
      setTimeout(() => onReady?.(), 0);
    })),
    executePlan: vi.fn().mockResolvedValue({ status: 'running' }),
    endExecutionStream: vi.fn(() => close()),
  };
  return {
    api: api as unknown as ApiClient & typeof api,
    send: (...events: Event[]) => events.forEach((e) => onEvent(e)),
    close: () => close(),
  };
}

let written: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  written = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Start `ordewell run`, with `args`, and say whether it has returned. */
async function run(api: ApiClient, args: string[] = []) {
  let returned = false;
  const done = handleRun(['--session-id', 's1', ...args], api).then(() => { returned = true; });
  await vi.advanceTimersByTimeAsync(10);
  return { done, returned: () => returned };
}

describe('ordewell run when a task on hold holds the run', () => {
  it('names the task, why it is held, the commands that release it and who can, and keeps waiting', async () => {
    const { api, send, close } = daemon('watch');
    const follower = await run(api);

    send(waits(held));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(written.join('')).toContain(
      '· On hold: #1 Migrate the schema: cancelled; retry or force start to run it again: `ordewell retry 1`, `ordewell force-start 1` or `ordewell skip 1` releases it and what needs it. Nobody releases it unattended: it waits until someone does. `ordewell supervisor act` lets the supervisor act in new sessions.\n',
    );
    expect(follower.returned()).toBe(false);
    expect(api.endExecutionStream).not.toHaveBeenCalled();
    close();
    await follower.done;
  });

  it('says at Act that the supervisor is woken to it once nothing else can run', async () => {
    const { api, send, close } = daemon('act');
    const follower = await run(api);

    send(waits(held));
    await vi.advanceTimersByTimeAsync(10);

    expect(written.join('')).toContain('releases it and what needs it. The supervisor is woken to it once nothing else can run.\n');
    close();
    await follower.done;
  });
});

describe('ordewell run --unattended', () => {
  it('returns 3 at Act once a supervisor turn after the wait has left it standing, and answers nothing', async () => {
    const { api, send } = daemon('act');
    const follower = await run(api, ['--unattended']);

    // The reproduction: woken to the input, the supervisor stops the task and ends its turn.
    send(waits(input), turn('w1'), waits(held), turn('w1', true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(follower.returned()).toBe(false);

    // Woken again to the run idle behind the hold, it leaves the hold in place.
    send(turn('w2'), turn('w2', true));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
    expect(RUN_WAITS_EXIT).toBe(3);
    expect(api.endExecutionStream).toHaveBeenCalledWith('s1');
    const out = written.join('');
    expect(out).toContain('· Waits on a person: #1 Migrate the schema: On hold: cancelled; retry or force start to run it again.\n');
    expect(out).toContain('· The run waits on a person, and stays as it is in the daemon: nothing was answered, stopped or skipped. `ordewell status` shows where it stands.\n');
  });

  it('keeps following at Act when the turn answers the wait', async () => {
    const { api, send, close } = daemon('act');
    const follower = await run(api, ['--unattended']);

    send(waits(input), turn('w1'), turn('w1', true));
    // The status update that drops the answered wait may trail the turn's end.
    await vi.advanceTimersByTimeAsync(500);
    send(waits());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
  });

  it.each<[SupervisorLevel, string, Escalation]>([
    ['watch', 'a hold', held],
    ['off', 'a hold', held],
    ['watch', 'a checkpoint', checkpoint],
    ['off', 'an input', input],
  ])('returns 3 at once at %s, on %s', async (level, _what, wait) => {
    const { api, send } = daemon(level);
    const follower = await run(api, ['--unattended']);

    send(waits(wait));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
    expect(written.join('')).toContain(`· Waits on a person: #1 Migrate the schema: ${wait.reason.replace(/[.\s]+$/, '')}.\n`);
  });

  it('returns 3 at Act on a checkpoint the supervisor\'s turn left standing', async () => {
    const { api, send } = daemon('act');
    const follower = await run(api, ['--unattended']);

    send(waits(checkpoint));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(follower.returned()).toBe(false);

    send(turn('w1'), turn('w1', true));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
  });

  it('changes nothing without the flag: at Watch a checkpoint waits for good', async () => {
    const { api, send, close } = daemon('watch');
    const follower = await run(api);

    send(waits(checkpoint));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
    expect(process.exitCode).toBeUndefined();
  });
});
