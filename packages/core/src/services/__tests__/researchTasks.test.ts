import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenTasks } from '../../models/Task';
import { applyTaskOps, type TaskOp } from '../TaskOps';
import { validatePlanTasks } from '../PlanValidator';
import { serializeTask } from '../SessionMessage';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { makeSession, saves, taskOf, testWorkspace } from './sessionTestKit';
import { changeSettings, heldPlanner, NOW, prose, settled, supervised, task, until, wokenUp, type Env } from './supervisorTestKit';

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

const spec = (title = 'Scout', order = 1) => ({ order, type: 'ai' as const, sliceType: 'AFK' as const, autonomy: 'AFK' as const, title, description: 'Find the cause and report evidence.', prompt: 'Investigate', readOnly: true, research: true });
const research = (env: Env) => flattenTasks(env.session.planTasks).filter((t) => t.research);

async function userTurn(env: Env): Promise<void> {
  const n = env.planner.calls.length;
  void env.session.continueConversation('Investigate the problem').catch(() => {});
  await until(() => env.planner.calls.length === n + 1);
}

async function land(env: Env, ops: TaskOp[]): Promise<void> {
  env.planner.calls.at(-1)!.finish({ kind: 'task_ops', ops, text: '', researchLog: [] });
  await settled();
  await until(() => !env.session.isPlannerBusy);
}

async function add(env: Env, count = 1): Promise<void> {
  await land(env, Array.from({ length: count }, (_, i) => ({ op: 'add', task: spec(`Scout ${i}`, i + 1) })));
}

async function report(env: Env, taskId: string, status: 'done' | 'failed' | 'blocked' = 'done', summary = 'Evidence: the cache key omits the tenant.'): Promise<void> {
  env.run.of(taskId).reportComplete({ status, summary, ...(status !== 'done' ? { reason: 'Cannot read the missing fixture' } : {}) });
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
}

describe('research intake (ADR-0037 R1)', () => {
  it('keeps research through plan intake and serialization', () => {
    const result = validatePlanTasks({ tasks: [{ id: 'r', ...spec() }] }, ['claude-code']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(serializeTask(result.tasks[0]).research).toBe(true);
  });

  it.each([
    { ...spec(), readOnly: false },
    { ...spec(), type: 'user', sliceType: 'HITL' },
    { ...spec(), type: 'script', commands: [['true']] },
    { ...spec(), research: 'yes' },
    { title: 'Parent', subtasks: [spec()] },
  ])('refuses research outside a top-level read-only AI task: %j', (raw) => {
    const result = validatePlanTasks({ tasks: [raw] }, ['claude-code']);
    expect(result.ok).toBe(false);
  });

  it('refuses a research task in a loop body, including an edit that puts it there', () => {
    const check = task('check', 1, { loop: { body: ['r'], maxRounds: 3 } });
    const body = task('r', 2, { research: true, taskMode: 'plan', dependencies: ['check'] });
    expect(applyTaskOps([check, body], [{ op: 'update', taskId: 'r', changes: { title: 'Changed' } }], ['claude-code']).ok).toBe(true);
    const ordinary = { ...body, research: undefined };
    const result = applyTaskOps([check, ordinary], [{ op: 'update', taskId: 'r', changes: { research: true } }], ['claude-code']);
    expect(result.ok).toBe(false);
  });
});

describe('research reports and authority (ADR-0037 R2, R3)', () => {
  it('batches research reports at Off into one turn', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' } });
    await userTurn(env);
    await add(env, 2);
    await until(() => env.run.spawnedIds().length === 2);
    for (const [i, r] of research(env).entries()) env.run.of(r.id).reportComplete({ status: 'done', summary: `Report ${i}` });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('Report 0');
    expect(env.planner.calls[1].message).toContain('Report 1');
  });

  it.each(['off', 'watch', 'act'] as const)('wakes at %s with the whole task_complete summary and user authority', async (supervisorLevel) => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel } });
    await userTurn(env);
    await add(env);
    const r = research(env)[0];
    await until(() => env.run.spawnedIds().includes(r.id));
    const summary = 'Evidence and findings.\n' + 'Full detail. '.repeat(300);
    await report(env, r.id, 'done', summary);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain(summary.replaceAll('\n', '\n  ').trimEnd());
    expect(env.planner.calls[1].message).toContain('You act as in that turn');
    await land(env, [{ op: 'add', task: { title: 'Fix the cache', prompt: 'fix', sliceType: 'AFK' } }]);
    expect(flattenTasks(env.session.planTasks).some((t) => t.title === 'Fix the cache')).toBe(true);
  });

  it('wakes with the handoff summary and top findings, and leaves its report in the log', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    await userTurn(env);
    await add(env);
    const r = research(env)[0];
    await until(() => env.run.spawnedIds().includes(r.id));
    env.run.of(r.id).reportComplete({
      status: 'done',
      summary: 'The cache key omits the tenant.',
      findings: [{ severity: 'blocker', title: 'Cache key leaks across tenants', detail: 'A second tenant reads the first one\'s entry.' }],
      report: 'The long report, which a wake-up never carries.',
    });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    const message = env.planner.calls[1].message;
    expect(message).toContain('It passed.');
    expect(message).toContain('The cache key omits the tenant.');
    expect(message).toContain('- F1 [blocker] Cache key leaks across tenants');
    expect(message).toContain('  A second tenant reads the first one\'s entry.');
    expect(message).toContain('The report, if the task wrote one, is in the attempt\'s log: read it with task_output.');
    expect(message).not.toContain('The long report, which a wake-up never carries.');
  });

  it.each(['failed', 'blocked'] as const)('wakes at Off on a %s result with its reason', async (status) => {
    const env = await supervised([], { settings: { supervisorLevel: 'off' }, execute: false });
    await userTurn(env);
    await add(env);
    await until(() => env.run.spawnedIds().length === 1);
    await report(env, research(env)[0].id, status);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('Cannot read the missing fixture');
    expect(env.planner.calls[1].message).toContain(status === 'blocked' ? 'It was blocked' : 'It failed');
  });

  it('owes the report to the supervisor that started it, and wakes that authority after a lowering', async () => {
    const env = await wokenUp({ settings: { supervisorLevel: 'act' } });
    await add(env);
    const r = research(env)[0];
    await until(() => env.run.spawnedIds().includes(r.id));
    expect(taskOf(env.session, r.id)?.reportTo).toMatchObject({ actor: 'supervisor', level: 'act', research: true });
    changeSettings(env, { supervisorLevel: 'off' });
    await report(env, r.id);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain('cannot act in this turn');
    expect(env.planner.calls[1].message).not.toContain('You act as in that turn');
  });
});

