import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveSession, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { sessionsRoute } from '../sessions';
import { plansRoute } from '../plans';
import { childrenRoute } from '../children';
import { approvalsRoute } from '../approvals';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

const plan = {
  status: 'approved',
  runners: ['opencode'],
  generatedAt: '2026-07-21T10:00:00.000Z',
  tasks: [{
    id: 't1', order: 1, title: 'Wire it up', type: 'ai', status: 'pending',
    description: 'd', prompt: 'wire it up', dependencies: [], assignedRunner: 'opencode', subtasks: [],
  }],
} as unknown as LegacyPlanState;

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The guard a request passes is only as good as the moment it is judged. A
 * request from B that passed it while B held the id, or while nobody did, and
 * then waited — on its body, or on a tree stop — must not find A's session of
 * the same id when it acts: by then the id names another project's session.
 */
describe('a request from one workspace that waits cannot act on the session another workspace opened meanwhile', () => {
  let a: string;
  let b: string;
  let pool: OrchestratorPool;
  let app: Hono;

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-race-'));
    mkdirSync(join(dir, '.git'));
    return dir;
  };

  beforeEach(() => {
    a = project();
    b = project();
    saveSession(plan, 'Goal', a, 'session-a');
    saveSession(plan, 'Goal', b, 'session-a');
    pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
    app = new Hono()
      .route('/api/sessions', sessionsRoute(pool))
      .route('/api/sessions', childrenRoute(pool))
      .route('/api/plans', plansRoute(pool))
      .route('/api/approvals', approvalsRoute(pool));
  });

  afterEach(() => {
    pool.destroyAll();
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  const load = (workspace: string) => app.request(`/api/sessions/session-a/load?workspace=${encodeURIComponent(workspace)}`, { method: 'POST' });

  /** B's request, its body held back until `release`: the handler is past the guard, waiting to read it. */
  const stalled = (method: string, path: string, body: object) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    });
    const pending = app.fetch(new Request(`http://x${path}?workspace=${encodeURIComponent(b)}`, {
      method, body: stream, duplex: 'half', headers: { 'content-type': 'application/json' },
    } as RequestInit & { duplex: 'half' }));
    return { pending, release };
  };

  const refused = async (res: Response) => {
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('refused');
  };

  /** A's session, as A's own client sees it, so a test can say it was left alone. */
  const aSees = () => {
    const live = pool.session('session-a', a);
    return { tasks: live.planTasks.map((t) => ({ title: t.title, status: t.status })), turns: live.planState?.conversationHistory?.length ?? 0 };
  };

  it.each([
    ['a task edit', 'PUT', '/api/plans/session-a/tasks/t1', { title: 'Theirs' }],
    ['a task added', 'POST', '/api/plans/session-a/tasks', { title: 'Theirs' }],
    ['an execution command', 'POST', '/api/plans/session-a/execute-command', { command: 'skip_task', task: 't1' }],
    ['a checkpoint answer', 'POST', '/api/plans/session-a/tasks/t1/checkpoint/approve', {}],
    ['an escalation answer', 'POST', '/api/plans/session-a/escalations/answer', { id: 'e1', option: 'retry' }],
    ['a runner command', 'POST', '/api/plans/session-a/tasks/t1/commands', { name: 'compact' }],
    ['a merge all', 'POST', '/api/plans/session-a/isolation/merge', {}],
    ['a rewind', 'POST', '/api/plans/session-a/conversation/rewind', { index: 0 }],
    ['a reply to the planner', 'POST', '/api/plans/session-a/converse/message', { message: 'Theirs' }],
    ['a send now', 'POST', '/api/plans/session-a/converse/message/now', { message: 'Theirs' }],
  ])('%s from B whose body arrives after A loaded the id is refused, and A\'s plan is as it was', async (_name, method, path, body) => {
    const { pending, release } = stalled(method, path, body);
    await tick(100);
    expect((await load(a)).status).toBe(200);
    const before = aSees();

    release();

    await refused(await pending);
    expect(aSees()).toEqual(before);
    expect(pool.holds('session-a', a)).toBe(true);
  });

  it('a child plan message from B whose body arrives after A loaded the id is refused, not looked up in A\'s tree', async () => {
    const { pending, release } = stalled('POST', '/api/sessions/session-a/children/c1/message', { message: 'Theirs' });
    await tick(100);
    expect((await load(a)).status).toBe(200);

    release();

    await refused(await pending);
  });

  it('an approval answer from B whose body arrives after B\'s session gave way to A\'s is refused', async () => {
    expect((await load(b)).status).toBe(200);
    const { pending, release } = stalled('POST', '/api/approvals/session-a/ap1', { decision: 'allow' });
    await tick(100);
    await pool.close('session-a', b);
    expect((await load(a)).status).toBe(200);

    release();

    await refused(await pending);
    expect(pool.holds('session-a', a)).toBe(true);
  });

  it('a delete from B that started while B held the id leaves A\'s session, opened during the tree stop, open', async () => {
    expect((await load(b)).status).toBe(200);
    // The tree stop is slow, as stopping child tasks can be.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stop = pool.stopTree.bind(pool);
    pool.stopTree = async (id, workspace) => { await gate; await stop(id, workspace); };

    const deleting = app.request(`/api/sessions/session-a?workspace=${encodeURIComponent(b)}`, { method: 'DELETE' });
    await tick(50);
    // B's session goes while its delete is still in the stop: another of B's
    // clients closed it, and A adopts its own saved copy of the id.
    await pool.close('session-a', b);
    expect((await load(a)).status).toBe(200);
    const live = pool.session('session-a', a);

    release();
    expect(((await (await deleting).json()) as { ok: boolean }).ok).toBe(true);

    expect(pool.holds('session-a', a)).toBe(true);
    expect(pool.session('session-a', a)).toBe(live);
  });
});
