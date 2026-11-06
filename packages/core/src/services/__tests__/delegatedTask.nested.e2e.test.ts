/*
 * A delegated task end to end, on real repositories (ADR-0055): a root plan
 * hands a goal to a child plan, its landed work comes back through the delegated
 * task's branch, and only the root touches the user's branch.
 */

// Part of delegatedTask.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: delegatedTaskKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LeaseHost } from '../sessionLease';
import { resolveDefaultMode } from '../ModeResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { IAiService } from '../AiService';
import type { IFileSystem, OwnSealedRuns, TaskShell, ToolOutcome } from '../../interfaces/IFileSystem';
import type { IRunner } from '../../interfaces/IRunner';
import { createTask, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession, patient, removeDir } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, fakeFs, makeSession, scriptedPlanner, type PlannerTurn as Turn } from './sessionTestKit';
import { env, git, roots, repo, writingRunner, heldTasks, isolation, planOf, delegated, check, SUBMIT, childTask, DONE, tree, statusOf } from './delegatedTaskKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('two levels down (ADR-0056 M8, ADR-0055 D9, D14)', () => {
  const quiet = () => ({ signal: new AbortController().signal });
  const nestedChild = { id: 'e', order: 1, title: 'Deeper subtree', description: 'deeper', type: 'delegated', goal: 'Write a', budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', dependencies: [] };
  const nestedCheck = { id: 'f', order: 2, title: 'Check the deeper subtree', description: 'check', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['e'] };

  /** A root whose subplanner and sub-subplanner each read their own turns. */
  function nested(outer: Turn[], inner: Turn[], { runner = writingRunner({ a: ['a.txt'] }), config = {} }: { runner?: IRunner; config?: Parameters<typeof fakeConfig>[0] } = {}) {
    const root = repo();
    const planners = { d: scriptedPlanner(outer), e: scriptedPlanner(inner) };
    const parent = makeSession({
      runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      config: fakeConfig({ maxParallelSessions: 3, ...config }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 } }),
      delegationOffered: true,
      childDeps: (task) => ({ aiService: { reset: vi.fn(), ...planners[task.id as 'd' | 'e'].service } as unknown as IAiService, fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
    });
    parent.loadPlan({ ...planOf([delegated({ grants: ['delegate'] }), check()]), runners: ['claude-code'] }, 'the root goal', root, { sessionId: 'session-root' });
    return { root, parent, planners };
  }

  it('holds a child\'s own merge while its check has not passed, so its subplanner cannot say done', async () => {
    const replies: string[] = [];
    const inner = writingRunner({ a: ['a.txt'] });
    const runner: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'f') return inner.spawn(opts);
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It does not hold.', reason: 'It does not hold.' }), 5);
        return session;
      }),
    };
    const { parent } = nested([
      SUBMIT([nestedChild, nestedCheck]),
      async (tools) => {
        const said = await tools.taskComplete!({ status: 'done', summary: 'Done.', commit: { subject: 'Write a' } }, quiet());
        replies.push(said.text);
        await tools.taskComplete!({ status: 'blocked', summary: 'Its check failed.', reason: 'Its check failed.' }, quiet());
      },
    ], [SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 40_000 });
    expect(replies[0]).toContain('Not done yet');
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict?.reported).toBe('blocked');
    parent.destroy();
  }, patient(60_000));

  it('repairs a child\'s delegated task in the mode its mandate gives, held to what its ancestors protect too', async () => {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const repairs: { mode: string | undefined }[] = [];
    const heard: string[] = [];
    const runner: IRunner & { spawned: string[] } = {
      ...held.runner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'e') return held.runner.spawn(opts);
        repairs.push({ mode: opts.mode });
        const repair = new FakeRunnerSession('repair-e', 'e');
        setTimeout(() => {
          const [integration] = /ordewell\/[^\s`]+\/integration/.exec(opts.prompt) ?? [''];
          spawnSync('git', ['merge', '--no-edit', integration], { cwd: opts.cwd, env: env() });
          writeFileSync(join(opts.cwd, 'x.txt'), 'both\n');
          writeFileSync(join(opts.cwd, 'tests', 'guard.txt'), 'the root protects this\n');
          git(opts.cwd, 'add', '-A');
          git(opts.cwd, 'commit', '-q', '--no-edit');
          repair.reportComplete({ status: 'done', summary: 'Repaired.' });
        }, 5);
        return repair;
      }),
    };
    const { parent } = nested([
      SUBMIT([{ ...nestedChild, protectedPaths: ['docs/'] }, nestedCheck, { ...childTask('s', 3) }]),
      async (tools, text) => {
        heard.push(text);
        await tools.taskComplete!({ status: 'blocked', summary: 'It conflicts.', reason: 'It conflicts.' }, quiet());
      },
    ], [SUBMIT([childTask('a', 1)]), DONE], { runner, config: { conflictRepairAttempts: 1, autonomousMode: false } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 30_000 });
    held.release('s');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    held.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 40_000 });
    expect(repairs).toEqual([{ mode: resolveDefaultMode(new RunnerRegistry().get('claude-code')?.manifest.modes, false) }]);
    expect(heard[0]).toContain('conflicts');
    parent.destroy();
  }, patient(60_000));

  it('wakes the subplanner on a conflict with no repair left: nobody below the root waits on a person', async () => {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const heard: string[] = [];
    const { parent } = nested([
      SUBMIT([nestedChild, nestedCheck, { ...childTask('s', 3) }]),
      async (tools, text) => {
        heard.push(text);
        await tools.taskComplete!({ status: 'blocked', summary: 'It conflicts.', reason: 'It conflicts.' }, quiet());
      },
    ], [SUBMIT([childTask('a', 1)]), DONE], { runner: held.runner, config: { conflictRepairAttempts: 0 } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 30_000 });
    held.release('s');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    held.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 40_000 });
    expect(heard[0]).toContain('conflicts');
    expect(parent.escalations().map((e) => e.kind)).not.toContain('checkpoint');
    parent.destroy();
  }, patient(60_000));

  it('wakes its parent subplanner, which answers it, and nothing of it reaches the user', async () => {
    let asked: string[] = [];
    let seen: string[] = [];
    const { parent, planners } = nested([
      SUBMIT([nestedChild, nestedCheck]),
      async (tools, text) => {
        seen = parent.escalations().map((e) => e.reason);
        expect(text).toContain('Which file?');
        const reply = await tools.answerCheckpoint!({ task: 'e', answer: 'reject', reason: 'a.txt', raiseTokens: undefined }, quiet());
        if (reply.isError) throw new Error(reply.text);
      },
      DONE,
    ], [
      async (tools) => { await tools.checkpoint!({ question: 'Which file?' }, quiet()); },
      async (tools, text) => { asked = [text]; await SUBMIT([childTask('a', 1)])(tools, text); },
      DONE,
    ]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 40_000 });
    expect(asked[0]).toContain('a.txt');
    expect(seen.join()).not.toContain('Which file?');
    expect(planners.d.asked.join()).toContain('Which file?');
    parent.destroy();
  }, patient(60_000));
});
describe('a sealed script (ADR-0055 D8, ADR-0056 M9)', () => {
  /** A shell that runs what it is handed in `sh`, and keeps what it ran: a real seal is the sandbox's own suite. */
  function sealedFs() {
    const ran: { script: string; cwd: string }[] = [];
    const run = async (script: string, cwd: string): Promise<ToolOutcome> => {
      ran.push({ script, cwd });
      const result = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });
      return { success: result.status === 0, output: `${result.stdout}${result.stderr}`, truncated: false };
    };
    const fsAdapter: IFileSystem = {
      ...fakeFs(),
      canSeal: async () => true,
      taskShell: ({ cwd, writable, worktrees }) => {
        const shell: TaskShell = {
          run: () => Promise.reject(new Error('a script runs through hold')),
          hold: <T>(work: (runs: OwnSealedRuns) => Promise<T>) => work({ worktrees: worktrees?.length ? worktrees : [writable ?? cwd], touched: false, scratch: '', run }),
          end: () => undefined,
        };
        return shell;
      },
    };
    return { fsAdapter, ran };
  }
  const script = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Run the suite', type: 'script', commands: [['cat', 'a.txt']], readOnly: true, dependencies: ['d'], ...over });

  it('runs sealed in a worktree cut from the integration tip, past no merge gate, and lands nothing', async () => {
    const { fsAdapter, ran } = sealedFs();
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), script()], fsAdapter });
    const main = git(root, 'rev-parse', 'main');
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });

    expect(ran[0].cwd).not.toBe(root);
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(existsSync(ran[0].cwd)).toBe(false);
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(['README.md', 'a.txt', 'tests/guard.txt']);
    parent.destroy();
  });

  it('fails on its exit status, and its dependents are held', async () => {
    const { fsAdapter } = sealedFs();
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), script({ commands: [['cat', 'no-such-file']] }), createTask({ id: 'n', order: 3, title: 'After', prompt: 'after', dependencies: ['c'] })], fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'c')?.verdict?.reported).toBe('failed');
    expect(statusOf(parent, 'n')).not.toBe('in_progress');
    parent.destroy();
  });

  it('fails at its start where the host has no sealed shell, and never sits ready', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), script()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.escalations().map((e) => e.reason).join()).toContain('must run sealed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('is what a child\'s own script task is, with no `effect` to run otherwise', async () => {
    const { fsAdapter, ran } = sealedFs();
    const script = { id: 't', order: 2, title: 'Test it', description: 'test', type: 'script', sliceType: 'AFK', commands: [['cat', 'a.txt']], dependencies: ['a'] };
    const { parent } = tree([SUBMIT([childTask('a', 1), script]), DONE], { fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(ran).toHaveLength(1);
    parent.destroy();
  });
});
