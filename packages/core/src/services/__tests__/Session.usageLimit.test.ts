import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { hitLimit, NOW, RESUME_AT, settled, supervised, task, until } from './supervisorTestKit';
import { taskRowView } from '../../taskRow/view';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('editing a task waiting on a usage-limit reset', () => {
  it('a runner change makes a usage-limit task ready even if its resume was already cancelled', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    await env.session.execute({ command: 'cancel_resume', task: 't1' }, { kind: 'user' });

    await env.session.setTaskRunner('t1', 'codex');

    expect(taskOf(env.session, 't1')!.awaitingReason).toBeUndefined();
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
  });

  it('a moved task waits for a scheduler slot and starts when it becomes free', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { assignedRunner: 'codex' })], {
      settings: { supervisorLevel: 'off' }, plan: { runners: ['claude-code', 'codex'] }, config: { maxParallelSessions: 1 },
    });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    await env.session.execute({ command: 'force_start', task: 't2' }, { kind: 'user' });

    await env.session.setTaskRunner('t1', 'codex');

    expect(taskOf(env.session, 't1')!.status).toBe('pending');
    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().length === 3);
    expect(env.run.runner.spawn.mock.calls[2][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
  });

  it('a moved task starts a fresh session told its files come from the runner it left', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.setTaskRunner('t1', 'codex');

    await until(() => env.run.spawnedIds().length === 2);
    const moved = env.run.runner.spawn.mock.calls[1][0];
    expect(moved.resumeSessionId).toBeUndefined();
    expect(moved.prompt).toContain('## Work carried over');
    expect(moved.prompt).toContain('previous attempt on claude-code');
    expect(taskOf(env.session, 't1')!.carriedFrom).toBeUndefined();
  });

  it('a user model change on the same runner keeps its resume and uses the new model at reset', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.updateTask('t1', { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus' } });

    expect(taskOf(env.session, 't1')!.resumeAt).toBe(RESUME_AT);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(taskRowView(taskOf(env.session, 't1')!).resumes).toBeTruthy();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ runner: 'claude-code', modelId: 'claude-opus-4' });
  });

  it('a runner change leaves the other tasks on the old account waiting until its shared reset', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2), task('t3', 3)], {
      settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 2 },
    });
    hitLimit(env.run.of('t1'));
    hitLimit(env.run.of('t2'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT && taskOf(env.session, 't2')!.resumeAt === RESUME_AT);

    await env.session.setTaskRunner('t1', 'codex');
    await settled();

    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't1']);
    expect(taskOf(env.session, 't2')!.resumeAt).toBe(RESUME_AT);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't1']);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await until(() => env.run.spawnedIds().filter((id) => id === 't2').length === 2);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('t3'));
    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't1', 't2', 't3']);
  });

  it('the runner picker starts the task on a newly admitted runner', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.setTaskRunner('t1', 'codex');

    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
  });

  it('a user runner patch releases its resume and starts on the new runner', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' }, plan: { runners: ['claude-code', 'codex'] } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.updateTask('t1', { assignedRunner: 'codex' });

    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
    await vi.advanceTimersByTimeAsync(1000);
    const status = env.messages.filter((m) => m.type === 'status_update').at(-1)!;
    expect(status.tasks[0].status).toBe('in_progress');
    expect(status.tasks[0].resumeAt).toBeUndefined();
    expect(taskRowView(taskOf(env.session, 't1')!).resumes).toBeNull();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1', 't1']);
  });
});

// ADR-0034: a task on a usage limit keeps the run open, and every surface
// takes execution_complete as the run's end.
describe('a usage-limit pause of the last task at work', () => {
  const ended = (env: Awaited<ReturnType<typeof supervised>>) => env.messages.filter((m) => m.type === 'execution_complete').length;

  it('does not end the run: it ends once, when the plan is done after the reset', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 1 } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    await settled();

    expect(ended(env)).toBe(0);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => env.run.spawnedIds().length === 2);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().length === 3);
    expect(ended(env)).toBe(0);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => ended(env) === 1);
  });

  it('a move to another runner goes on with the plan in the run it paused', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { assignedRunner: 'codex' })], {
      settings: { supervisorLevel: 'off' }, plan: { runners: ['claude-code', 'codex'] }, config: { maxParallelSessions: 1 },
    });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    await settled();

    await env.session.setTaskRunner('t1', 'codex');

    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().length === 3);
    expect(env.run.spawnedIds()[2]).toBe('t2');
    expect(ended(env)).toBe(0);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => ended(env) === 1);
  });
});
