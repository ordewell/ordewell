import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '../../models/Execution';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { changeSettings, ctx, hitLimit, NOW, plan, prose, RESUME_AT, settled, supervised, task, until, waitForInput, wokenUp, type Env, type Options } from './supervisorTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { WAKE_UP_RATE } from '../LoopGuards';

const ACT: Options = { settings: { supervisorLevel: 'act' } };

const records = (env: Env): ExecutionRecord[] =>
  env.session.planState!.conversationHistory!.flatMap((e) => (e.execution ? [e.execution] : []));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a wake-up turn at Act', () => {
  it('runs the execution tools without asking, recorded as the supervisor\'s', async () => {
    const env = await wokenUp({ ...ACT, config: { autonomousMode: false } });
    const tools = env.planner.tools();

    const answered = await tools.messageTask!({ task: '1', text: 'use Postgres' }, ctx);
    const stopped = await tools.stopTask!({ task: '2' }, ctx);

    expect(answered.isError).toBeFalsy();
    expect(stopped.isError).toBeFalsy();
    expect(env.run.of('t1').delivered).toContain('use Postgres');
    expect(taskOf(env.session, 't2')!.status).toBe('pending');
    expect(records(env).map((r) => [r.command, r.actor, r.level, r.outcome])).toEqual([
      ['run_plan', 'user', undefined, 'done'],
      ['message_task', 'supervisor', 'act', 'done'],
      ['stop_task', 'supervisor', 'act', 'done'],
    ]);
  });

  it('edits the plan through the recorded edit path, shown as the supervisor\'s', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 with Postgres' } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Task 2 now uses Postgres.'));
    await settled();

    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2 with Postgres');
    const tail = env.session.planState!.conversationHistory!.slice(-2);
    // Committed as the call answered, so it is said ahead of the reply that followed it.
    expect(tail.map((e) => [e.kind, e.content])).toEqual([
      ['supervisor', 'Tasks updated:\n- Updated "Task t2" (prompt)'],
      ['supervisor', 'Task 2 now uses Postgres.'],
    ]);
  });

  it('refuses a whole new plan: the supervisor edits, it does not replan from scratch', async () => {
    const env = await wokenUp(ACT);

    const submit = await env.planner.tools().submitPlan!({ tasks: [{ title: 'Something else' }] }, ctx);

    expect(submit.isError).toBe(true);
    expect(JSON.parse(submit.text).errors[0].message).toMatch(/^A whole new plan is refused in a wake-up turn/);
  });
});

const SUPERVISOR = { kind: 'supervisor', level: 'act' } as const;

const byTitle = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title)!;

describe('tasks the supervisor adds at Act', () => {
  it('are marked as the supervisor\'s, approved to run, and start without the user — an ops task included', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    await env.planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
      { op: 'add', task: { title: 'Restart the service', prompt: 'restart it', ops: true } },
    ] }, ctx);
    env.planner.calls[0].finish(prose('Added a cache and a restart.'));
    await settled();

    const cache = byTitle(env, 'Add a cache');
    const restart = byTitle(env, 'Restart the service');
    expect([cache.addedBy, restart.addedBy]).toEqual(['supervisor', 'supervisor']);
    expect(restart.ops).toBe(true);
    expect(env.session.planState!.approvedTasks).toEqual(expect.arrayContaining([cache.id, restart.id]));
    await until(() => env.run.spawnedIds().includes(cache.id) && env.run.spawnedIds().includes(restart.id));
  });

  it('may be started by the supervisor itself once the run has stopped, where a task the user\'s turn added may not', async () => {
    const env = await wokenUp(ACT, [task('t1', 1)]);
    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);
    env.planner.calls[0].finish(prose('Added a cache.'));
    await settled();
    await env.session.execute({ command: 'stop_run' }, { kind: 'user' });

    const answered = env.session.continueConversation('add a docs task');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish({ kind: 'task_ops', ops: [{ op: 'add', task: { title: 'Write docs', prompt: 'write docs' } }], text: '', researchLog: [] });
    await answered;
    const docs = byTitle(env, 'Write docs');
    expect(docs.addedBy).toBeUndefined();

    expect(await env.session.execute({ command: 'run_task', task: byTitle(env, 'Add a cache').id }, SUPERVISOR)).toMatchObject({ ok: true });
    expect(await env.session.execute({ command: 'run_task', task: docs.id }, SUPERVISOR)).toMatchObject({ ok: false, message: expect.stringMatching(/added after the user approved the plan/) });
    expect(env.run.spawnedIds()).not.toContain(docs.id);
  });

  it('cannot be marked as the supervisor\'s by the planner itself', async () => {
    const env = await wokenUp(ACT, [task('t1', 1)]);
    env.planner.calls[0].finish(prose('Task 1 waits for input.'));
    await settled();

    const answered = env.session.continueConversation('add a docs task');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish({ kind: 'task_ops', ops: [{ op: 'add', task: { title: 'Write docs', prompt: 'write docs', addedBy: 'supervisor' } }], text: '', researchLog: [] });
    await answered;

    const docs = byTitle(env, 'Write docs');
    expect(docs.addedBy).toBeUndefined();
    expect(env.session.planState!.approvedTasks).not.toContain(docs.id);
  });
});

