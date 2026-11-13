import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../SessionMessage';
import { fakeConfig, makeSession, saves, taskOf, type SessionOverrides } from './sessionTestKit';
import { ctx, heldPlanner, NOW, plan, prose, settled, supervised, task, until, type Options } from './supervisorTestKit';

/**
 * A successful submit_plan or edit_plan call commits as it answers
 * (ADR-0022 P2): the plan, the save and the broadcast all hold it while the
 * planner's reply is still open.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A plan not yet run, with the user's turn open and the planner's reply in the test's hands. */
async function openTurn(overrides: SessionOverrides = {}) {
  const planner = heldPlanner();
  const broadcast = vi.fn<(msg: SessionMessage) => void>();
  const session = makeSession({ aiService: planner.aiService, broadcast, ...overrides });
  session.loadPlan(plan([task('t1', 1), task('t2', 2)], { status: 'draft' }), 'build it', process.cwd());
  const reply = session.continueConversation('rename the first task');
  await until(() => planner.calls.length === 1);
  broadcast.mockClear();
  saves(session).mockClear();
  return { session, planner, broadcast, reply };
}

const rename = { ops: [{ op: 'update' as const, taskId: 't1', changes: { title: 'Renamed' } }] };

describe('an edit_plan call', () => {
  it('commits, saves and broadcasts before the reply ends', async () => {
    const { session, planner, broadcast } = await openTurn();

    const answer = await planner.tools().editPlan!(rename, ctx);

    expect(answer.isError).toBeFalsy();
    expect(session.planTasks[0].title).toBe('Renamed');
    expect(saves(session).mock.calls.at(-1)?.[0].tasks[0].title).toBe('Renamed');
    expect(broadcast.mock.calls.some(([msg]) => msg.type === 'plan_generated' && msg.plan?.tasks[0].title === 'Renamed')).toBe(true);
    expect(planner.calls).toHaveLength(1);
  });
});

/** The tool's JSON answer. */
const body = (reply: { text: string }) => JSON.parse(reply.text) as Record<string, unknown>;

const twoTasks = {
  tasks: [
    { id: 'a', title: 'Schema', description: 'Add the table', type: 'ai', prompt: 'add the table', dependencies: [], sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code' },
    { id: 'b', title: 'Endpoint', description: 'Serve it', type: 'ai', prompt: 'serve it', dependencies: ['a'], sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code' },
  ],
} as never;

describe('a submit_plan call', () => {
  it('is the plan the same turn edits and reads next', async () => {
    const planner = heldPlanner();
    const session = makeSession({ aiService: planner.aiService });
    void session.startPlanning('add an endpoint', ['claude-code']);
    await until(() => planner.calls.length === 1);

    const submitted = await planner.tools().submitPlan!(twoTasks, ctx);
    expect(submitted.isError).toBeFalsy();
    expect(body(submitted).tasks).toEqual([
      { id: 'a', ref: '#1', title: 'Schema' },
      { id: 'b', ref: '#2', title: 'Endpoint' },
    ]);
    expect(session.planTasks.map((t) => t.id)).toEqual(['a', 'b']);

    const edited = await planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { title: 'JSON endpoint' } }] }, ctx);
    expect(edited.isError).toBeFalsy();

    const read = body(await planner.tools().taskQuery!({ tasks: ['b'] }, ctx));
    expect(read.tasks).toEqual([expect.objectContaining({ title: 'JSON endpoint' })]);
    expect(planner.calls).toHaveLength(1);
  });
});

describe('a submit_plan call over a finished task that waits on an unfinished one', () => {
  // "x" ran before "y", which was re-armed since: a rewrite is judged with x as it stands, its dependency kept.
  async function restating() {
    const planner = heldPlanner();
    const session = makeSession({ aiService: planner.aiService });
    session.loadPlan(plan([task('y', 1), task('x', 2, { status: 'completed', dependencies: ['y'] })], { status: 'draft' }), 'build it', process.cwd());
    void session.continueConversation('restate the plan');
    await until(() => planner.calls.length === 1);
    return { session, planner };
  }
  const spec = (id: string, dependencies: string[] = []) => ({ id, title: `Task ${id}`, description: id, type: 'ai', prompt: `do ${id}`, dependencies, sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code' });

  it('is refused for listing it ahead of its dependency, and leaves the plan open to the next edit', async () => {
    const { session, planner } = await restating();

    const submitted = await planner.tools().submitPlan!({ tasks: [spec('x'), spec('y')] } as never, ctx);
    const edited = await planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 'y', changes: { title: 'Again' } }] }, ctx);

    expect(submitted.isError).toBe(true);
    expect(edited.isError).toBeFalsy();
    expect(session.planTasks.map((t) => [t.id, t.title])).toEqual([['y', 'Again'], ['x', 'Task x']]);
    expect(session.planTasks[1].status).toBe('completed');
  });

  it('is refused for the cycle the kept dependency closes', async () => {
    const { session, planner } = await restating();

    const submitted = await planner.tools().submitPlan!({ tasks: [spec('x'), spec('y', ['x'])] } as never, ctx);

    expect(submitted.isError).toBe(true);
    expect(body(submitted).errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/^Dependency cycle detected: /) })]);
    expect(session.planTasks.map((t) => t.dependencies)).toEqual([[], ['y']]);
  });
});

