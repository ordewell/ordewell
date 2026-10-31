import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionCommandName } from '../../models/Execution';
import { FakeWorktreeIsolation, fakeConfig } from '../../testing';
import { ExecutionCommands, type ExecutionHost } from '../ExecutionCommands';
import { COMMAND_GRANTS, FLOOR_GRANTS, GRANTS, type Grant, type Mandate, type NodeAuthority } from '../Mandate';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { makeSession, taskOf } from './sessionTestKit';
import { ctx, heldPlanner, NOW, prose, recordingRunner, settled, supervised, task, until, waitForInput, type Options } from './supervisorTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { WAKE_UP_RATE } from '../LoopGuards';

/**
 * Every path that reaches around the seam, each through its own path (ADR-0056
 * M6). No child exists yet, so a child is faked: a node whose mandate a test
 * writes. The root's answers on these paths are held by the flat suites and by
 * `mandate.flatRun.test.ts`.
 */

function mandateOf(grants: readonly Grant[], over: Partial<Mandate> = {}): Mandate {
  return {
    grants: new Set(grants),
    grantable: new Set(grants),
    autonomy: 'full',
    limits: { tokens: 1000, wallClockMs: 1000, depth: 1, delegatedTasks: 2, tasksPerPlan: 5, runners: ['claude-code'], models: {} },
    exclusions: { protectedPaths: [] },
    effectRules: [],
    ...over,
  };
}

const child = (grants: readonly Grant[], over: Partial<Mandate> = {}, depth = 1): NodeAuthority => ({ depth, mandate: () => mandateOf(grants, over) });

const SUBPLANNER = { kind: 'subplanner', depth: 1 } as const;

const seamAt = (node: NodeAuthority) => new ExecutionCommands({ host: { autonomous: () => true, autorun: () => true } as unknown as ExecutionHost, consent: { request: vi.fn() }, authority: node });

describe('a subplanner at the seam (ADR-0056 M6)', () => {
  const COMMANDS = Object.keys(COMMAND_GRANTS) as ExecutionCommandName[];

  it.each(COMMANDS)('answers %s by its grants alone, allow or refuse, never ask', (command) => {
    const grant = COMMAND_GRANTS[command];
    const without = seamAt(child([])).consent(SUBPLANNER, command);
    const held = seamAt(child([...GRANTS])).consent(SUBPLANNER, command);
    expect(without.kind).toBe('refuse');
    expect(held.kind).toBe(grant === null ? 'refuse' : 'allow');
  });

  it('asks nobody even in Guarded, where a planner turn is asked', () => {
    expect(seamAt(child(['control'], { autonomy: 'guarded' })).consent(SUBPLANNER, 'run_task')).toEqual({ kind: 'allow' });
  });

  it('names the level that refused', () => {
    expect(seamAt(child(['observe', 'steer'], {}, 2)).consent({ kind: 'subplanner', depth: 2 }, 'run_task')).toEqual({
      kind: 'refuse',
      reason: 'Level 2 refused this: it needs the control grant, and this node holds observe, steer.',
    });
  });

  it('refuses the user\'s own controls as to any model, whatever it holds', () => {
    expect(seamAt(child([...GRANTS])).consent(SUBPLANNER, 'mark_complete')).toEqual({
      kind: 'refuse',
      reason: 'Mark complete is the user\'s alone: it lands the work as if someone had checked it, and only they vouch for work. If you think it is done, tell them why; they can mark it complete.',
    });
  });

  it('reads the grant at each check, so one lost mid-session is refused at once', () => {
    let grants: Grant[] = ['control'];
    const commands = seamAt({ depth: 1, mandate: () => mandateOf(grants) });
    expect(commands.consent(SUBPLANNER, 'stop_task')).toEqual({ kind: 'allow' });
    grants = [];
    expect(commands.consent(SUBPLANNER, 'stop_task').kind).toBe('refuse');
  });
});