/** Task 1 paused on claude-code's usage limit, and the supervisor woken to it at Act. */
async function limited(tasks = [task('t1', 1), task('t2', 2)], pause: string[] = ['t1']): Promise<Env> {
  const env = await supervised(tasks, {
    ...ACT, plan: { runners: ['claude-code', 'codex'] }, config: { enabledRunners: ['claude-code', 'codex'] },
  });
  for (const id of pause) hitLimit(env.run.of(id));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  expect(taskOf(env.session, 't1')!.resumeAt).toBe(RESUME_AT);
  return env;
}

const moveToOpus = { op: 'update', taskId: '#1', changes: { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus' } } } as const;

describe('moving a task paused on a usage limit', () => {
  it('keeps its scheduled resume when only its model changes on the same runner', async () => {
    const env = await limited();

    await env.planner.tools().editPlan!({ ops: [moveToOpus] }, ctx);
    env.planner.calls[0].finish(prose('Moved task 1 to Opus.'));
    await settled();

    const t1 = taskOf(env.session, 't1')!;
    expect(t1.assignedModel?.modelId).toBe('claude-opus-4');
    expect([t1.status, t1.awaitingReason, t1.resumeAt]).toEqual(['awaiting_user', 'usage-limit', RESUME_AT]);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await settled();
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    expect(env.run.runner.spawn.mock.calls.at(-1)![0].modelId).toBe('claude-opus-4');
  });

  it('leaves the resume of every other paused task alone, with nothing else running', async () => {
    const env = await limited([task('t1', 1), task('t2', 2)], ['t1', 't2']);
    expect(env.session.isExecuting).toBe(false);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { assignedRunner: 'codex' } }] }, ctx);
    expect(edit.isError, edit.text).toBeFalsy();
    env.planner.calls[0].finish(prose('Moved task 1 to Codex.'));
    await settled();

    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    expect(env.run.runner.spawn.mock.calls.at(-1)![0]).toMatchObject({ taskId: 't1', runner: 'codex' });
    expect(taskOf(env.session, 't2')!.resumeAt).toBe(RESUME_AT);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await until(() => env.run.spawnedIds().filter((id) => id === 't2').length === 2);
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(2);
  });
});

/**
 * The supervisor woken at Act on a plan that once used Codex, the user having
 * switched Codex off since: the plan's runners still hold it, the enabled list
 * does not. Tasks 2 and 3 wait on task 1, and task 3 is left on Codex.
 */
async function codexSwitchedOff(): Promise<Env> {
  return wokenUp(
    { ...ACT, plan: { runners: ['codex', 'claude-code'] }, config: { enabledRunners: ['claude-code', 'opencode'] } },
    [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { assignedRunner: 'codex', dependencies: ['t1'] })],
  );
}

