/*
 * A delegated task end to end, on real repositories (ADR-0055): a root plan
 * hands a goal to a child plan, its landed work comes back through the delegated
 * task's branch, and only the root touches the user's branch.
 */

// Part of delegatedTask.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: delegatedTaskKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDefaultMode } from '../ModeResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { Session } from '../createSession';
import type { IApproval } from '../../interfaces/IApproval';
import type { IRunner } from '../../interfaces/IRunner';
import { createTask } from '../../models/Task';
import { FakeRunnerSession, patient, removeDir } from '../../testing';
import { closeSessions, fakeFs } from './sessionTestKit';
import { env, git, roots, writingRunner, heldTasks, delegated, check, SUBMIT, childTask, NOTHING_THEN_BLOCKED, DONE, tree, statusOf } from './delegatedTaskKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

/**
 * A child's clock starts before it plans and before its first task's worktree
 * is made, some two dozen git processes on these real repositories: past two
 * seconds on a loaded Windows runner. A shorter clock runs out before the task
 * it is meant to time has started.
 */
const CHILD_CLOCK_MS = patient(4000);

describe('a landing that conflicts (ADR-0055 D14)', () => {
  const task = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);
  const integrationOf = (session: Session) => session.planState?.isolation?.run.repos[0].integrationBranch ?? '';

  /**
   * `s` and the child's `a` both write `x.txt`, so whichever lands last conflicts.
   * The delegated task's repair merges the tip in by hand, as a repair's prompt
   * tells a runner to, and `edit` is what it does beside that.
   */
  function conflicted(session: () => Session, { edit, waitsFor }: { edit?: (cwd: string) => void; waitsFor?: () => boolean } = {}) {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const repairs: { mode: string | undefined; cwd: string; prompt: string }[] = [];
    const runner: IRunner & { spawned: string[] } = {
      ...held.runner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'd') return held.runner.spawn(opts);
        repairs.push({ mode: opts.mode, cwd: opts.cwd, prompt: opts.prompt });
        const repair = new FakeRunnerSession(`repair-${repairs.length}`, 'd', 'native-repair');
        const finish = () => {
          if (waitsFor && !waitsFor()) {
            setTimeout(finish, 5);
            return;
          }
          spawnSync('git', ['merge', '--no-edit', integrationOf(session())], { cwd: opts.cwd, env: env() });
          writeFileSync(join(opts.cwd, 'x.txt'), 'both\n');
          edit?.(opts.cwd);
          git(opts.cwd, 'add', '-A');
          git(opts.cwd, 'commit', '-q', '--no-edit');
          repair.reportComplete({ status: 'done', summary: 'Repaired.' });
        };
        setTimeout(finish, 5);
        return repair;
      }),
    };
    return { runner, held, repairs };
  }

  const siblingFirst = async (parent: Session, held: ReturnType<typeof heldTasks>) => {
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 20_000 });
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 's')).toBe('completed'), { timeout: 20_000 });
    held.release('a');
  };
  const withSibling = () => [delegated(), check({ taskMode: 'plan' }), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })];

  it.each([[false], [true]])('is repaired by a plain runner in the mode its autonomy gives, autonomous %s, in the kept worktree, and lands', async (autonomous) => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!);
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { autonomousMode: autonomous, conflictRepairAttempts: 1 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(statusOf(made.parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(repairs).toHaveLength(1);
    expect(repairs[0].mode).toBe(resolveDefaultMode(new RunnerRegistry().get('claude-code')?.manifest.modes, autonomous));
    expect(repairs[0].mode).not.toBe('build');
    expect(repairs[0].prompt).toContain('tests/');
    expect(task(made.parent, 'd')?.taskMode).toBeUndefined();
    expect(made.planner.requests).toHaveLength(1);
    expect(git(made.root, 'show', `${integrationOf(made.parent)}:x.txt`)).toBe('both');
    // Its child's two names and its report outlast the repair, a plain runner with a session of its own.
    const child = made.parent.planState?.isolation?.run.tasks.d.childSession;
    expect(child).toBeDefined();
    expect(task(made.parent, 'd')?.runnerSessionId).toBe(child);
    expect(task(made.parent, 'd')?.handoff?.subtree?.counts.done).toBe(1);
    expect(task(made.parent, 'd')?.handoff?.summary).not.toBe('Repaired.');
    made.parent.destroy();
  });

  it('does not land a repair that changes a protected path, and waits on the user', async () => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!, { edit: (cwd) => writeFileSync(join(cwd, 'tests', 'guard.txt'), 'the check reads nothing\n') });
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 1 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(task(made.parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' }), { timeout: 20_000 });
    expect(repairs).toHaveLength(1);
    expect(git(made.root, 'show', `${integrationOf(made.parent)}:tests/guard.txt`)).toBe('the check reads this');
    expect(task(made.parent, 'd')?.runnerSessionId).toBe(made.parent.planState?.isolation?.run.tasks.d.childSession);
    expect(task(made.parent, 'd')?.handoff?.subtree).toBeDefined();
    made.parent.destroy();
  });

  it('takes no check back: it goes on with the result its verdict judged', async () => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!, { waitsFor: () => statusOf(on.session!, 'c') === 'skipped' });
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 1 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(repairs).toHaveLength(1), { timeout: 20_000 });
    await made.parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(made.parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(statusOf(made.parent, 'c')).toBe('skipped');
    made.parent.destroy();
  });

  it('gives a resolver the mode its autonomy gives, as a delegated task has none to hand on', async () => {
    const on: { session?: Session } = {};
    const { runner, held } = conflicted(() => on.session!);
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 0, autonomousMode: false } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(task(made.parent, 'd')?.awaitingReason).toBe('conflict'), { timeout: 20_000 });
    const asked = made.parent.escalations().find((e) => e.kind === 'conflict');
    expect(await made.parent.answerEscalation(asked!.id, 'resolve-conflict')).toMatchObject({ ok: true });
    const resolver = made.parent.planTasks.find((t) => t.title.startsWith('Resolve merge conflict'));
    expect(resolver?.taskMode).toBe(resolveDefaultMode(new RunnerRegistry().get('claude-code')?.manifest.modes, false));
    made.parent.destroy();
  });

  it('waits in the inbox once no repair is left, its work kept, and starts no new child', async () => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!);
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 0 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(task(made.parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' }), { timeout: 20_000 });
    expect(repairs).toHaveLength(0);
    expect(made.planner.requests).toHaveLength(1);
    expect(made.parent.escalations().find((e) => e.kind === 'conflict')?.task?.id).toBe('d');
    made.parent.destroy();
  });
});
describe('what ends a child with nobody to ask (ADR-0056 M3, M8, M10)', () => {
  it('denies a runner\'s approval at once, and tells the next run update: nobody below the root may allow it', async () => {
    const asked = { session: null as FakeRunnerSession | null };
    const runner = writingRunner({ a: ['a.txt'] }, { asks: (session) => { asked.session ??= session; } });
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(asked.session?.answers[0]?.decision).toMatchObject({ decision: 'deny' });
    expect(planner.asked[1]).toContain('denied');
    parent.destroy();
  });

  it('refuses what its shell would ask, so it runs sealed: nobody could answer, and the turn would wait out the clock', async () => {
    const policies: IApproval[] = [];
    const fsAdapter = { ...fakeFs(), setApproval: (policy: IApproval) => { policies.push(policy); } };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });

    const subplanners = policies.at(-1)!;
    const asked = subplanners.request({ kind: 'shell_command', subject: 'sleep 90', scope: 'sleep' });
    expect(await Promise.race([asked, new Promise((resolve) => setTimeout(() => resolve('still waiting on a person'), 200))])).toBe(false);
    parent.destroy();
  });

  it('stops only what it started: a child\'s end leaves its parent\'s sibling running', async () => {
    const held = heldTasks({ a: ['a.txt'], s: ['s.txt'] }, ['a', 's']);
    const { parent } = tree([SUBMIT([childTask('a', 1)])], {
      runner: held.runner,
      tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: CHILD_CLOCK_MS } }), check(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    // A run's own start clears what is live, with nothing to stop yet.
    vi.mocked(held.runner.stopAll).mockClear();
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect([...new Set(held.stopped)]).toEqual(['a']);
    expect(held.runner.stopAll).not.toHaveBeenCalled();
    expect(statusOf(parent, 's')).toBe('in_progress');
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 's')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('ends blocked when its time runs out, its run stopped first', async () => {
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const { parent } = tree([SUBMIT([childTask('a', 1)])], { runner: held.runner, tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: CHILD_CLOCK_MS } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toContain('a'));
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('ran out') });
    expect(held.stopped).toContain('a');
    parent.destroy();
  });

  it('ends blocked once delegation is turned off above it, its work in flight finished', async () => {
    let tokens = 5_000_000;
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner: held.runner, tokens: () => tokens });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toContain('a'));
    tokens = 0;
    parent.applyRunSettings({ delegationTokens: 0 });
    held.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('withdrawn') });
    expect(held.runner.spawned).not.toContain('b');
    parent.destroy();
  });
});
describe('wall-clock time (ADR-0056 M3)', () => {
  /** A runner's own words for a limit that resets well past any test, read from the clock so the hour never matters. */
  const limitWords = () => {
    const at = new Date(Date.now() + 3 * 3_600_000);
    const hours = at.getUTCHours() % 12 || 12;
    return `You've hit your session limit · resets ${hours}:${String(at.getUTCMinutes()).padStart(2, '0')}${at.getUTCHours() < 12 ? 'am' : 'pm'} (UTC)`;
  };
  /** Its clock started before the hold was seen, so one left running has run out by then, and its halt had two seconds more to show. */
  const pastTheClock = () => new Promise((resolve) => { setTimeout(resolve, CHILD_CLOCK_MS + patient(2000)); });

  it('stops while the tree is held on a usage limit found by a task, so its time does not run out', async () => {
    const spawned: string[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts) => {
        spawned.push(opts.taskId);
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => {
          const said = limitWords();
          session.emitEvent({ type: 'error', message: said });
          session.emitOutput(`${said}\n`);
          session.emitTurnEnd('failed');
        }, 5);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)])], { runner, tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: CHILD_CLOCK_MS } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), { timeout: 20_000 });
    await pastTheClock();
    expect(statusOf(parent, 'd')).toBe('in_progress');
    // The limit wakes the subplanner once its debounce is over (ADR-0057 R4), to say so; nothing reminds it to end.
    expect(planner.asked.slice(1).every((text) => text.includes('waits:usage-limit'))).toBe(true);
    expect(planner.asked.filter((text) => text.includes('no `task_complete` call'))).toEqual([]);
    parent.destroy();
  });

  it('stops for a subplanner\'s own limit too, and sends it no reminder while it waits to resend', async () => {
    const { parent, planner } = tree([async () => undefined, async () => ({ kind: 'message', text: limitWords(), failed: true, researchLog: [] })], { tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: CHILD_CLOCK_MS } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(planner.asked).toHaveLength(2), { timeout: 20_000 });
    await pastTheClock();
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict?.reason).toBeUndefined();
    expect(statusOf(parent, 'd')).toBe('in_progress');
    expect(planner.asked).toHaveLength(2);
    parent.destroy();
  });
});
describe('a child\'s budget', () => {
  it('comes back when it closes, for the next carve', async () => {
    const turns = [SUBMIT([childTask('a', 1)]), DONE, SUBMIT([{ ...childTask('b', 1), id: 'b' }]), DONE];
    const { parent } = tree(turns, {
      tokens: () => 3_000_000,
      tasks: [delegated({ budget: { tokens: 2_500_000 } }), check(), delegated({ id: 'e', order: 3, dependencies: ['c'], budget: { tokens: 2_500_000 } }), check({ id: 'f', order: 4, dependencies: ['e'] })],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'f')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('starts over on a fresh retry, in a new child', async () => {
    const { parent, planner } = tree([NOTHING_THEN_BLOCKED, SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const first = parent.planState?.isolation?.run.tasks.d.childSession;
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(2);
    expect(parent.planState?.isolation?.run.tasks.d.childSession).not.toBe(first);
    parent.destroy();
  });
});