describe('through a session (ADR-0056 M6)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const below = (node: NodeAuthority, options: Options = {}) => supervised([task('t1', 1)], { execute: false, settings: { supervisorLevel: 'off' }, plan: { status: 'draft', approved: false }, ...options, child: node });

  async function turn(env: Awaited<ReturnType<typeof below>>): Promise<void> {
    void env.session.continueConversation('go on');
    await until(() => env.planner.calls.length > 0);
  }

  const addCache = (env: Awaited<ReturnType<typeof below>>, extra: Record<string, unknown> = {}) =>
    env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', ...extra } }] }, ctx);

  const added = (env: Awaited<ReturnType<typeof below>>) => env.session.planTasks.find((t) => t.title === 'Add a cache');

  describe('adoptPlannerTasks and autorunApproves: a commit approves with no command', () => {
    it('refuses an edit without `replan`, naming the level, and the plan keeps what it had', async () => {
      const env = await below(child(['control', 'approve']));
      await turn(env);

      const edit = await addCache(env);

      expect(edit.isError).toBe(true);
      expect(JSON.stringify(edit)).toContain('Level 1 refused this: it needs the replan grant');
      expect(added(env)).toBeUndefined();
    });

    it('takes an edit with `replan`', async () => {
      const env = await below(child(['replan']));
      await turn(env);

      expect((await addCache(env)).isError).toBeFalsy();
      expect(added(env)).toBeDefined();
    });

    it('refuses a whole plan without `replan`, which never lands', async () => {
      const env = await below(child(['control', 'approve']));
      const opening = env.session.startPlanning('build it');
      await until(() => env.planner.calls.length === 1);
      env.planner.calls[0].finish({ kind: 'plan', text: '', tasks: [task('fresh', 1)], researchLog: [] });

      // The planner is told, as of any plan the check refuses, and gets to answer.
      await until(() => env.planner.calls.length === 2);
      expect(env.planner.calls[1].message).toContain('Level 1 refused this: it needs the replan grant');
      env.planner.calls[1].finish(prose('I may not change the plan.'));
      await opening;

      expect(env.session.planTasks.map((t) => t.id)).not.toContain('fresh');
    });

    it('approves what it writes as it lands with `approve`, whatever the user\'s autorun says', async () => {
      const env = await below(child(['replan', 'approve']), { settings: { supervisorLevel: 'off', autorun: false } });
      await turn(env);

      await addCache(env);

      expect(env.session.planState!.approvedTasks).toContain(added(env)!.id);
    });

    it('approves nothing without `approve`, whatever the user\'s autorun says', async () => {
      const env = await below(child(['replan']), { settings: { supervisorLevel: 'off', autorun: true } });
      await turn(env);

      await addCache(env);

      expect(env.session.planState!.approvedTasks ?? []).not.toContain(added(env)!.id);
    });
  });

  describe('adoptResearch and startAtGate: research is approved and queued as it lands', () => {
    const scout = { research: true, readOnly: true };

    it('refuses a research task without `research`, naming the level', async () => {
      const env = await below(child(['replan', 'approve', 'control']));
      await turn(env);

      const edit = await addCache(env, scout);

      expect(edit.isError).toBe(true);
      expect(JSON.stringify(edit)).toContain('Level 1 refused this: it needs the research grant');
      expect(added(env)).toBeUndefined();
    });

    it('approves and starts one with `research`', async () => {
      const env = await below(child(['replan', 'research']));
      await turn(env);

      expect((await addCache(env, scout)).isError).toBeFalsy();

      expect(env.session.planState!.approvedTasks).toContain(added(env)!.id);
      env.planner.calls.at(-1)!.finish(prose('Added.'));
      await until(() => env.run.spawnedIds().includes(added(env)!.id));
    });

    it('neither approves nor queues one a generated plan brings, which no change check met', async () => {
      const scoutTask = task('scout', 1, { research: true, taskMode: 'plan' });
      const generated = { tasks: [scoutTask], generatedAt: '2026-10-11T00:00:00Z', lastUpdated: '2026-10-11T00:00:00Z', status: 'draft' as const, runners: ['claude-code'] };
      const run = recordingRunner();
      const generate = vi.fn(async () => generated);
      const without = makeSession({ runner: run.runner, child: child(['control', 'approve']), planner: { generate } });
      await without.generatePlan('look into it', ['claude-code']);
      await settled();
      expect(without.planState!.approvedTasks ?? []).not.toContain('scout');
      expect(run.spawnedIds()).toEqual([]);

      const allowed = makeSession({ runner: run.runner, child: child(['research']), planner: { generate } });
      await allowed.generatePlan('look into it', ['claude-code']);
      await until(() => run.spawnedIds().includes('scout'));
      expect(allowed.planState!.approvedTasks).toContain('scout');
    });
  });

  describe('{ kind: \'autorun\' }: allowed all but the user\'s controls', () => {
    it.each<[Grant[], string]>([
      [['control'], 'Level 1 refused this: it needs the approve grant, and this node holds control.'],
      [['approve'], 'Level 1 refused this: it needs the control grant, and this node holds approve.'],
    ])('is narrowed by `approve` and `control`: holding %j', (grants, reason) => {
      expect(seamAt(child(grants)).consent({ kind: 'autorun' }, 'run_plan')).toEqual({ kind: 'refuse', reason });
    });

    it('allows a node that holds both', () => {
      expect(seamAt(child(['approve', 'control'])).consent({ kind: 'autorun' }, 'run_plan')).toEqual({ kind: 'allow' });
    });

    it('starts no plan a child submits without `approve`, and says why', async () => {
      const env = await below(child(['replan', 'control']), { settings: { supervisorLevel: 'off', autorun: true } });
      const opening = env.session.startPlanning('build it');
      await until(() => env.planner.calls.length === 1);
      env.planner.calls[0].finish({ kind: 'plan', text: '1. Task t2', tasks: [task('t2', 1)], researchLog: [] });
      await opening;
      await settled();

      expect(env.run.spawnedIds()).toEqual([]);
      expect(env.notices.map((n) => n.message)).toContainEqual(expect.stringContaining('Level 1 refused this: it needs the approve grant'));
    });

    it('starts one with `approve` and `control`', async () => {
      const env = await below(child(['replan', 'approve', 'control']), { settings: { supervisorLevel: 'off', autorun: true } });
      const opening = env.session.startPlanning('build it');
      await until(() => env.planner.calls.length === 1);
      env.planner.calls[0].finish({ kind: 'plan', text: '1. Task t2', tasks: [task('t2', 1)], researchLog: [] });
      await opening;

      await until(() => env.run.spawnedIds().includes('t2'));
    });
  });

  describe('ModeResolver: a runner\'s mode reads global autonomy', () => {
    const modeOfAdded = async (node: NodeAuthority | undefined, autonomousMode: boolean) => {
      const env = await supervised([task('t1', 1)], { execute: false, settings: { supervisorLevel: 'off' }, config: { autonomousMode }, ...(node ? { child: node } : {}) });
      await turn(env);
      await addCache(env);
      return added(env)!.taskMode;
    };

    it('gives a Guarded child its safe mode under a Full machine', async () => {
      expect(await modeOfAdded(child(['replan'], { autonomy: 'guarded' }), true)).toBe('auto');
    });

    it('gives a Full child its autonomous mode under a Guarded machine', async () => {
      expect(await modeOfAdded(child(['replan'], { autonomy: 'full' }), false)).toBe('bypassPermissions');
    });

    it('leaves the root reading the global level', async () => {
      expect(await modeOfAdded(undefined, true)).toBe('bypassPermissions');
      expect(await modeOfAdded(undefined, false)).toBe('auto');
    });

    it('tells the planner the mode its autonomy gives, as the conversation opens', async () => {
      const env = await below(child(['replan'], { autonomy: 'guarded' }), { config: { autonomousMode: true } });
      await turn(env);
      expect(env.planner.aiService.startConversation.mock.calls[0][0].autonomousDefault).toBe(false);
    });
  });

  describe('a subplanner\'s turn', () => {
    it('acts as the subplanner, at its depth, on every call it makes', async () => {
      const env = await below(child(['replan', 'approve', 'control'], {}, 2));
      await turn(env);

      const started = await env.planner.tools().runTask!({ task: 't1' }, ctx);

      expect(started.isError).toBeFalsy();
      expect(env.messages).toContainEqual(expect.objectContaining({ type: 'execution_action', text: 'The subplanner started task #1 "Task t1".' }));
    });

    it('starts what it holds `approve` for though nobody approved the plan, and approves it', async () => {
      const env = await below(child(['control', 'approve'], { autonomy: 'guarded' }));

      expect(await env.session.execute({ command: 'run_task', task: 't1' }, SUBPLANNER)).toMatchObject({ ok: true });

      await until(() => env.run.spawnedIds().includes('t1'));
      expect(env.session.planState!.approvedTasks).toContain('t1');
    });

    it('starts nothing unapproved without `approve`', async () => {
      const env = await below(child(['control']));

      expect(await env.session.execute({ command: 'run_task', task: 't1' }, SUBPLANNER)).toMatchObject({ ok: false, outcome: 'refused' });
      expect(env.run.spawnedIds()).toEqual([]);
    });

    it('records a script it ran as consented to by its mandate', async () => {
      const env = await below(child(['control', 'approve']), { scriptRunner: recordingRunner().runner });
      env.session.execute({ command: 'run_script', title: 'Tag it', commands: [['git', 'tag', 'v1']] }, SUBPLANNER).catch(() => undefined);
      await until(() => env.session.planTasks.some((t) => t.title === 'Tag it'));
      await settled();

      const tagged = env.session.planTasks.find((t) => t.title === 'Tag it')!;
      expect(env.session.planState!.approvedTasks).toContain(tagged.id);
    });
  });
});