describe('the supervisor\'s edits after a runner is switched off that the plan once used', () => {
  it.each<[string, { op: 'add'; task: Record<string, unknown> } | { op: 'update'; taskId: string; changes: Record<string, unknown> }]>([
    ['an added task naming it', { op: 'add', task: { title: 'Fix the import', prompt: 'fix it', assignedRunner: 'codex' } }],
    ['a task moved onto it', { op: 'update', taskId: '#2', changes: { assignedRunner: 'codex' } }],
  ])('refuse %s, and change nothing', async (_name, op) => {
    const env = await codexSwitchedOff();

    const edit = await env.planner.tools().editPlan!({ ops: [op] }, ctx);
    env.planner.calls[0].finish(prose('That did not work.'));
    await settled();

    expect(edit.isError).toBe(true);
    expect(JSON.parse(edit.text).errors[0].message).toMatch(/invalid assignedRunner "codex"\. Expected one of: claude-code, opencode/);
    expect(env.session.planTasks.map((t) => [t.title, t.assignedRunner])).toEqual([['Task t1', 'claude-code'], ['Task t2', 'claude-code'], ['Task t3', 'codex']]);
  });

  it('put an added task that names no runner on an enabled one, as the supervisor\'s', async () => {
    const env = await codexSwitchedOff();

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Fix the import', prompt: 'fix it' } }] }, ctx);
    env.planner.calls[0].finish(prose('Added a fix.'));
    await settled();

    expect(edit.isError, edit.text).toBeFalsy();
    expect(byTitle(env, 'Fix the import')).toMatchObject({ assignedRunner: 'claude-code', addedBy: 'supervisor' });
  });

  it('still edit the task left on it and move it off', async () => {
    const env = await codexSwitchedOff();

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#3', changes: { prompt: 'do t3 with Postgres' } }] }, ctx);
    const move = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#3', changes: { assignedRunner: 'opencode' } }] }, ctx);
    env.planner.calls[0].finish(prose('Updated task 3.'));
    await settled();

    expect(edit.isError, edit.text).toBeFalsy();
    expect(move.isError, move.text).toBeFalsy();
    expect(taskOf(env.session, 't3')).toMatchObject({ prompt: 'do t3 with Postgres', assignedRunner: 'opencode' });
  });
});

const notes = (env: Env) => env.session.planState!.conversationHistory!.filter((e) => e.kind === 'supervisor').map((e) => e.content);

/** A one-task run whose task failed, with the supervisor woken to it at Act. */
async function failedOnce(over: Options['settings'] = {}): Promise<Env> {
  const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act', ...over } });
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.planner.calls.length === 1);
  return env;
}

/** A two-task run that finished with task 2 failed, the supervisor woken to it at Act. */
async function finishedWithAFailure(): Promise<Env> {
  const env = await supervised([task('t1', 1), task('t2', 2)], ACT);
  env.run.of('t1').reportComplete({ status: 'done', summary: '' });
  await until(() => taskOf(env.session, 't1')!.status === 'completed');
  env.run.of('t2').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.planner.calls.length === 1);
  expect(env.planner.calls[0].message).toMatch(/the run finished: 1 of 2 tasks completed, 1 failed/);
  return env;
}

/** The next wake-up turn, on task 1 failing again. */
async function failsAgain(env: Env, calls: number): Promise<void> {
  await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === calls);
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'still wrong' });
  await until(() => env.planner.calls.length === calls);
}

