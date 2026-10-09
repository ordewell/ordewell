import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IConfig } from '../../interfaces/IConfig';
import type { IsolationMergeResult } from '../../interfaces/IWorktreeIsolation';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { SkillInfo } from '../SkillsService';

function skill(name: string, appliesTo: SkillInfo['appliesTo'] = 'task'): SkillInfo {
  return {
    name, description: name, metadata: { name, description: name }, content: `${name} body.`,
    path: `/g/${name}/SKILL.md`, source: 'global', appliesTo, modelInvocable: false, userInvocable: true,
  };
}

/** The global catalog every root sees in these tests; `grilling` is the planner skill. */
const CATALOG = new Map([['tdd', skill('tdd')], ['grilling', skill('grilling', 'planner')]]);

/** A workspace skill written in the main checkout's `api` repo and never committed: no worktree has it. */
const UNCOMMITTED: SkillInfo = { ...skill('deploy-checklist'), source: 'workspace', path: '/repo/api/.ordewell/skills/deploy-checklist/SKILL.md' };

/**
 * What differs between a change, an ops, a repair and a continued attempt, as
 * the orchestrator shows it: where each runs, what it is told, whether its
 * tree is checked, and whether it keeps Merge all out.
 */
function setup(opts: { isolation?: FakeWorktreeIsolation; config?: Partial<IConfig>; workspace?: string } = {}) {
  /** The roots each spawn read skills from. */
  const skillRoots: (readonly string[])[] = [];
  const isolation = opts.isolation ?? new FakeWorktreeIsolation();
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  /** Spawns that wait to be let through, by task id. */
  const holds = new Map<string, Promise<void>>();
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      requests.push(o);
      await holds.get(o.taskId);
      const id = `s${sessions.length + 1}`;
      const session = new FakeRunnerSession(id, o.taskId, o.resumeSessionId ?? `native-${o.taskId}-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: true, ...opts.config }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    isolation,
    workspaceRoot: () => opts.workspace ?? '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    skillsAt: (roots) => {
      skillRoots.push(roots);
      const findSkill = (name: string) => CATALOG.get(name)
        ?? (name === UNCOMMITTED.name && roots.some((root) => UNCOMMITTED.path === `${root}/.ordewell/skills/${name}/SKILL.md`) ? UNCOMMITTED : undefined);
      return { findSkill, searchedDirs: () => ['/g', ...roots.map((root) => `${root}/.ordewell/skills`)] };
    },
  });
  const notices: string[] = [];
  orchestrator.subscribe({ onIsolationNotice: ({ message }) => notices.push(message) });
  const spawned = (taskId: string) => requests.filter((r) => r.taskId === taskId);
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const pass = (task: Task) => latest(task.id).reportComplete({ status: 'done', summary: '' });
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  const ops = () => isolation.calls.map((c) => c.op);
  const hold = (taskId: string): (() => void) => {
    let open!: () => void;
    holds.set(taskId, new Promise<void>((resolve) => { open = resolve; }));
    return () => { holds.delete(taskId); open(); };
  };
  return { orchestrator, isolation, spawned, latest, pass, status, ops, notices, hold, skillRoots };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });
const opsTask = (id: string, order: number, over: Partial<Task> = {}) => change(id, order, { ops: true, ...over });

/** Run a task to a pass on its own, so it can be continued. */
async function completed(env: ReturnType<typeof setup>, task: Task): Promise<void> {
  await env.orchestrator.forceStartTask(task.id);
  env.pass(task);
  await vi.waitFor(() => expect(env.status(task.id)).toBe('completed'));
  await flushMicrotasks();
}

/** A change task whose landing conflicts, with repairs on: its second attempt is a repair. */
function conflicting(env: ReturnType<typeof setup>, id: string): void {
  env.isolation.outcomes.set(id, 'conflict');
  env.isolation.conflictFiles.set(id, ['a.ts']);
}

describe('attempt kinds, as the orchestrator runs them', () => {
  describe('where each runs', () => {
    it('a change attempt runs in the worktree prepared for it', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1)]);

      await env.orchestrator.approveReview();

      expect(env.spawned('c1')[0].cwd).toBe('/fake-worktrees/run1/1-c1');
    });

    it('an ops attempt runs at the workspace root and prepares no worktree', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1), opsTask('o2', 2)]);

      await env.orchestrator.approveReview();

      expect(env.spawned('o2')[0].cwd).toBe('/repo');
      expect(env.isolation.taskIdsFor('prepare')).toEqual(['c1']);
    });

    it('a repair runs in the worktree kept for it', async () => {
      const env = setup({ config: { conflictRepairAttempts: 1 } });
      const c1 = change('c1', 1);
      conflicting(env, 'c1');
      env.orchestrator.loadPlan([c1]);
      await env.orchestrator.approveReview();

      env.pass(c1);

      await vi.waitFor(() => expect(env.spawned('c1')).toHaveLength(2));
      expect(env.spawned('c1')[1].cwd).toBe(env.spawned('c1')[0].cwd);
      expect(env.isolation.taskIdsFor('reopen')).toEqual(['c1']);
      expect(env.isolation.taskIdsFor('prepare')).toEqual(['c1']);
    });

    it('a continued change task starts from a fresh worktree', async () => {
      const env = setup();
      const c1 = change('c1', 1);
      env.orchestrator.loadPlan([c1]);
      await completed(env, c1);

      await env.orchestrator.continueTask('c1', 'one more thing');

      expect(env.spawned('c1')[1]).toMatchObject({ cwd: '/fake-worktrees/run1/1-c1' });
      expect(env.isolation.taskIdsFor('prepare')).toEqual(['c1', 'c1']);
    });

    it('a continued ops task runs at the workspace root again', async () => {
      const env = setup();
      const o1 = opsTask('o1', 1);
      env.orchestrator.loadPlan([o1]);
      await completed(env, o1);

      await env.orchestrator.continueTask('o1', 'check the pipeline again');

      expect(env.spawned('o1')[1]).toMatchObject({ cwd: '/repo' });
      expect(env.isolation.taskIdsFor('prepare')).toEqual([]);
    });
  });

  describe('the tree check', () => {
    it('never looks at the tree of a change task', async () => {
      const env = setup();
      const c1 = change('c1', 1);
      env.orchestrator.loadPlan([c1]);
      await env.orchestrator.approveReview();
      env.isolation.changedFiles = ['a.ts'];

      env.pass(c1);

      await vi.waitFor(() => expect(env.status('c1')).toBe('completed'));
      expect(env.ops()).not.toContain('snapshotTree');
      expect(env.ops()).not.toContain('changedSince');
    });

    it('never looks at the tree of a repair', async () => {
      const env = setup({ config: { conflictRepairAttempts: 1 } });
      const c1 = change('c1', 1);
      conflicting(env, 'c1');
      env.orchestrator.loadPlan([c1]);
      await env.orchestrator.approveReview();
      env.pass(c1);
      await vi.waitFor(() => expect(env.spawned('c1')).toHaveLength(2));
      env.isolation.outcomes.delete('c1');
      env.isolation.changedFiles = ['a.ts'];

      env.pass(c1);

      await vi.waitFor(() => expect(env.status('c1')).toBe('completed'));
      expect(env.ops()).not.toContain('snapshotTree');
    });

    it('checks the tree of a continued ops task', async () => {
      const env = setup();
      const o1 = opsTask('o1', 1);
      env.orchestrator.loadPlan([o1]);
      await completed(env, o1);
      const snapshotsBefore = env.ops().filter((op) => op === 'snapshotTree').length;
      await env.orchestrator.continueTask('o1', 'retag it');
      env.isolation.changedFiles = ['package.json'];

      env.pass(o1);

      await vi.waitFor(() => expect(env.status('o1')).toBe('awaiting_user'));
      expect(env.orchestrator.storeInstance.get('o1')!.awaitingReason).toBe('files-changed');
      expect(env.ops().filter((op) => op === 'snapshotTree')).toHaveLength(snapshotsBefore + 1);
    });
  });

  describe('what each is told', () => {
    it('a change attempt gets its skills, read from where it runs, and keeps what it got', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1, { skills: ['tdd'] })]);

      await env.orchestrator.approveReview();

      const [request] = env.spawned('c1');
      expect(request.prompt).toContain('## Task skills');
      expect(request.prompt).toContain('### Skill: tdd\n\ntdd body.');
      expect(request.prompt).not.toContain('## Previous attempt');
      expect(env.skillRoots).toEqual([[request.cwd]]);
      const snapshot = [{ name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md', content: 'tdd body.' }];
      expect(env.orchestrator.storeInstance.get('c1')!.attemptSkills).toEqual(snapshot);
      expect(env.orchestrator.getAttempt('c1')!.skills).toEqual(snapshot);
    });

    it('in a repo group, skills are read from the group root, then each repo\'s worktree in layout order', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      const env = setup({ isolation });
      env.orchestrator.loadPlan([change('c1', 1, { skills: ['tdd'] }), opsTask('o1', 2, { skills: ['tdd'] })]);

      await env.orchestrator.approveReview();

      const { cwd } = env.spawned('c1')[0];
      expect(env.skillRoots[0]).toEqual(['/repo', `${cwd}/api`, `${cwd}/web`]);
      expect(env.spawned('c1')[0].prompt).toContain('### Skill: tdd');
    });

    it('in a repo group run without isolation, skills are read from the group root, then each repo where the workspace holds it', async () => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-shared-group-'));
      try {
        for (const repo of ['web', 'api']) fs.mkdirSync(path.join(workspace, repo, '.git'), { recursive: true });
        const isolation = new FakeWorktreeIsolation();
        isolation.availability = { active: false, reason: 'disabled' };
        const env = setup({ isolation, workspace, config: { worktreeIsolation: false } });
        env.orchestrator.loadPlan([change('c1', 1, { skills: ['tdd'] })]);

        await env.orchestrator.approveReview();

        expect(env.spawned('c1')[0].cwd).toBe(workspace);
        expect(env.skillRoots[0]).toEqual([workspace, path.join(workspace, 'api'), path.join(workspace, 'web')]);
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('a group task whose skill is missing names every folder it searched, the group root\'s included', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      const env = setup({ isolation });
      env.orchestrator.loadPlan([change('c1', 1, { skills: ['deploy-checklist'] })]);

      await env.orchestrator.approveReview();

      await vi.waitFor(() => expect(env.status('c1')).toBe('failed'));
      const reason = env.orchestrator.storeInstance.get('c1')!.outputSummary!.reviewReason;
      expect(reason).toContain('/repo/.ordewell/skills or /fake-worktrees/run1/1-c1/api/.ordewell/skills or /fake-worktrees/run1/1-c1/web/.ordewell/skills');
      expect(reason).toContain('commit api/.ordewell/skills/deploy-checklist so task worktrees receive it');
    });

    it('a task with no worktree whose skill is missing is not told to commit it', async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.repos = ['api', 'web'];
      const env = setup({ isolation });
      env.orchestrator.loadPlan([opsTask('o1', 1, { skills: ['nowhere'] })]);

      await env.orchestrator.approveReview();

      await vi.waitFor(() => expect(env.status('o1')).toBe('failed'));
      const reason = env.orchestrator.storeInstance.get('o1')!.outputSummary!.reviewReason;
      expect(reason).toContain('skill "nowhere" not found');
      expect(reason).not.toContain('commit');
    });

    it('hands the attempt\'s skills to what wraps the runner, so its log can record them', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1, { skills: ['tdd'] }), change('c2', 2)]);

      await env.orchestrator.approveReview();
      await env.orchestrator.forceStartTask('c2');

      expect(env.spawned('c1')[0].skills).toEqual([{ name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md', content: 'tdd body.' }]);
      expect(env.spawned('c2')[0]).not.toHaveProperty('skills');
    });

    it('a retry whose skill has gone fails without the earlier attempt\'s snapshot beside it', async () => {
      const env = setup();
      const c1 = change('c1', 1, { skills: ['tdd'] });
      env.orchestrator.loadPlan([c1]);
      await env.orchestrator.approveReview();
      expect(env.orchestrator.storeInstance.get('c1')!.attemptSkills).toHaveLength(1);

      const tdd = CATALOG.get('tdd')!;
      CATALOG.delete('tdd');
      try {
        await env.orchestrator.retryTask('c1');
        await vi.waitFor(() => expect(env.status('c1')).toBe('failed'));
      } finally {
        CATALOG.set('tdd', tdd);
      }

      expect(env.spawned('c1')).toHaveLength(1);
      expect(env.orchestrator.storeInstance.get('c1')!.attemptSkills).toBeUndefined();
    });

    it('a task without skills is told none', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1)]);

      await env.orchestrator.approveReview();

      expect(env.spawned('c1')[0].prompt).not.toContain('## Task skills');
      expect(env.orchestrator.storeInstance.get('c1')!.attemptSkills).toBeUndefined();
    });

    it('a subtask gets its own skills, not its parent\'s', async () => {
      const env = setup();
      const parent = change('p1', 1, { skills: ['tdd'], subtasks: [change('s1', 1)] });
      env.orchestrator.loadPlan([parent]);

      await env.orchestrator.forceStartTask('s1');

      expect(env.spawned('s1')[0].prompt).not.toContain('### Skill: tdd');
    });

    it('an ops attempt gets its skills too, and no previous attempt on its first run', async () => {
      const env = setup();
      env.orchestrator.loadPlan([opsTask('o1', 1, { skills: ['tdd'] })]);

      await env.orchestrator.approveReview();

      expect(env.spawned('o1')[0].prompt).toContain('### Skill: tdd');
      expect(env.spawned('o1')[0].prompt).not.toContain('## Previous attempt');
    });

    it('a task whose skill is missing fails before any runner starts, naming it and where it looked', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1, { skills: ['tdd', 'deploy-checklist'] }), change('c2', 2, { dependencies: ['c1'] })]);

      await env.orchestrator.approveReview();

      await vi.waitFor(() => expect(env.status('c1')).toBe('failed'));
      expect(env.spawned('c1')).toHaveLength(0);
      expect(env.spawned('c2')).toHaveLength(0);
      const reason = env.orchestrator.storeInstance.get('c1')!.outputSummary!.reviewReason;
      expect(reason).toContain('"deploy-checklist" not found in /g or ');
      expect(reason).toContain('/.ordewell/skills');
      expect(reason).not.toContain('"tdd"');
      expect(env.notices.some((n) => n.includes('deploy-checklist'))).toBe(true);
    });

    it('a task attaching a planner skill fails before any runner starts', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1, { skills: ['grilling'] })]);

      await env.orchestrator.approveReview();

      await vi.waitFor(() => expect(env.status('c1')).toBe('failed'));
      expect(env.spawned('c1')).toHaveLength(0);
      expect(env.orchestrator.storeInstance.get('c1')!.outputSummary!.reviewReason).toContain('"grilling" is a planner skill');
    });

    it('a repair is asked to resolve the conflict, without the task\'s skills', async () => {
      const env = setup({ config: { conflictRepairAttempts: 1 } });
      const c1 = change('c1', 1, { skills: ['tdd'] });
      conflicting(env, 'c1');
      env.orchestrator.loadPlan([c1]);
      await env.orchestrator.approveReview();

      env.pass(c1);

      await vi.waitFor(() => expect(env.spawned('c1')).toHaveLength(2));
      expect(env.spawned('c1')[1].prompt).toContain('conflicted in a.ts');
      expect(env.spawned('c1')[1].prompt).not.toContain('### Skill: tdd');
    });

    it('a continued change task is told its worktree was recreated', async () => {
      const env = setup();
      const c1 = change('c1', 1, { skills: ['tdd'] });
      env.orchestrator.loadPlan([c1]);
      await completed(env, c1);

      await env.orchestrator.continueTask('c1', 'one more thing');

      const prompt = env.spawned('c1')[1].prompt;
      expect(prompt.startsWith('one more thing\n')).toBe(true);
      expect(prompt).toContain('Your working directory was recreated from the integration branch');
      expect(prompt).not.toContain('### Skill: tdd');
    });

    it('a continued ops task is told its earlier effects were not undone', async () => {
      const env = setup();
      const o1 = opsTask('o1', 1);
      env.orchestrator.loadPlan([o1]);
      await completed(env, o1);

      await env.orchestrator.continueTask('o1', 'check the pipeline again');

      const prompt = env.spawned('o1')[1].prompt;
      expect(prompt).toContain('in the same checkout');
      expect(prompt).toContain('was not undone');
      expect(prompt).not.toContain('## Previous attempt');
    });
  });

  describe('Merge all and ops work never overlap', () => {
    it('refuses Merge all while a continued ops task runs', async () => {
      const env = setup();
      const c1 = change('c1', 1);
      const o2 = opsTask('o2', 2);
      env.orchestrator.loadPlan([c1, o2]);
      await completed(env, c1);
      await completed(env, o2);
      await env.orchestrator.continueTask('o2', 'again');

      await expect(env.orchestrator.mergeRun()).rejects.toThrow(TaskControlError);
      expect(env.ops()).not.toContain('mergeIntoCheckedOut');
    });

    it('lets Merge all run beside a change task', async () => {
      const env = setup();
      const c1 = change('c1', 1);
      env.orchestrator.loadPlan([c1, change('c2', 2)]);
      await env.orchestrator.approveReview();
      env.pass(c1);
      await vi.waitFor(() => expect(env.status('c1')).toBe('completed'));
      expect(env.status('c2')).toBe('in_progress');

      await expect(env.orchestrator.mergeRun()).resolves.toEqual({ outcome: 'merged' });
    });

    it('refuses to run an ops task on its own while a merge is under way', async () => {
      const env = setup();
      const c1 = change('c1', 1);
      env.orchestrator.loadPlan([c1, opsTask('o2', 2)]);
      await completed(env, c1);
      let refused: unknown = null;
      env.isolation.mergeIntoCheckedOut = async () => {
        refused = await env.orchestrator.runTask('o2').then(() => null, (err: unknown) => err);
        return { outcome: 'merged' };
      };

      await env.orchestrator.mergeRun();

      expect(refused).toBeInstanceOf(TaskControlError);
      expect(env.spawned('o2')).toHaveLength(0);
    });

    // Readiness is read once per tick, before the tick awaits each start: a
    // Merge all can begin while an earlier task of the same batch is starting.
    it('starts no ops task the scheduler picked before a merge began', async () => {
      const env = setup();
      env.orchestrator.loadPlan([change('c1', 1), opsTask('o2', 2)]);
      const openC1 = env.hold('c1');
      let openMerge!: () => void;
      let mergeEntered = false;
      env.isolation.mergeIntoCheckedOut = async (): Promise<IsolationMergeResult> => {
        mergeEntered = true;
        await new Promise<void>((resolve) => { openMerge = resolve; });
        return { outcome: 'merged' };
      };

      const started = env.orchestrator.approveReview();
      await vi.waitFor(() => expect(env.spawned('c1')).toHaveLength(1));
      const merged = env.orchestrator.mergeRun();
      await vi.waitFor(() => expect(mergeEntered).toBe(true));
      openC1();
      await started;

      expect(env.spawned('o2')).toHaveLength(0);

      openMerge();
      await merged;
      await vi.waitFor(() => expect(env.spawned('o2')).toHaveLength(1));
    });
  });
});