describe('successive edit_plan calls in one reply', () => {
  it('are batches of their own: a refused one leaves the one before it committed', async () => {
    const { session, planner } = await openTurn();

    expect((await planner.tools().editPlan!(rename, ctx)).isError).toBeFalsy();
    const refused = await planner.tools().editPlan!({ ops: [
      { op: 'update', taskId: 't2', changes: { title: 'Also renamed' } },
      { op: 'remove', taskId: 'nonesuch' },
    ] }, ctx);

    expect(refused.isError).toBe(true);
    expect(body(refused).errors).toEqual([{ op: 2, kind: 'remove', message: expect.stringContaining('nonesuch') }]);
    expect(session.planTasks.map((t) => t.title)).toEqual(['Renamed', 'Task t2']);
  });

  it('made at once both commit, neither over the other', async () => {
    const { session, planner } = await openTurn();

    const [first, second] = await Promise.all([
      planner.tools().editPlan!(rename, ctx),
      planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't2', changes: { title: 'Second' } }] }, ctx),
    ]);

    expect([first.isError, second.isError]).toEqual([undefined, undefined]);
    expect(session.planTasks.map((t) => t.title)).toEqual(['Renamed', 'Second']);
  });
});

describe('a task an edit_plan call adds', () => {
  const AUTORUN_FULL: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } };

  /** A plan the user ran, its one task finished, and the user's next turn open. */
  async function finishedRun() {
    const env = await supervised([task('t1', 1)], AUTORUN_FULL);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    void env.session.continueConversation('also add a cache and run it');
    await until(() => env.planner.calls.length === 1);
    return env;
  }

  it('is answered with its id and reference, and its handle names it to a later call of the same reply', async () => {
    const env = await finishedRun();

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' }, handle: 'cache' }] }, ctx);
    const id = env.session.planTasks[1].id;
    expect(body(edit)).toMatchObject({ added: [{ id, ref: '#2', title: 'Add a cache' }], handles: { cache: { id, ref: '#2', title: 'Add a cache' } } });

    const again = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 'cache', changes: { prompt: 'add an LRU cache' } }] }, ctx);
    expect(again.isError).toBeFalsy();
    expect(taskOf(env.session, id)!.prompt).toBe('add an LRU cache');

    const started = await env.planner.tools().runTask!({ task: 'cache' }, ctx);
    expect(started.isError).toBeFalsy();
    await until(() => env.run.spawnedIds().includes(id));
    expect(env.run.runner.spawn.mock.calls.find(([o]) => o.taskId === id)?.[0].prompt).toContain('add an LRU cache');
  });
});