describe('the loop guards', () => {
  it('refuses a retry past the user\'s retry limit, and escalates the task to the user once', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 1 });
    const first = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);
    expect(first.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Retried task 1 with a fix.'));
    await failsAgain(env, 2);

    const second = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'try harder' }, ctx);
    const third = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'once more' }, ctx);

    expect(JSON.parse(second.text).reason).toBe('Refused by the retry limit: you have retried task #1 "Task t1" once this run, the most your settings allow. It is escalated to the user now: tell them what you tried, and do not retry it again.');
    expect(third.isError).toBe(true);
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(2);
    expect(notes(env).filter((n) => n.startsWith('Loop guard, retry limit'))).toEqual([
      'Loop guard, retry limit: I retried task #1 "Task t1" once this run, the most your settings allow, and stopped. It needs you: retry it, change it or skip it.',
    ]);
  });

  it('takes a retry limit raised in this session at once', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 0 });
    const refused = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);

    changeSettings(env, { supervisorRetryLimit: 1 });
    const retried = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);

    expect(refused.isError).toBe(true);
    expect(retried.isError).toBeFalsy();
  });

  it('counts retries across the runs the supervisor restarts itself, and starts afresh when the user starts', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 1 });
    await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await failsAgain(env, 2);
    env.planner.calls[1].finish(prose('Task 1 failed again.'));
    await settled();

    await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' });
    await failsAgain(env, 3);

    expect((await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'and again' }, ctx)).isError).toBeFalsy();
  });

  it('refuses a retry after a failure with the prompt and model unchanged: change something or escalate', async () => {
    const env = await failedOnce();

    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);

    expect(retry.isError).toBe(true);
    expect(JSON.parse(retry.text).reason).toMatch(/^Refused: task #1 "Task t1" failed with this same prompt and model.*Change something or escalate/);
    expect(notes(env)).toContainEqual(expect.stringMatching(/^Loop guard, identical retry: I tried to retry task #1 "Task t1" unchanged/));
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  // ADR-0022 P2: the edit is in the plan as its call answers, so the retry that follows it is handed to the run as edited,
  // at once; the run starts it once the turn's start hold lets go (ADR-0029).
  it('hands a retry asked for after an edit in the same reply to the run at once, as edited', async () => {
    const env = await failedOnce();

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);

    expect(JSON.parse(retry.text).result).toBe('Task #1 "Task t1" is back in the run and starts when a slot is free.');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
    env.planner.calls[0].finish(prose('Fixed the import in task 1 and retried it.'));
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0].prompt).toContain('do t1, importing from ./lib');
    expect(env.session.planState!.conversationHistory!.filter((e) => e.kind === 'execution').at(-1)).toMatchObject({ content: 'Retried task #1 "Task t1": by supervisor.' });
  });

  it('keeps an edit and the retry it ran when the user stops their turn after them', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' }, config: { autonomousMode: true } });
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await until(() => taskOf(env.session, 't1')!.status === 'failed');
    const answered = env.session.continueConversation('fix the import in task 1 and retry it');
    await until(() => env.planner.calls.length === 1);

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    expect((await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx)).isError).toBeFalsy();
    env.session.abortPlannerTurn();
    await answered.catch(() => undefined);
    await until(() => env.run.spawnedIds().length === 2);

    expect(taskOf(env.session, 't1')!.prompt).toBe('do t1, importing from ./lib');
    expect(env.run.runner.spawn.mock.calls[1][0].prompt).toContain('do t1, importing from ./lib');
    expect(env.notices.filter((n) => n.message.startsWith('Not done:'))).toEqual([]);
  });

  it('keeps an edit a wake-up turn committed when the user stops that turn', async () => {
    const env = await failedOnce();

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    env.session.abortPlannerTurn();
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ prompt: 'do t1, importing from ./lib', status: 'failed' });
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('commits nothing a wake-up turn edits after another plan was adopted under it', async () => {
    const env = await failedOnce();

    env.session.loadPlan(plan([task('t1', 1, { status: 'failed' })]), 'another goal', testWorkspace, { sessionId: 'other' });
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);
    env.planner.calls[0].finish(prose('Fixed the import in task 1 and retried it.'));
    await settled();

    expect(edit.isError).toBe(true);
    expect(retry.isError).toBe(true);
    expect(taskOf(env.session, 't1')!.prompt).toBe('do t1');
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('refuses at once, not after the turn, a retry behind an edit that could never run: the task was added after the user approved the plan', async () => {
    const env = await finishedWithAFailure();
    env.session.planState!.approvedTasks = ['t1'];

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '2', from: 'fresh' }, ctx);

    expect(retry.isError).toBe(true);
    expect(JSON.parse(retry.text).reason).toBe('Task #2 "Task t2" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.');
  });

  it('runs a retry after an edit as edited, on a run that had already finished', async () => {
    const env = await finishedWithAFailure();

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '2', from: 'fresh' }, ctx);
    expect(retry.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Fixed the import in task 2 and retried it.'));

    await until(() => env.run.spawnedIds().length === 3);
    expect(env.run.runner.spawn.mock.calls[2][0].prompt).toContain('do t2, importing from ./lib');
  });

  it('starts at once a task its own edit adds, asked for by title in the same reply, on a run that had finished', async () => {
    const env = await finishedWithAFailure();

    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Fix the import', prompt: 'fix the import' } }] }, ctx);
    const start = await env.planner.tools().runTask!({ task: 'Fix the import' }, ctx);
    expect(start.isError, start.text).toBeFalsy();
    expect(JSON.parse(start.text).result).toMatch(/^Started task #\d+ "Fix the import"\.$/);

    await until(() => env.session.planTasks.some((t) => t.title === 'Fix the import' && env.run.spawnedIds().includes(t.id)));
    expect(env.run.runner.spawn.mock.calls.at(-1)![0].prompt).toContain('fix the import');
  });

  it('refuses at once a retry behind an edit that leaves the prompt and model as they failed', async () => {
    const env = await failedOnce();

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { title: 'Fix the import' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);

    expect(retry.isError).toBe(true);
    expect(JSON.parse(retry.text).reason).toMatch(/^Refused: task #1 "Fix the import" failed with this same prompt and model/);
  });

  it('runs a retry after an edit in the user\'s own turn as edited', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' }, config: { autonomousMode: true } });
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await until(() => taskOf(env.session, 't1')!.status === 'failed');
    void env.session.continueConversation('fix the import in task 1 and retry it');
    await until(() => env.planner.calls.length === 1);

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);
    expect(retry.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Fixed the import in task 1 and retried it.'));

    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0].prompt).toContain('do t1, importing from ./lib');
  });

  it('refuses re-adding a task it removed this run, and undoing its own edit', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] })]);
    await env.planner.tools().editPlan!({ ops: [{ op: 'remove', taskId: '#3' }, { op: 'update', taskId: '#2', changes: { prompt: 'do t2 with Postgres' } }] }, ctx);
    env.planner.calls[0].finish(prose('Dropped task 3; task 2 uses Postgres.'));
    await settled();
    await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    const readd = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Task t3', prompt: 'do t3' } }] }, ctx);
    const revert = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2' } }] }, ctx);

    expect(JSON.parse(readd.text).errors[0].message).toMatch(/^Edit refused: it re-adds "task t3", which you removed earlier this run/);
    expect(JSON.parse(revert.text).errors[0].message).toMatch(/^Edit refused: it changes the prompt of "Task t2" back to what it was before your own earlier edit/);
    expect(notes(env).filter((n) => n.startsWith('Loop guard, oscillating edits'))).toHaveLength(2);
    env.planner.calls[1].finish(prose('I would undo that, but it needs you.'));
    await settled();
    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2 with Postgres');
  });

  it('drops the run to Watch when it keeps waking with nothing passing, with a notice', async () => {
    const env = await supervised([task('t1', 1)], ACT);
    for (let i = 0; i < WAKE_UP_RATE.max + 1; i++) {
      waitForInput(env.run.of('t1'));
      await settled();
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
      await until(() => env.planner.calls.length === i + 1);
      if (i === WAKE_UP_RATE.max) break;
      env.planner.calls[i].finish(prose('Answered task 1.'));
      await settled();
      await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    }

    expect(env.planner.calls.at(-1)!.message).toMatch(/At Watch you only suggest/);
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
    expect(env.settings.supervisorLevel).toBe('act');
    expect(env.notices).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringMatching(/^Loop guard, wake-up rate: /) }));
    expect(notes(env)).toContainEqual(expect.stringMatching(/^Loop guard, wake-up rate: I woke 7 times .* with no task passing.*Watch for the rest of this run/));
  });
});