describe('the root\'s mandate is read afresh, never saved (ADR-0056 M1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads Watch at the next check once a guard lowers an Act run, and the seam refuses with it', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    expect(env.session.mandate().grants.has('control')).toBe(true);
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

    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
    expect(env.session.mandate().grants.has('control')).toBe(false);
    expect(env.session.mandate().grants.has('observe')).toBe(true);
    expect((await env.planner.tools().stopTask!({ task: 't1' }, ctx)).isError).toBe(true);
  });

  it('adds nothing to what is saved with the plan', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    expect(JSON.stringify(env.session.planState)).not.toMatch(/mandate|grants|grantable/i);
  });
});

describe('mergeLanded, from tick and the run\'s end: an automatic merge passes no command (ADR-0056 M6)', () => {
  // What is due after a landing runs in a few turns of the event loop; these tests keep real timers, as a merge's git does.
  const turnOver = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const change = () => task('c1', 1, { prompt: 'change' });
  const deploy = () => task('o2', 2, { prompt: 'deploy', ops: true, dependencies: ['c1'] });

  function merging(node: NodeAuthority | undefined) {
    const isolation = new FakeWorktreeIsolation();
    const run = recordingRunner();
    const session = makeSession({
      isolation, runner: run.runner, workspaceRoot: () => '/repo', config: fakeConfig({ worktreeIsolation: true }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', mergeAtGatesAutomatically: true } }),
      ...(node ? { child: node } : {}),
    });
    const merged = () => isolation.calls.filter((c) => c.op === 'mergeIntoCheckedOut');
    const runPlan = async (tasks: ReturnType<typeof task>[]) => {
      session.loadPlan({ tasks, generatedAt: '2026-10-11T00:00:00Z', lastUpdated: '2026-10-11T00:00:00Z', status: 'approved', runners: ['claude-code'] }, 'goal', '/repo');
      await session.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(run.spawnedIds()).toContain('c1'));
      run.of('c1').reportComplete({ status: 'done', summary: 'done' });
      await vi.waitFor(() => expect(taskOf(session, 'c1')!.status).toBe('completed'));
    };
    return { session, merged, runPlan };
  }

  it('leaves a gate waiting without `merge`', async () => {
    const env = merging(child(['control']));
    await env.runPlan([change(), deploy()]);
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['c1']));
    await turnOver();

    expect(env.merged()).toEqual([]);
    env.session.destroy();
  });

  it('merges at a gate with `merge`', async () => {
    const env = merging(child(['merge']));
    await env.runPlan([change(), deploy()]);

    await vi.waitFor(() => expect(env.merged()).toHaveLength(1));
    env.session.destroy();
  });

  it('merges nothing at the run\'s end without `merge`', async () => {
    const env = merging(child(['control']));
    await env.runPlan([change()]);
    await turnOver();

    expect(env.merged()).toEqual([]);
    env.session.destroy();
  });

  it('merges at the run\'s end with `merge`', async () => {
    const env = merging(child(['merge']));
    await env.runPlan([change()]);

    await vi.waitFor(() => expect(env.merged()).toHaveLength(1));
    env.session.destroy();
  });

  it('leaves the root\'s automatic merge to the user\'s setting, at Off, where the root holds no `merge` (ADR-0029)', async () => {
    const env = merging(undefined);
    await env.runPlan([change()]);

    await vi.waitFor(() => expect(env.merged()).toHaveLength(1));
    env.session.destroy();
  });
});

describe('the tool list is filtered by grants, for a child only (ADR-0056 M6)', () => {
  function opened(node: NodeAuthority | undefined) {
    const planner = heldPlanner();
    const session = makeSession({ aiService: planner.aiService, ...(node ? { child: node } : {}) });
    session.startPlanning('build it').catch(() => undefined);
    return { planner, session };
  }

  it('fixes a child\'s list as its conversation opens, from its grants', async () => {
    const { planner, session } = opened(child([...FLOOR_GRANTS.filter((grant) => grant !== 'merge')]));
    await vi.waitFor(() => expect(planner.calls.length).toBe(1));

    expect(planner.aiService.startConversation.mock.calls[0][0].plannerTools).toMatchObject({ withheld: ['merge_all'] });
    session.destroy();
  });

  it('does not filter the root\'s', async () => {
    const { planner, session } = opened(undefined);
    await vi.waitFor(() => expect(planner.calls.length).toBe(1));

    expect(planner.aiService.startConversation.mock.calls[0][0].plannerTools?.withheld).toBeUndefined();
    session.destroy();
  });
});