describe('an edit committed while tasks run', () => {
  async function liveTurn() {
    const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: 'off' } });
    void env.session.continueConversation('add a docs task');
    await until(() => env.planner.calls.length === 1);
    return env;
  }

  it('approves nothing it adds, and starts nothing past the turn\'s hold', async () => {
    const env = await liveTurn();
    const spawned = env.run.spawnedIds();

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Docs', prompt: 'write docs' }, handle: 'docs' }] }, ctx);
    expect(edit.isError).toBeFalsy();
    const docs = env.session.planTasks.find((t) => t.title === 'Docs')!;
    await settled();

    expect(env.run.spawnedIds()).toEqual(spawned);
    expect(env.session.planState!.approvedTasks ?? []).not.toContain(docs.id);
    const start = await env.planner.tools().runTask!({ task: 'docs' }, ctx);
    expect(start.isError).toBe(true);
    expect(body(start).reason).toMatch(/added after the user approved the plan/);

    env.planner.calls[0].finish(prose('Added a docs task.'));
    await settled();
    expect(env.run.spawnedIds()).not.toContain(docs.id);
  });

  it('is refused whole when it reaches a running task', async () => {
    const env = await liveTurn();
    const running = env.run.spawnedIds()[0];

    const edit = await env.planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Docs', prompt: 'write docs' } },
      { op: 'update', taskId: running, changes: { prompt: 'changed' } },
    ] }, ctx);

    expect(edit.isError).toBe(true);
    expect(env.session.planTasks.map((t) => t.title)).toEqual(['Task t1', 'Task t2']);
  });

  it('refuses a whole plan, which only an edit may change running work under', async () => {
    const env = await liveTurn();

    const submitted = await env.planner.tools().submitPlan!(twoTasks, ctx);

    expect(submitted.isError).toBe(true);
    expect(submitted.text).toContain('whole new plan cannot replace this one now');
    expect(env.session.planTasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('a turn that ends badly after an edit committed', () => {
  const tail = (session: ReturnType<typeof makeSession>) =>
    (session.planState!.conversationHistory ?? []).slice(2).map((e) => ({ role: e.role, content: e.content, ...(e.kind ? { kind: e.kind } : {}) }));

  it('keeps the edit, and the message it answered, when the user stops the reply', async () => {
    const { session, planner, reply } = await openTurn();
    await planner.tools().editPlan!(rename, ctx);

    planner.state.saidBeforeStop = '';
    session.abortPlannerTurn();
    await reply.catch(() => undefined);

    expect(session.planTasks[0].title).toBe('Renamed');
    expect(tail(session)).toEqual([
      { role: 'user', content: 'rename the first task' },
      { role: 'assistant', content: 'Tasks updated:\n- Updated "Task t1" (title)' },
    ]);
    expect(saves(session).mock.calls.at(-1)?.[0].tasks[0].title).toBe('Renamed');
    expect(session.planState!.pendingTurns ?? []).toEqual([]);
  });

  it('keeps the edit when the planner fails after it', async () => {
    const { session, planner, reply } = await openTurn();
    await planner.tools().editPlan!(rename, ctx);

    planner.calls[0].fail(new Error('the agent crashed'));
    await expect(reply).rejects.toThrow('the agent crashed');

    expect(session.planTasks[0].title).toBe('Renamed');
    expect(tail(session).map((e) => e.content)).toEqual(['rename the first task', 'Tasks updated:\n- Updated "Task t1" (title)']);
  });

  it('keeps the edit, and sends nothing again, when the planner hits its usage limit after it', async () => {
    const { session, planner, reply } = await openTurn({ config: fakeConfig({ aiProvider: 'claude-code' }) });
    await planner.tools().editPlan!(rename, ctx);

    planner.calls[0].finish({ kind: 'message', text: "You've hit your usage limit · resets 11pm", researchLog: [], failed: true });
    await reply.catch(() => undefined);

    expect(session.planTasks[0].title).toBe('Renamed');
    expect(tail(session).map((e) => e.kind ?? e.role)).toEqual(['user', 'assistant', 'error']);
    expect(session.planState!.pendingTurns ?? []).toEqual([]);
    // Nothing waits for the reset: the message was answered by the edit it made.
    expect(session.planState!.plannerResend).toBeUndefined();
    expect(tail(session).at(-1)!.content).toMatch(/nothing waits to be sent again\.$/);
  });
});

describe('an opening that hits the usage limit after submit_plan committed', () => {
  it('keeps the plan and its goal, and puts nothing back to be sent again', async () => {
    const planner = heldPlanner();
    const session = makeSession({ aiService: planner.aiService, config: fakeConfig({ aiProvider: 'claude-code' }) });
    const opened = session.startPlanning('add an endpoint', ['claude-code']);
    await until(() => planner.calls.length === 1);
    expect((await planner.tools().submitPlan!(twoTasks, ctx)).isError).toBeFalsy();

    planner.calls[0].finish({ kind: 'message', text: "You've hit your usage limit · resets 11pm", researchLog: [], failed: true });
    await opened;

    expect(session.planTasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect((session.planState!.conversationHistory ?? []).map((e) => e.kind ?? e.role)).toEqual(['user', 'plan_generated', 'error']);
    expect(session.planState!.pendingTurns ?? []).toEqual([]);
    expect(session.planState!.plannerResend).toBeUndefined();
  });
});

describe('the reply that ends a turn an edit committed in', () => {
  const addDocs = { ops: [{ op: 'add' as const, task: { title: 'Docs', prompt: 'write docs' } }] };

  it('lands beside the edit, which it neither applies again nor gives new ids', async () => {
    const { session, planner, reply } = await openTurn();
    await planner.tools().editPlan!(addDocs, ctx);
    const ids = session.planTasks.map((t) => t.id);

    planner.calls[0].finish({ kind: 'message', text: 'Added a docs task.', researchLog: [] });
    await reply;

    expect(session.planTasks.map((t) => t.id)).toEqual(ids);
    expect((session.planState!.conversationHistory ?? []).slice(2).map((e) => e.content)).toEqual([
      'rename the first task', 'Tasks updated:\n- Added "Docs"', 'Added a docs task.',
    ]);
  });

  it('writes nothing over it with an edit envelope it carries', async () => {
    const { session, planner, reply } = await openTurn();
    await planner.tools().editPlan!(addDocs, ctx);
    const after = session.planTasks.map((t) => [t.id, t.title]);

    planner.calls[0].finish({ kind: 'task_ops', ops: [{ op: 'remove', taskId: 't1' }], text: 'Done.', researchLog: [] });
    await reply;

    expect(session.planTasks.map((t) => [t.id, t.title])).toEqual(after);
  });

  it('adds no line of its own when it says nothing', async () => {
    const { session, planner, reply } = await openTurn();
    await planner.tools().editPlan!(addDocs, ctx);

    planner.calls[0].finish({ kind: 'message', text: '', researchLog: [] });
    await reply;

    expect(session.planState!.conversationHistory?.at(-1)?.content).toBe('Tasks updated:\n- Added "Docs"');
  });
});