describe('a failure at Act (ADR-0034)', () => {
  it('ends the run with the failed task\'s dependent blocked, and a retry after an edit runs the dependent once it passes', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], ACT);
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/failed: .*the import is wrong; it blocks task #2 "Task t2"/);

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);
    env.planner.calls[0].finish(prose('Fixed the import in task 1 and retried it.'));
    await until(() => env.run.spawnedIds().length === 2);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });

    await until(() => env.run.spawnedIds().includes('t2'));
    expect(env.run.spawnedIds()).toEqual(['t1', 't1', 't2']);
  });
});

describe('merge_all as a planner tool', () => {
  /** An Act run whose change task landed, its ops task waiting at the gate, and the supervisor woken by task 3. */
  async function gated() {
    const isolation = new FakeWorktreeIsolation();
    const tasks = [task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] }), task('t3', 3)];
    const env = await supervised(tasks, { ...ACT, isolation, config: { worktreeIsolation: true } });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.session.mergeGate('o2').length === 1);
    waitForInput(env.run.of('t3'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    return { ...env, merges: () => isolation.calls.filter((c) => c.op === 'mergeIntoCheckedOut').length };
  }

  it('merges in a wake-up turn at Act, and the gate opens', async () => {
    const env = await gated();

    const merged = await env.planner.tools().mergeAll!({}, ctx);

    expect(merged.isError).toBeFalsy();
    expect(env.merges()).toBe(1);
    expect(env.session.mergeGate('o2')).toEqual([]);
  });

  it('is refused in the user\'s own turn: they press Merge all themselves', async () => {
    const env = await gated();
    env.planner.calls[0].finish(prose('Task 3 waits for input.'));
    await settled();

    void env.session.continueConversation('merge it for me');
    await until(() => env.planner.calls.length === 2);
    const merge = await env.planner.tools().mergeAll!({}, ctx);

    expect(merge.isError).toBe(true);
    expect(JSON.parse(merge.text).reason).toMatch(/^Merge all is the user's/);
    expect(env.merges()).toBe(0);
  });
});