describe('research starts (ADR-0037 R4)', () => {
  it('starts research submitted in the conversation opening without executing the rest of the plan', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' } });
    const opening = env.session.startPlanning('Investigate');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish({ kind: 'plan', text: '', tasks: [task('scout', 1, { research: true, taskMode: 'plan' }), task('fix', 2)], researchLog: [] });
    await opening;
    await until(() => env.run.spawnedIds().length === 1);
    expect(env.run.spawnedIds()).toEqual(['scout']);
  });

  it('keeps a stopped research run stopped when another planner turn ends', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 1 } });
    await userTurn(env);
    await add(env, 2);
    await until(() => env.run.spawnedIds().length === 1);
    env.session.stopExecution();
    await userTurn(env);
    env.planner.calls.at(-1)!.finish(prose('Stopped.'));
    await settled();
    expect(env.run.spawnedIds()).toHaveLength(1);
  });

  it('starts without approval under Guarded, with autorun off and the plan unapproved', async () => {
    const env = await supervised([task('t1', 1)], { execute: false, config: { autonomousMode: false }, plan: { status: 'draft', approved: false }, settings: { supervisorLevel: 'off' } });
    await userTurn(env);
    await add(env);
    await until(() => env.run.spawnedIds().length === 1);
    expect(env.run.spawnedIds()).toEqual([research(env)[0].id]);
    expect(env.messages.some((m) => m.type === 'approval_request')).toBe(false);
    expect(env.session.planState!.approved).toBe(false);
    expect(env.session.waitsForApproval(research(env)[0].id)).toBe(false);
  });

  it('leaves a draft unmoving when its research builds on work only the plan\'s approval starts, and starts it in the run approval opens', async () => {
    const env = await supervised([], { execute: false, plan: { status: 'draft', approved: false }, settings: { supervisorLevel: 'off' } });
    const opening = env.session.startPlanning('Investigate');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish({ kind: 'plan', text: '', tasks: [task('check', 1), task('scout', 2, { research: true, taskMode: 'plan', dependencies: ['check'] }), task('later', 3, { research: true, taskMode: 'plan', dependencies: ['scout'] })], researchLog: [] });
    await opening;
    await settled();
    // Nothing starts before the user approves the plan, so the session offers Approve, not Stop.
    expect(env.session.activity.advancesOnItsOwn).toBe(false);
    expect(env.run.spawnedIds()).toEqual([]);
    expect(env.session.isApproved('scout')).toBe(true);

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'done', summary: 'Done.' });
    env.run.of('check').emitExit(0);
    await settled();
    await until(() => env.run.spawnedIds().includes('scout'));
  });

  it('shares the run\'s Parallel limit with other tasks, and holds the rest for the ordinary slot', async () => {
    const env = await supervised([task('ordinary', 1)], { settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 2 } });
    await until(() => env.run.spawnedIds().includes('ordinary'));
    await userTurn(env);
    await land(env, [2, 3, 4].map((order) => ({ op: 'add', task: spec(`Scout ${order}`, order) })));
    await until(() => env.run.spawnedIds().length === 2);
    const [first, held] = research(env);
    expect(env.run.spawnedIds().sort()).toEqual(['ordinary', first.id].sort());

    env.run.of('ordinary').reportComplete({ status: 'done', summary: 'Done.' });
    env.run.of('ordinary').emitExit(0);
    await settled();
    // A slot freed: the held task starts without a new user message or a research-specific wait.
    await until(() => env.run.spawnedIds().includes(held.id));
  });

  it.each(['research', 'readOnly'] as const)('withdraws automatic approval when an edit removes %s', async (field) => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 1 } });
    await userTurn(env);
    await add(env, 2);
    await until(() => env.run.spawnedIds().length === 1);
    const r = research(env)[1];
    await userTurn(env);
    await land(env, [{ op: 'update', taskId: r.id, changes: { [field]: false } }]);
    expect(env.session.isApproved(r.id)).toBe(false);
    expect(env.session.waitsForApproval(r.id)).toBe(true);
    await report(env, research(env)[0].id);
    expect(env.run.spawnedIds()).toHaveLength(1);
  });

  it('withdraws automatic approval when the user lifts the read-only profile directly', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 1 } });
    await userTurn(env);
    await add(env, 2);
    await until(() => env.run.spawnedIds().length === 1);
    const r = research(env)[1];
    await env.session.updateTask(r.id, { taskMode: 'default' });
    expect(env.session.isApproved(r.id)).toBe(false);
    expect(taskOf(env.session, r.id)?.research).toBe(false);
  });

  it('wakes the planner after reload with a report already queued behind a turn', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, plan: {
      pendingTurns: [{ id: 'report', source: 'supervisor', text: 'Run update: the queued research report', report: 'user', timestamp: NOW.toISOString() }],
    } });
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('the queued research report');
  });

  it('keeps a queued report idle after reload while a planner usage-limit wait is saved', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, plan: {
      plannerResend: { runner: 'claude-code', at: new Date(NOW.getTime() + 3_600_000).toISOString() },
      pendingTurns: [{ id: 'report', source: 'supervisor', text: 'Run update: the queued research report', report: 'user', timestamp: NOW.toISOString() }],
    } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.planner.calls).toHaveLength(0);
  });

  it('keeps a report → research → report chain going at Off with no user message, with no per-message cap', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' } });
    await userTurn(env);
    await add(env);
    await until(() => env.run.spawnedIds().includes(research(env)[0].id));

    // Each report turn starts the next round; no user message opens any of them.
    for (let round = 1; round <= 3; round++) {
      await report(env, research(env)[round - 1].id, 'done', `Report ${round}`);
      await until(() => env.planner.calls.length === round + 1);
      expect(env.planner.calls.at(-1)!.message).toContain(`Report ${round}`);
      await land(env, [{ op: 'add', task: spec(`Scout ${round}`, round + 1) }]);
      await until(() => env.run.spawnedIds().includes(research(env)[round].id));
    }
    expect(env.planner.calls).toHaveLength(4);
  });

  it('reloads research tasks and an undelivered report', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' } });
    await userTurn(env);
    await add(env);
    await until(() => env.run.spawnedIds().length === 1);
    env.run.of(research(env)[0].id).reportComplete({ status: 'done', summary: 'Saved report' });
    await settled();
    const saved = structuredClone(saves(env.session).mock.calls.at(-1)![0]);
    expect(saved.supervision!.wake!.policy.attention).toEqual([expect.objectContaining({ kind: 'task_report' })]);
    env.session.destroy();
    const planner = heldPlanner();
    const session = makeSession({ aiService: planner.aiService });
    session.loadPlan(saved, 'Investigate', testWorkspace);
    expect(session.planTasks[0].research).toBe(true);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => planner.calls.length === 1);
    expect(planner.calls[0].message).toContain('Saved report');
    session.destroy();
  });
});
