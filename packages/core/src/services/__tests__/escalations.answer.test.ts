import { describe, expect, it, vi } from 'vitest';
import { ExecutionCommands, type ExecutionCommand, type ExecutionHost } from '../ExecutionCommands';
import type { Escalation, EscalationOptionId } from '../escalations';

/**
 * `answerEscalation` at the seam (ADR-0053): whichever option is chosen, it
 * comes to the existing command for that wait, as the user. Every option is
 * driven, so one with no route fails here; what each command then checks has
 * its own tests.
 */

const TASK = { id: 't1', ref: '#1', title: 'Task t1' };

const live = (over: Partial<Escalation>): Escalation => ({
  id: 'e1', kind: 'failed', task: TASK, attempt: 1, reason: 'It failed.', options: [], ...over,
});

function setup(list: Escalation[], over: Partial<ExecutionHost> = {}) {
  const host = {
    escalations: () => list,
    resolveConflict: vi.fn(async () => true),
    continueRun: vi.fn(async () => {}),
    ...over,
  } as unknown as ExecutionHost;
  const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });
  const run = vi.spyOn(commands, 'run').mockResolvedValue({ ok: true, message: 'done' });
  return { commands, run, host };
}

const CASES: { [K in EscalationOptionId]?: [Partial<Escalation>, string | undefined, ExecutionCommand] } = {
  allow: [{ kind: 'approval', approval: 'ap-1' }, undefined, { command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'allow' }],
  'allow-for-task': [{ kind: 'approval', approval: 'ap-1' }, undefined, { command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'allowForTask' }],
  deny: [{ kind: 'approval', approval: 'ap-1' }, 'use the test database', { command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'deny', note: 'use the test database' }],
  approve: [{ kind: 'checkpoint' }, undefined, { command: 'answer_checkpoint', task: 't1', answer: 'approve' }],
  reject: [{ kind: 'checkpoint' }, 'not on production', { command: 'answer_checkpoint', task: 't1', answer: 'reject', reason: 'not on production' }],
  reply: [{ kind: 'input' }, 'use port 8080', { command: 'message_task', task: 't1', text: 'use port 8080' }],
  resume: [{ kind: 'usage-limit' }, undefined, { command: 'retry_task', task: 't1', from: 'session' }],
  continue: [{ kind: 'failed' }, 'fix the lint too', { command: 'retry_task', task: 't1', from: 'session', message: 'fix the lint too' }],
  retry: [{ kind: 'failed' }, undefined, { command: 'retry_task', task: 't1', from: 'fresh' }],
  run: [{ kind: 'unapproved' }, undefined, { command: 'run_task', task: 't1' }],
  'force-start': [{ kind: 'on-hold' }, undefined, { command: 'force_start', task: 't1' }],
  skip: [{ kind: 'failed' }, 'not needed', { command: 'skip_task', task: 't1', reason: 'not needed' }],
  complete: [{ kind: 'by-hand' }, undefined, { command: 'mark_complete', task: 't1', confirmed: true }],
  'merge-all': [{ kind: 'merge-all', task: undefined }, undefined, { command: 'merge_all' }],
};

describe('answerEscalation', () => {
  it.each(Object.entries(CASES))('%s reaches its command as the user', async (option, [over, note, command]) => {
    const { commands, run } = setup([live({ ...over, options: [{ id: option as EscalationOptionId, label: option }] })]);

    expect(await commands.answerEscalation('e1', option, note)).toEqual({ ok: true, message: 'done' });

    expect(run.mock.calls).toEqual([[command, { kind: 'user' }]]);
  });

  it('adds a resolver task for a conflict, which no command at the seam does', async () => {
    const { commands, run, host } = setup([live({ kind: 'conflict', options: [{ id: 'resolve-conflict', label: 'Add a resolver task' }] })]);

    expect(await commands.answerEscalation('e1', 'resolve-conflict')).toEqual({ ok: true, message: 'Added a task that resolves the conflict of task #1 "Task t1".' });

    expect(host.resolveConflict).toHaveBeenCalledWith('t1');
    expect(run).not.toHaveBeenCalled();
  });

  it('says so when there was no conflict left to resolve', async () => {
    const { commands } = setup([live({ kind: 'conflict', options: [{ id: 'resolve-conflict', label: 'Add a resolver task' }] })], { resolveConflict: async () => false });

    expect(await commands.answerEscalation('e1', 'resolve-conflict')).toEqual({ ok: false, outcome: 'refused', message: 'Task #1 "Task t1" has no conflict left to resolve.' });
  });

  it.each([['stash', 'stash', 'Stashed your changes: the run goes on.'], ['run-without-isolation', 'shared', 'The run goes on without isolation, this once.']])('%s continues a blocked run', async (option, how, message) => {
    const { commands, host } = setup([live({ kind: 'blocked-run', task: undefined, options: [{ id: option as EscalationOptionId, label: option }] })]);

    expect(await commands.answerEscalation('e1', option)).toEqual({ ok: true, message });

    expect(host.continueRun).toHaveBeenCalledWith(how);
  });

  it('turns a failed continue of a blocked run into its refusal', async () => {
    const { commands } = setup([live({ kind: 'blocked-run', task: undefined, options: [{ id: 'stash', label: 'Stash' }] })], { continueRun: async () => { throw new Error('git refused the stash'); } });

    expect(await commands.answerEscalation('e1', 'stash')).toEqual({ ok: false, outcome: 'refused', message: 'git refused the stash' });
  });

  it('refuses an id no longer live, in plain words, and runs nothing', async () => {
    const { commands, run } = setup([live({ id: 'failed:t1:2', options: [{ id: 'retry', label: 'Retry' }] })]);

    expect(await commands.answerEscalation('failed:t1:1', 'retry')).toEqual({ ok: false, outcome: 'refused', message: 'That is no longer waiting on you: it was answered, or the run moved on. Nothing was changed.' });

    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an option this wait does not offer, naming those it does', async () => {
    const { commands, run } = setup([live({ options: [{ id: 'retry', label: 'Retry' }, { id: 'skip', label: 'Skip' }] })]);

    expect(await commands.answerEscalation('e1', 'allow')).toEqual({ ok: false, outcome: 'refused', message: '"allow" is not an answer to this: use "retry" or "skip". Nothing was changed.' });

    expect(run).not.toHaveBeenCalled();
  });

  it('holds back an option with a question until the user\'s yes comes with it', async () => {
    const { commands, run } = setup([live({ options: [{ id: 'complete', label: 'Mark complete', confirm: 'Mark task #1 complete?' }] })]);

    expect(await commands.answerEscalation('e1', 'complete')).toEqual({ ok: false, outcome: 'refused', message: 'Mark task #1 complete? Nothing was changed: it needs your explicit yes.' });
    expect(run).not.toHaveBeenCalled();

    expect(await commands.answerEscalation('e1', 'complete', undefined, true)).toEqual({ ok: true, message: 'done' });
    expect(run).toHaveBeenCalledWith({ command: 'mark_complete', task: 't1', confirmed: true }, { kind: 'user' });
  });

  it('asks the host afresh on every call, so an answer never reads an old list', async () => {
    const list: Escalation[] = [live({ options: [{ id: 'retry', label: 'Retry' }] })];
    const { commands } = setup(list);

    expect(await commands.answerEscalation('e1', 'retry')).toMatchObject({ ok: true });
    list.length = 0;
    expect(await commands.answerEscalation('e1', 'retry')).toMatchObject({ ok: false, outcome: 'refused' });
  });
});
