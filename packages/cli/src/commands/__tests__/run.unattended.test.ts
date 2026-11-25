import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Escalation, RunActivity, SupervisorLevel } from '@ordewell/core';
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

const byHand: Escalation = {
  id: 'by-hand:u1:0',
  kind: 'by-hand',
  task: { id: 'u1', ref: '#1', title: 'Rotate the API key' },
  reason: 'A manual task: it is yours to do, and to mark complete.',
  options: [{ id: 'complete', label: 'Mark complete' }],
};

/** The run the scheduler drives, with nothing at work and nothing able to start unasked. */
const waitingOnUser: RunActivity = { starting: false, running: false, scheduled: true, resumable: false, advancesOnItsOwn: true, waitsOnUser: true };
/** The same run with a task at work, or something about to start. */
const moving: RunActivity = { ...waitingOnUser, running: true, waitsOnUser: false };

const waits = (...list: Escalation[]): Event => ({ type: 'status_update', tasks: [], escalations: list });
const update = (activity: RunActivity, ...list: Escalation[]): Event => ({ type: 'status_update', tasks: [], activity, escalations: list });
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

  it('says at Act that the supervisor is woken to it when its turn leaves it held, or once nothing else can run', async () => {
    const { api, send, close } = daemon('act');
    const follower = await run(api);

    send(waits(held));
    await vi.advanceTimersByTimeAsync(10);

    expect(written.join('')).toContain('releases it and what needs it. The supervisor is woken to it when a turn of its ends with it still held, or once nothing else can run.\n');
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

describe('ordewell run --unattended when a manual task holds the run', () => {
  it.each<SupervisorLevel>(['off', 'watch', 'act'])('returns 3 at %s once nothing else can run, naming the task and what releases it', async (level) => {
    const { api, send } = daemon(level);
    const follower = await run(api, ['--unattended']);

    // The reproduction: a pending manual task, and an AI task that needs it.
    send(update(waitingOnUser, byHand));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
    expect(api.endExecutionStream).toHaveBeenCalledWith('s1');
    const out = written.join('');
    expect(out).toContain('· Yours to do: #1 Rotate the API key: a manual task: `ordewell complete 1` or `ordewell skip 1` releases it and what needs it. Nobody does it unattended: it waits until you do.\n');
    expect(out).toContain('· Waits on a person: #1 Rotate the API key: A manual task: it is yours to do, and to mark complete.\n');
  });

  it('keeps following while another task runs, and returns once nothing does', async () => {
    const { api, send } = daemon('watch');
    const follower = await run(api, ['--unattended']);

    send(update(moving, byHand));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(follower.returned()).toBe(false);

    send(update(waitingOnUser, byHand));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
  });

  it('keeps following when something can start again before the wait stands', async () => {
    const { api, send, close } = daemon('off');
    const follower = await run(api, ['--unattended']);

    send(update(waitingOnUser, byHand));
    await vi.advanceTimersByTimeAsync(500);
    // A task was marked complete, and what needs it is on its way.
    send(update({ ...waitingOnUser, starting: true, waitsOnUser: false }));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps following when the run moves again with the manual task still listed', async () => {
    const { api, send, close } = daemon('off');
    const follower = await run(api, ['--unattended']);

    send(update(waitingOnUser, byHand));
    await vi.advanceTimersByTimeAsync(500);
    // Another manual task was marked complete, and what needed only it started: this one is still the user's.
    send(update(moving, byHand));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
    expect(process.exitCode).toBeUndefined();
  });

  it('does not count a manual task from a daemon that cannot say the run waits on the user', async () => {
    const { api, send, close } = daemon('off');
    const follower = await run(api, ['--unattended']);

    send(waits(byHand));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
  });

  it('waits at Act for a supervisor turn in flight, and for the wake an idle run owes, before it returns', async () => {
    const { api, send } = daemon('act');
    const follower = await run(api, ['--unattended']);

    send(turn('w1'), update(waitingOnUser, byHand));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(follower.returned()).toBe(false);

    send(turn('w1', true));
    // The merge window of a wake the idle run owes has not passed.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(follower.returned()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
  });

  it('waits at Act for the supervisor\'s turn on a hold that stands beside the manual task', async () => {
    const { api, send } = daemon('act');
    const follower = await run(api, ['--unattended']);

    send(update(waitingOnUser, held, byHand));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(follower.returned()).toBe(false);

    send(turn('w1'), turn('w1', true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(written.join('')).toContain('· Waits on a person: #1 Rotate the API key: A manual task: it is yours to do, and to mark complete.\n');
  });

  it('returns 3 when it joins a run that already waits on the user', async () => {
    const { api, send } = daemon('watch');
    const follower = await run(api, ['--unattended']);

    // A second `ordewell run --unattended` on the same session joins the run as it stands.
    send({ type: 'run_snapshot', sessionId: 's1', view: { tasks: [], runMerge: null, handoff: null, mergeResult: null, activity: waitingOnUser, escalations: [byHand] } });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
  });

  it('changes nothing without the flag: the manual task is named, and waited for', async () => {
    const { api, send, close } = daemon('watch');
    const follower = await run(api);

    send(update(waitingOnUser, byHand));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(follower.returned()).toBe(false);
    expect(written.join('')).toContain('· Yours to do: #1 Rotate the API key: a manual task:');
    close();
    await follower.done;
    expect(process.exitCode).toBeUndefined();
  });
});

/** A task's own wait as the daemon lists it: its task is awaiting the user, and nothing but a person moves it on. */
const ownWait = (kind: 'conflict' | 'landing-failed' | 'files-changed' | 'usage-limit', reason: string, options: Escalation['options']): Escalation => ({
  id: `${kind}:t1:1`, kind, task: { id: 't1', ref: '#1', title: 'Migrate the schema' }, attempt: 1, reason, options,
});
const SKIP_OPTION = { id: 'skip', label: 'Skip', note: 'optional' } as const;
const RETRY_OPTION = { id: 'retry', label: 'Retry' } as const;
const conflict = ownWait('conflict', 'Its work could not land: it conflicts with what landed before it.', [{ id: 'resolve-conflict', label: 'Add a resolver task' }, RETRY_OPTION, SKIP_OPTION]);
const landingFailed = ownWait('landing-failed', 'It passed, but git refused to land its work, which is kept. Fix what git said, then land it.', [{ id: 'land', label: 'Land its work' }, RETRY_OPTION, SKIP_OPTION]);
const filesChanged = ownWait('files-changed', 'It changed tracked files in your checkout, and nothing was committed.', [RETRY_OPTION, SKIP_OPTION, { id: 'complete', label: 'Mark complete', confirm: 'Mark it complete?' }]);
const usageLimit = ownWait('usage-limit', 'Paused on its runner\'s usage limit, with no resume scheduled.', [{ id: 'resume', label: 'Resume now', note: 'optional' }, SKIP_OPTION]);
const failed: Escalation = {
  id: 'failed:f2:1', kind: 'failed', task: { id: 'f2', ref: '#2', title: 'Seed the data' }, attempt: 1, reason: 'It broke.', options: [RETRY_OPTION, SKIP_OPTION],
};

/** The line each says as it is listed: what waits, on which task, and what answers it. */
const OWN_WAITS: [string, Escalation, string][] = [
  ['a landing conflict', conflict, '· Landing conflict: #1 Migrate the schema: Its work could not land: it conflicts with what landed before it: `ordewell tui`, then `/inbox`, answers it, or `ordewell retry 1` or `ordewell skip 1` releases it and what needs it.'],
  ['a landing git refused', landingFailed, '· Landing refused: #1 Migrate the schema: It passed, but git refused to land its work, which is kept. Fix what git said, then land it: `ordewell tui`, then `/inbox`, answers it, and so does `ordewell continue 1 "<message>"` without it, which lands the kept work and runs nothing again, the message unread; or `ordewell retry 1` or `ordewell skip 1` releases it and what needs it.'],
  ['an ops task that changed tracked files', filesChanged, '· Changed your checkout: #1 Migrate the schema: It changed tracked files in your checkout, and nothing was committed: `ordewell tui`, then `/inbox`, answers it, or `ordewell retry 1`, `ordewell complete 1` or `ordewell skip 1` releases it and what needs it.'],
  ['a usage limit with no reset time', usageLimit, '· Usage limit: #1 Migrate the schema: Paused on its runner\'s usage limit, with no resume scheduled: `ordewell tui`, then `/inbox`, answers it, and so does `ordewell continue 1 "<message>"` without it, which resumes its saved session with the message; or `ordewell skip 1` releases it and what needs it.'],
];

describe('ordewell run --unattended when a task\'s own wait holds the run', () => {
  describe.each(OWN_WAITS)('on %s', (_what, wait, line) => {
    it.each<SupervisorLevel>(['off', 'watch'])('returns 3 at %s once the wait stands, saying what waits and what answers it', async (level) => {
      const { api, send } = daemon(level);
      const follower = await run(api, ['--unattended']);

      send(update(waitingOnUser, wait));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(follower.returned()).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(follower.returned()).toBe(true);
      await follower.done;
      expect(process.exitCode).toBe(RUN_WAITS_EXIT);
      expect(api.endExecutionStream).toHaveBeenCalledWith('s1');
      const out = written.join('');
      expect(out).toContain(`${line} Nobody answers it unattended: it waits until someone does. \`ordewell supervisor act\` lets the supervisor answer in new sessions.\n`);
      expect(out).toContain(`· Waits on a person: #1 Migrate the schema: ${wait.reason.replace(/[.\s]+$/, '')}.\n`);
    });

    it('returns 3 at Act only after a supervisor turn begun once the wait stood has ended', async () => {
      const { api, send } = daemon('act');
      const follower = await run(api, ['--unattended']);

      // A turn begun before the wait is not its turn, though it ends after it.
      send(turn('w0'), update(waitingOnUser, wait), turn('w0', true));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(follower.returned()).toBe(false);
      expect(written.join('')).toContain(`${line} The supervisor has been woken to answer it.\n`);

      // Never while its turn runs.
      send(turn('w1'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(follower.returned()).toBe(false);

      send(turn('w1', true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(follower.returned()).toBe(true);
      await follower.done;
      expect(process.exitCode).toBe(RUN_WAITS_EXIT);
    });

    it('returns 3 beside a failed task, which alone would end the run', async () => {
      const { api, send } = daemon('watch');
      const follower = await run(api, ['--unattended']);

      send(update(waitingOnUser, wait, failed));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(follower.returned()).toBe(true);
      await follower.done;
      expect(process.exitCode).toBe(RUN_WAITS_EXIT);
    });
  });

  it('names no continue for a usage limit whose task has no saved session to resume, which core refuses', async () => {
    const { api, send } = daemon('watch');
    const follower = await run(api, ['--unattended']);

    // What core lists when the paused task cannot be continued: a retry, not a resume.
    send(update(waitingOnUser, { ...usageLimit, options: [RETRY_OPTION, SKIP_OPTION] }));
    await vi.advanceTimersByTimeAsync(5_000);
    await follower.done;

    const out = written.join('');
    expect(out).toContain('· Usage limit: #1 Migrate the schema: Paused on its runner\'s usage limit, with no resume scheduled: `ordewell tui`, then `/inbox`, answers it, or `ordewell retry 1` or `ordewell skip 1` releases it and what needs it.');
    expect(out).not.toContain('ordewell continue');
  });

  it.each<SupervisorLevel>(['off', 'watch', 'act'])('keeps following at %s a run held on a usage limit that has a reset time: it resumes by itself', async (level) => {
    const { api, send, close } = daemon(level);
    const follower = await run(api, ['--unattended']);

    // Held, the run lists no escalation: the reset resumes the task.
    send({
      type: 'status_update',
      tasks: [{ id: 't1', title: 'Migrate the schema', status: 'awaiting_user', verdict: null, awaitingReason: 'usage-limit', resumeAt: new Date(Date.now() + 3_600_000).toISOString() } as unknown as never],
      activity: { ...waitingOnUser, waitsOnUser: false },
      escalations: [],
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
    expect(process.exitCode).toBeUndefined();
  });

  it.each<[string, Escalation]>([
    ['an approval', { ...input, id: 'approval:t1:1:a1', kind: 'approval', approval: 'a1', reason: 'Its runner asks: run npm publish' }],
    ['a merge gate', { ...byHand, id: 'merge-gate:u1:0', kind: 'merge-gate', reason: 'Waits for Merge all: the work of #0 is not merged into your branch yet.' }],
    ['a task waiting to be started', { ...byHand, id: 'unapproved:u1:0', kind: 'unapproved', reason: 'Added since you approved the plan, so it waits for you to start it.' }],
    ['a task with nothing to run', { ...byHand, id: 'no-prompt:u1:0', kind: 'no-prompt', reason: 'It has no prompt, so there is nothing to run.' }],
  ])('still returns 3 on %s', async (_what, wait) => {
    const { api, send } = daemon('watch');
    const follower = await run(api, ['--unattended']);

    send(update(waitingOnUser, wait));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(follower.returned()).toBe(true);
    await follower.done;
    expect(process.exitCode).toBe(RUN_WAITS_EXIT);
  });

  it.each<[string, Escalation]>([
    ['a failed task', failed],
    ['a loop out of rounds', { ...failed, id: 'out-of-rounds:f2:1', kind: 'out-of-rounds', reason: 'Its loop ran out of rounds: it failed round 3 of 3.' }],
  ])('does not count %s, which ends the run by itself', async (_what, wait) => {
    const { api, send, close } = daemon('watch');
    const follower = await run(api, ['--unattended']);

    send(update(waitingOnUser, wait));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(follower.returned()).toBe(false);
    close();
    await follower.done;
  });
});