describe('changing the supervisor level mid-run', () => {
  it('to Watch applies at once, in the wake-up turn under way too', async () => {
    const env = await wokenUp(ACT);

    changeSettings(env, { supervisorLevel: 'watch' });
    const stop = await env.planner.tools().stopTask!({ task: '2' }, ctx);
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 better' } }] }, ctx);

    expect(JSON.parse(stop.text).reason).toMatch(/You are the supervisor at Watch/);
    expect(JSON.parse(edit.text).errors[0].message).toMatch(/you are the supervisor at Watch/);
    expect(taskOf(env.session, 't2')!.status).toBe('in_progress');
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
    expect(env.session.planState!.conversationHistory!).toContainEqual(expect.objectContaining({ kind: 'system', content: 'You set the supervisor to Watch.' }));
  });

  it('off stops the wake-ups; what was gathered reaches the planner with the user\'s next message', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], ACT);
    waitForInput(env.run.of('t1'));
    await settled();

    changeSettings(env, { supervisorLevel: 'off' });
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(env.planner.calls).toHaveLength(0);
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('off');

    void env.session.continueConversation('what is waiting?');
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/Run update:\n- task #1 "Task t1" is waiting for input[\s\S]*what is waiting\?$/);
    expect(env.planner.calls[0].message).not.toMatch(/task #2/);
  });

  it('to Act applies at once: the next wake-up turn may act', async () => {
    const env = await wokenUp({ settings: { supervisorLevel: 'watch' } });
    env.planner.calls[0].finish(prose('Task 1 waits for you.'));
    await settled();

    changeSettings(env, { supervisorLevel: 'act' });
    env.run.of('t2').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);
    const stop = await env.planner.tools().stopTask!({ task: '1' }, ctx);

    expect(env.planner.calls[1].message).toMatch(/At Act you may act/);
    expect(stop.isError).toBeFalsy();
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('act');
  });

  it('with no run under way, changes nothing on the plan: the next run reads the saved setting', () => {
    const idle = makeSession({});
    idle.loadPlan(plan([task('t1', 1)]), 'build it', testWorkspace, { persist: false });

    expect(() => idle.applyRunSettings({ supervisorLevel: 'act' })).not.toThrow();
    expect(idle.planState!.runSettings).toBeUndefined();
  });
});

