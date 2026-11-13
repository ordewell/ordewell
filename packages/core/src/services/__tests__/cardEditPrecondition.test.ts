import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { cardEditable, runHoldsEditors } from '../../taskRow';
import type { Session } from '../createSession';
import type { CardEdit } from '../CardEdit';

const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function rig(holdSkills = false) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const s = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(s);
    return s;
  });
  const runner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner;
  const skillGit = deferred<Map<string, string>>();
  const skill = { name: 'cache', description: 'd', metadata: {}, content: '', path: '/s/cache/SKILL.md', source: 'workspace', appliesTo: 'task', modelInvocable: true };
  const session = makeSession({
    runner, scriptRunner: runner, config: fakeConfig({ autonomousMode: true, maxParallelSessions: 3 }),
    ...(holdSkills ? { skillsService: { findSkill: (n: string) => (n === 'cache' ? skill : undefined), uncommitted: () => skillGit.promise } as never } : {}),
  });
  const load = (tasks: Task[]) => {
    const now = new Date().toISOString();
    const p: LegacyPlanState = { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
    session.loadPlan(p, 'goal', testWorkspace, { persist: false });
  };
  return { session, sessions, spawn, skillGit, load };
}

/** What the card shows, from the Session's own facts; the edit's precondition is the Session's alone. */
function held(session: Session): boolean {
  return runHoldsEditors(session.isExecuting, session.activity);
}
const cardEdit = (session: Session, taskId: string, edit: CardEdit) => session.cardEdit(taskId, edit);

describe('a card edit against a real Session', () => {
  it('still reaches the failed task after a run ended on that failure, so it can be fixed and retried', async () => {
    const r = rig();
    r.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await r.session.execute({ command: 'run_plan' }, { kind: 'user' });
    r.sessions.filter((s) => s.taskId === 't1').at(-1)!.reportComplete({ status: 'failed', summary: 'nope' });
    await vi.waitFor(() => expect(taskOf(r.session, 't1')!.status).toBe('failed'));
    await vi.waitFor(() => expect(r.session.activity.running).toBe(false));

    expect(r.session.activity.resumable).toBe(true);
    expect(held(r.session)).toBe(false);
    expect(cardEditable(held(r.session), taskOf(r.session, 't1')!)).toBe(true);
    await cardEdit(r.session, 't1', { kind: 'prompt', prompt: 'fixed' });
    expect(taskOf(r.session, 't1')!.prompt).toBe('fixed');
  });

  it('holds a settled task read-only while the scheduler waits on a manual task', async () => {
    const r = rig();
    r.load([task('t0', 1), task('u1', 2, { type: 'user', dependencies: ['t0'], userSteps: [{ order: 1, instruction: 'do', completed: false }] }), task('t2', 3, { dependencies: ['u1'] })]);
    await r.session.execute({ command: 'run_plan' }, { kind: 'user' });
    r.sessions.filter((s) => s.taskId === 't0').at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(r.session, 't0')!.status).toBe('completed'));
    await vi.waitFor(() => expect(r.session.activity.running).toBe(false));

    expect(r.session.activity.scheduled).toBe(true);
    expect(r.session.isExecuting).toBe(false);
    expect(held(r.session)).toBe(true);
    expect(cardEditable(held(r.session), taskOf(r.session, 't0')!)).toBe(false);
    expect(cardEditable(held(r.session), taskOf(r.session, 't2')!)).toBe(true);
    await cardEdit(r.session, 't2', { kind: 'prompt', prompt: 'later' });
    expect(taskOf(r.session, 't2')!.prompt).toBe('later');
    r.session.stopExecution();
  });

  it('refuses an edit begun while the plan was idle once the run claims the task meanwhile', async () => {
    const r = rig(true);
    r.load([task('t1', 1)]);
    expect(held(r.session)).toBe(false);

    const edit = cardEdit(r.session, 't1', { kind: 'skills', skills: ['cache'] });
    const refused = expect(edit).rejects.toThrow(/started before/);
    await r.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(r.spawn.mock.calls.some(([o]) => o.taskId === 't1')).toBe(true));
    r.skillGit.resolve(new Map());
    await refused;
    expect(taskOf(r.session, 't1')!.skills ?? []).toEqual([]);
    r.session.stopExecution();
  });

  // Nothing is live while the scheduler waits on a manual task, yet the next
  // claim can land on a settled or pending task mid-edit.
  it('holds a settled task of a run that waits on a manual task to the unstarted precondition', async () => {
    const r = rig();
    r.load([task('t0', 1), task('u1', 2, { type: 'user', dependencies: ['t0'], userSteps: [{ order: 1, instruction: 'do', completed: false }] })]);
    await r.session.execute({ command: 'run_plan' }, { kind: 'user' });
    r.sessions.filter((s) => s.taskId === 't0').at(-1)!.reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(r.session, 't0')!.status).toBe('completed'));
    await vi.waitFor(() => expect(r.session.activity.running).toBe(false));

    await expect(cardEdit(r.session, 't0', { kind: 'skills', skills: ['cache'] })).rejects.toThrow(/started before/);
    r.session.stopExecution();
  });

  it('refuses an edit of a task the run is running', async () => {
    const r = rig();
    r.load([task('t1', 1)]);
    await r.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(r.spawn.mock.calls.some(([o]) => o.taskId === 't1')).toBe(true));

    await expect(cardEdit(r.session, 't1', { kind: 'prompt', prompt: 'changed under it' })).rejects.toThrow(/started before/);
    expect(taskOf(r.session, 't1')!.prompt).toBe('do t1');
    r.session.stopExecution();
  });

  it('leaves the wider direct edit alone for a settled task when no run is live', async () => {
    const r = rig();
    r.load([task('t1', 1, { status: 'completed' })]);
    expect(held(r.session)).toBe(false);

    await cardEdit(r.session, 't1', { kind: 'prompt', prompt: 'Later' });
    expect(taskOf(r.session, 't1')!.prompt).toBe('Later');
  });

  it('maps each card edit to its field on a task that has not started', async () => {
    const r = rig();
    r.load([task('t1', 1), task('t2', 2)]);

    await cardEdit(r.session, 't2', { kind: 'dependencies', dependencies: ['t1'] });
    await cardEdit(r.session, 't1', { kind: 'mode', mode: 'plan' });
    await cardEdit(r.session, 't1', { kind: 'prompt', prompt: 'New prompt' });
    expect(taskOf(r.session, 't2')!.dependencies).toEqual(['t1']);
    expect(taskOf(r.session, 't1')).toMatchObject({ taskMode: 'plan', prompt: 'New prompt', description: 'New prompt' });
  });
});
