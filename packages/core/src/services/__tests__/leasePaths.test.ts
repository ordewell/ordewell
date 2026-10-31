import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenTasks } from '../../models/Task';
import type { ExecutionBackend, LeaseRequest } from '../executionLease';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * The paths that go around the command seam (research F8, F9) still pass the
 * lease: a plan edit approves a task, and research queues itself, and neither
 * starts one (ADR-0059 L1). Only a claim does, whatever approved it. The local
 * backend does the work; this watches what it was asked, and can turn a start
 * down as a full tree would.
 */

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

/** What reached the backend, and the task ids it turns down for a slot. */
function watched() {
  const seen: LeaseRequest[] = [];
  const full = new Set<string>();
  const refused = (request: LeaseRequest) => (request.node.taskId && full.has(request.node.taskId) ? 'no slot' : null);
  const execution = (local: ExecutionBackend): ExecutionBackend => ({
    probe: () => local.probe(),
    refusal: (request) => refused(request) ?? local.refusal(request),
    reserve: (request) => {
      seen.push(request);
      const no = refused(request);
      return no ? { refused: no } : local.reserve(request);
    },
    letGo: (taskId, how) => local.letGo(taskId, how),
    list: () => local.list(),
  });
  return { seen, full, execution };
}

const AUTORUN_FULL: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } };

async function userTurn(env: Env): Promise<void> {
  const n = env.planner.calls.length;
  void env.session.continueConversation('Go on').catch(() => {});
  await until(() => env.planner.calls.length === n + 1);
}

describe('adoptPlannerTasks: an edit that approves a task starts nothing itself', () => {
  async function added(watch: ReturnType<typeof watched>): Promise<Env> {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_FULL, execution: watch.execution });
    await until(() => env.run.spawnedIds().includes('t1'));
    await userTurn(env);
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    return env;
  }
  const cache = (env: Env) => flattenTasks(env.session.planTasks).find((t) => t.title === 'Add a cache')!;

  it('approves it, and it starts through a claim, so the backend reserves it', async () => {
    const watch = watched();
    const env = await added(watch);
    expect(env.session.planState!.approvedTasks).toContain(cache(env).id);

    env.planner.calls[0].finish(prose('Added.'));
    await settled();

    await until(() => env.run.spawnedIds().includes(cache(env).id));
    expect(watch.seen).toContainEqual(expect.objectContaining({ role: 'task', node: expect.objectContaining({ taskId: cache(env).id }) }));
  });

  it('leaves it ready when the backend has no slot for it: no approval is past the claim', async () => {
    const watch = watched();
    const env = await added(watch);
    watch.full.add(cache(env).id);

    env.planner.calls[0].finish(prose('Added.'));
    await settled();

    expect(env.run.spawnedIds()).not.toContain(cache(env).id);
    expect(taskOf(env.session, cache(env).id)!.status).not.toBe('in_progress');
  });
});

describe('adoptResearch: research queues as it lands, and a claim starts it', () => {
  const spec = { order: 1, type: 'ai' as const, sliceType: 'AFK' as const, autonomy: 'AFK' as const, title: 'Scout', description: 'Find the cause.', prompt: 'Investigate', readOnly: true, research: true };
  const land = async (env: Env) => {
    await userTurn(env);
    env.planner.calls.at(-1)!.finish({ kind: 'task_ops', ops: [{ op: 'add', task: spec }], text: '', researchLog: [] });
    await settled();
    await until(() => !env.session.isPlannerBusy);
  };
  const scout = (env: Env) => flattenTasks(env.session.planTasks).find((t) => t.research)!;

  it('reserves it as any task, with no run of the plan behind it', async () => {
    const watch = watched();
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, execution: watch.execution });

    await land(env);

    await until(() => env.run.spawnedIds().includes(scout(env).id));
    expect(watch.seen).toContainEqual(expect.objectContaining({ role: 'task', node: expect.objectContaining({ taskId: scout(env).id }) }));
  });

  it('waits in the queue while the backend has no slot, then starts', async () => {
    const watch = watched();
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'off' }, execution: watch.execution, execute: false });
    const refuseNext = (id: string) => watch.full.add(id);
    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => env.run.spawnedIds().includes('t1'));
    await userTurn(env);
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: spec }] }, ctx);
    expect(edit.isError).toBeFalsy();
    refuseNext(scout(env).id);
    env.planner.calls.at(-1)!.finish(prose('Scouting.'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    expect(env.run.spawnedIds()).not.toContain(scout(env).id);

    watch.full.clear();
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes(scout(env).id));
  });
});

describe('a planner turn holds a lease, in a flat session too (ADR-0059 L1)', () => {
  it('reserves as it opens and gives it back as it ends, and holds no slot of a flat run', async () => {
    const watch = watched();
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' }, execution: watch.execution });

    await userTurn(env);
    expect(watch.seen.filter((r) => r.role === 'planner')).toHaveLength(1);

    env.planner.calls[0].finish(prose('Done.'));
    await until(() => !env.session.isPlannerBusy);
    await userTurn(env);

    expect(watch.seen.filter((r) => r.role === 'planner')).toHaveLength(2);
  });

  it('a turn on one lease takes one however it is opened: a flat planner is not restarted between turns', async () => {
    const env = await supervised([], { execute: false, settings: { supervisorLevel: 'off' } });
    await userTurn(env);
    env.planner.calls[0].finish(prose('Done.'));
    await until(() => !env.session.isPlannerBusy);
    expect(env.planner.aiService.restart).not.toHaveBeenCalled();
  });
});

