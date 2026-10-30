import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorBody, ExecuteCommandResponse, ExecutionCommand, ExecutionCommandName } from '@ordewell/core';
import { daemonHarness, task } from './daemonHarness';

/**
 * The contract of POST /api/plans/:id/execute-command (ADR-0006, ADR-0029): a
 * body that is any ExecutionCommand reaches the seam as the user, and comes back
 * either as the seam's line (200) or as the one refusal shape (400). Every
 * command kind is driven, so a kind the route cannot carry fails here.
 */

type Harness = ReturnType<typeof daemonHarness>;

let harness: Harness;
afterEach(() => harness?.session.destroy());

function start(): Harness {
  harness = daemonHarness();
  harness.load([task('t1', 1), task('t2', 2)]);
  return harness;
}

/** One sample of every kind, keyed by name so a kind added to the union fails to compile until it is driven here. */
const SAMPLES: { [K in ExecutionCommandName]: Extract<ExecutionCommand, { command: K }> } = {
  run_plan: { command: 'run_plan' },
  run_task: { command: 'run_task', task: 't1' },
  stop_task: { command: 'stop_task', task: 't1' },
  stop_run: { command: 'stop_run' },
  retry_task: { command: 'retry_task', task: 't1', from: 'fresh', message: 'again' },
  message_task: { command: 'message_task', task: 't1', text: 'hello', force: false },
  answer_approval: { command: 'answer_approval', task: 't1', approval: 'nobody', answer: 'deny', note: 'no' },
  merge_all: { command: 'merge_all' },
  skip_task: { command: 'skip_task', task: 't2', reason: 'not needed' },
  force_start: { command: 'force_start', task: 't1' },
  mark_complete: { command: 'mark_complete', task: 't2', confirmed: true },
  mark_not_done: { command: 'mark_not_done', task: 't2', confirmed: true },
  revert_task: { command: 'revert_task', task: 't2', confirmed: true, seen: ['t2'] },
  interrupt_task: { command: 'interrupt_task', task: 't1' },
  force_send_queued: { command: 'force_send_queued', task: 't1', id: 'msg-9' },
  remove_queued: { command: 'remove_queued', task: 't1', id: 'msg-9' },
  cancel_resume: { command: 'cancel_resume', task: 't1' },
  answer_checkpoint: { command: 'answer_checkpoint', task: 't1', answer: 'reject', reason: 'not on production' },
  approve_review: { command: 'approve_review' },
  run_script: { command: 'run_script', title: 'Lint', commands: [['npm', 'run', 'lint']], timeoutMs: 1000, dependencies: ['t1'] },
};

describe('POST /execute-command carries every execution command to the seam as the user', () => {
  it.each(Object.values(SAMPLES))('$command', async (command) => {
    const h = start();
    const execute = vi.spyOn(h.session, 'execute');

    const res = await h.command(command);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(command, { kind: 'user' });
    const body = (await res.json()) as ExecuteCommandResponse | ErrorBody;
    if (res.status === 200) {
      expect(body).toMatchObject({ ok: true, message: expect.any(String) });
    } else {
      // One refusal shape for every command: the seam's words under `error`, and the code a client switches on.
      expect(res.status).toBe(400);
      expect(body).toMatchObject({ error: expect.any(String), code: 'refused' });
      expect((body as ErrorBody).error).not.toBe('');
    }
  });

  it('the commands a user may give are done, and the planner\'s own is refused', async () => {
    const h = start();

    const outcomes: Record<string, number> = {};
    for (const name of ['run_plan', 'stop_run', 'mark_complete', 'mark_not_done', 'skip_task'] as const) {
      outcomes[name] = (await h.command(SAMPLES[name])).status;
    }
    outcomes.run_script = (await h.command(SAMPLES.run_script)).status;

    expect(outcomes).toEqual({ run_plan: 200, stop_run: 200, mark_complete: 200, mark_not_done: 200, skip_task: 200, run_script: 400 });
  });

  it('answers a task\'s payload with the line, where a surface needs more than the line', async () => {
    const h = start();
    await h.command({ command: 'run_plan' });

    const res = await h.command({ command: 'message_task', task: 't1', text: 'use the cache' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, payload: { kind: 'message', id: expect.any(String) } });
  });
});