describe('skip_task at Act', () => {
  /** Task 1 failed and blocks task 2; the supervisor is woken to it at Act. */
  async function blockedChain(over: Options['settings'] = {}): Promise<Env> {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'act', ...over } });
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the host has no GPU' });
    await until(() => env.planner.calls.length === 1);
    return env;
  }

  it('skips the failed task with its reason: the timeline shows it, and the dependent is told it', async () => {
    const env = await blockedChain();

    const skip = await env.planner.tools().skipTask!({ task: '1', reason: 'the host has no GPU, and task 2 does not need its output' }, ctx);
    expect(skip.isError, skip.text).toBeFalsy();
    env.planner.calls[0].finish(prose('Skipped task 1.'));

    await until(() => env.run.spawnedIds().includes('t2'));
    expect(taskOf(env.session, 't1')!.status).toBe('skipped');
    expect(records(env).at(-1)).toMatchObject({ command: 'skip_task', actor: 'supervisor', outcome: 'done', detail: 'the host has no GPU, and task 2 does not need its output' });
    expect(env.run.runner.spawn.mock.calls.at(-1)![0].prompt).toContain('- Skipped: the host has no GPU, and task 2 does not need its output. None of its work landed');
  });

  it('counts a skip of a task it retried against the retry limit: past it, the task is the user\'s', async () => {
    const env = await blockedChain({ supervisorRetryLimit: 1 });
    await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'use the CPU build' }, ctx);
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await failsAgain(env, 2);

    const skip = await env.planner.tools().skipTask!({ task: '1', reason: 'it cannot run here' }, ctx);

    expect(skip.isError).toBe(true);
    expect(JSON.parse(skip.text).reason).toBe('Refused by the retry limit: you have retried task #1 "Task t1" once this run, the most your settings allow, and a skip of a task you retried counts as one more. It is escalated to the user now: tell them what you tried, and leave skipping it to them.');
    expect(taskOf(env.session, 't1')!.status).toBe('failed');
  });

  it('lets a skip of a task it retried through under the limit, and then counts it', async () => {
    const env = await blockedChain({ supervisorRetryLimit: 2 });
    await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'use the CPU build' }, ctx);
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await failsAgain(env, 2);

    expect((await env.planner.tools().skipTask!({ task: '1', reason: 'it cannot run here' }, ctx)).isError).toBeFalsy();
    expect(env.session.planState!.supervision?.guards?.skips).toEqual({ t1: 1 });
  });

  it('refuses a skip of a task its own edit adds in the same reply, which waits on nothing', async () => {
    const env = await blockedChain();

    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Probe the GPU', prompt: 'probe it' } }] }, ctx);
    const skip = await env.planner.tools().skipTask!({ task: 'Probe the GPU', reason: 'not needed' }, ctx);

    expect(skip.isError).toBe(true);
    expect(JSON.parse(skip.text).reason).toBe('Task #3 "Probe the GPU" has not started and nothing blocks it: the supervisor skips only a task that failed, is blocked or is waiting for input.');
  });

  it('never runs a skipped task again: that is the user\'s to decide', async () => {
    const env = await blockedChain();
    await env.planner.tools().skipTask!({ task: '1', reason: 'it cannot run here' }, ctx);

    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);

    expect(retry.isError).toBe(true);
    expect(JSON.parse(retry.text).reason).toBe('Task #1 "Task t1" was skipped: whether it runs again is the user\'s to decide. Tell them if it should.');
  });
});

describe('answer_checkpoint at Act', () => {
  /** Task 1's runner stopped at a checkpoint; the supervisor is woken to it at Act. */
  async function atCheckpoint(over: Options['settings'] = {}) {
    const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: 'act', ...over } });
    const answer = env.run.of('t1').callCheckpoint('Another process is editing this worktree. Carry on?');
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    return { env, answer };
  }

  it('is woken by the checkpoint, approves it, and the runner goes on', async () => {
    const { env, answer } = await atCheckpoint();
    expect(env.planner.calls[0].message).toContain('at a checkpoint: Another process is editing this worktree. Carry on?');

    const approved = await env.planner.tools().answerCheckpoint!({ task: '1', answer: 'approve' }, ctx);
    env.planner.calls[0].finish(prose('It was my own tool; I approved it.'));

    expect(approved.isError, approved.text).toBeFalsy();
    await expect(answer).resolves.toEqual({ kind: 'continue' });
    expect(taskOf(env.session, 't1')!.status).toBe('in_progress');
    expect(records(env).at(-1)).toMatchObject({ command: 'answer_checkpoint', actor: 'supervisor', level: 'act', outcome: 'done', task: { ref: '#1' } });
  });

  it('rejects it with a reason the runner is told', async () => {
    const { env, answer } = await atCheckpoint();

    const rejected = await env.planner.tools().answerCheckpoint!({ task: '1', answer: 'reject', reason: 'Stop, and tell the user: someone else is editing this worktree.' }, ctx);

    expect(rejected.isError, rejected.text).toBeFalsy();
    await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'Stop, and tell the user: someone else is editing this worktree.' });
    expect(records(env).at(-1)).toMatchObject({ command: 'answer_checkpoint', actor: 'supervisor', outcome: 'done', detail: 'Stop, and tell the user: someone else is editing this worktree.' });
  });

  it('leaves it waiting when the supervisor is lowered to Watch before it answers, and says the user answers', async () => {
    const { env } = await atCheckpoint();
    changeSettings(env, { supervisorLevel: 'watch' });

    const approved = await env.planner.tools().answerCheckpoint!({ task: '1', answer: 'approve' }, ctx);

    expect(approved.isError).toBe(true);
    expect(JSON.parse(approved.text).reason).toMatch(/^You are the supervisor at Watch: you read and suggest, and cannot answer a checkpoint\. The user answers it from the task's checkpoint card/);
    expect(env.session.awaitsCheckpoint('t1')).toBe(true);
  });
});
