/*
 * Reaching into a delegated tree from a surface (ADR-0055 D20), on real
 * repositories: any child plan selected by its stable id, watched as it runs,
 * and spoken to under the mandate it already holds.
 */

// Part of childNavigation.e2e: split by describe so CI's shards (vitest splits by file) balance. Helpers: childNavigationKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ChildFrame } from '../ChildDirectory';
import type { Session } from '../createSession';
import { FakeRunnerSession, removeDir } from '../../testing';
import { closeSessions, type PlannerTurn as Turn } from './sessionTestKit';
import { roots, heldTasks, delegated, childTask, nestedTask, nestedCheck, SUBMIT, DONE, REPLY, tree, WAIT, deferred } from './childNavigationKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

describe('what becomes of a message', () => {
  const held = async (held: string[], turns: Record<string, Turn[]>) => {
    const { runner, release } = heldTasks(held);
    const built = tree(turns, { runner });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(held), WAIT);
    const [entry] = await built.parent.children.list();
    const child = (await built.parent.children.find(entry.sessionId))!;
    await vi.waitFor(() => expect(child.entry().state).toBe('parked'), WAIT);
    const frames: ChildFrame[] = [];
    child.watch((frame) => frames.push(frame));
    return { ...built, child, frames, release };
  };
  const notices = (frames: ChildFrame[]) => frames.flatMap((frame) => (frame.type === 'notice' ? [frame] : []));

  it('joins what waits for one child in order, one turn taking it all and saying once who spoke', async () => {
    const gate = deferred();
    const { parent, child, planners, release } = await held(['a'], {
      d: [SUBMIT([childTask('a', 1)]), async () => { await gate.promise; }, REPLY, DONE],
    });

    expect(child.message('first')).toEqual({ ok: true, status: 'woken' });
    expect(child.message('second')).toEqual({ ok: true, status: 'queued' });
    expect(child.message('third')).toEqual({ ok: true, status: 'queued' });
    const before = planners.d.asked.length;
    gate.resolve();

    await vi.waitFor(() => expect(planners.d.asked.length).toBe(before + 1), WAIT);
    const asked = planners.d.asked.at(-1)!;
    expect(asked.indexOf('second')).toBeLessThan(asked.indexOf('third'));
    expect(asked.match(/a person watching/g)).toHaveLength(1);
    release('a');
    parent.destroy();
  });

  it('tells whoever watches when a Stop ends the child with a message still unread', async () => {
    const gate = deferred();
    const { parent, child, frames, planners, release } = await held(['a'], {
      d: [SUBMIT([childTask('a', 1)]), () => gate.promise],
    });
    expect(child.message('first')).toEqual({ ok: true, status: 'woken' });
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('first'), WAIT);
    expect(child.message('also do b')).toEqual({ ok: true, status: 'queued' });

    await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    await vi.waitFor(() => expect(notices(frames).map((notice) => notice.message)).toContainEqual(expect.stringMatching(/before its subplanner answered your message/)), WAIT);
    expect(notices(frames).filter((notice) => /your message/.test(notice.message))).toHaveLength(1);
    expect(planners.d.asked.join('\n')).not.toContain('also do b');
    gate.resolve();
    release('a');
    parent.destroy();
  });

  it('tells whoever watches when a Stop ends the child with a message held on its usage limit', async () => {
    const limited: Turn = async () => ({ kind: 'message', text: 'You have hit your usage limit', researchLog: [], failed: true, usageLimit: { resetsAt: Date.now() + 3_600_000 } });
    const { parent, child, frames, planners, release } = await held(['a'], { d: [SUBMIT([childTask('a', 1)]), limited] });
    expect(child.message('first')).toEqual({ ok: true, status: 'woken' });
    await vi.waitFor(() => expect(child.view().plan?.plannerResend?.at).toBeDefined(), WAIT);
    expect(child.message('also do b')).toEqual({ ok: true, status: 'queued' });

    await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    await vi.waitFor(() => expect(notices(frames).map((notice) => notice.message)).toContainEqual(expect.stringMatching(/before its subplanner answered your message/)), WAIT);
    expect(notices(frames).filter((notice) => /your message/.test(notice.message))).toHaveLength(1);
    expect(planners.d.asked.join('\n')).not.toContain('also do b');
    release('a');
    parent.destroy();
  });

  it('still reads a message that came in behind the report, before the child ends', async () => {
    const gate = deferred();
    const { parent, child, frames, planners, release } = await held(['a'], {
      d: [SUBMIT([childTask('a', 1)]), async (tools, input) => { await gate.promise; await DONE(tools, input); }, REPLY],
    });
    release('a');
    await vi.waitFor(() => expect(planners.d.asked.length).toBe(2), WAIT);

    expect(child.message('also do b')).toEqual({ ok: true, status: 'queued' });
    gate.resolve();

    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(child.entry().state).toBe('ended'), WAIT);
    expect(planners.d.asked.at(-1)).toContain('also do b');
    expect(notices(frames).filter((notice) => /your message/.test(notice.message))).toEqual([]);
    parent.destroy();
  });

  it('tells whoever watches when the turn a message opened fails, and leaves the attempt to go on', async () => {
    const { parent, child, frames, release } = await held(['a'], {
      d: [SUBMIT([childTask('a', 1)]), async () => { throw new Error('the model went away'); }, DONE],
    });

    child.message('are you there');

    await vi.waitFor(() => expect(notices(frames).map((notice) => notice.message)).toEqual([expect.stringContaining('the model went away')]), WAIT);
    release('a');
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    parent.destroy();
  });
});
describe('a child that cannot be spoken to', () => {
  it('leaves a finished child view-only, by the id it always had', async () => {
    const { runner } = heldTasks([]);
    const { parent, planners } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    const asked = planners.d.asked.length;

    expect(child!.message('hello?')).toMatchObject({ ok: false, code: 'view_only' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(planners.d.asked).toHaveLength(asked);
    parent.destroy();
  });

  it('refuses under a Stop, naming it, and opens nothing', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent, planners } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    const asked = planners.d.asked.length;

    await parent.execute({ command: 'stop_run' }, { kind: 'user' });
    const outcome = child!.message('still there?');

    expect(outcome.ok).toBe(false);
    expect(planners.d.asked).toHaveLength(asked);
    release('a');
    parent.destroy();
  });

  it('asks a child out of budget to wait for a raise, and never raises', async () => {
    const { runner, release } = heldTasks(['a']);
    const { parent, planners } = tree({ d: [SUBMIT([childTask('a', 1)]), DONE] }, { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toEqual(['a']), WAIT);
    const [entry] = await parent.children.list();
    const child = await parent.children.find(entry.sessionId);
    await vi.waitFor(() => expect(child!.entry().state).toBe('parked'), WAIT);
    const ledger = await parent.ledger();
    ledger.nodeOf(entry.sessionId)!.stop('Level 1 is out of tokens.');
    const asked = planners.d.asked.length;

    expect(child!.message('go on anyway')).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('out of tokens') });

    expect(planners.d.asked).toHaveLength(asked);
    release('a');
    parent.destroy();
  });
});
describe('a person\'s controls on a child plan\'s tasks', () => {
  /** A root over `turns`, with `held` running in the plan at depth 1. */
  const running = async (held: string[], turns: Record<string, Turn[]>, writes: Record<string, string> = {}) => {
    const tasks = heldTasks(held, writes);
    const made = tree(turns, { runner: tasks.runner });
    await made.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(tasks.runner.spawned).toEqual(expect.arrayContaining(held)), WAIT);
    return { ...made, ...tasks };
  };
  const childAt = async (parent: Session, depth: number) => {
    const entry = (await parent.children.list()).find((child) => child.depth === depth)!;
    return (await parent.children.find(entry.sessionId))!;
  };
  const asks = async (parent: Session, session: FakeRunnerSession, depth: number, taskId: string, question: string) => {
    const answer = session.callCheckpoint(question);
    const child = await childAt(parent, depth);
    await vi.waitFor(() => expect(child.view().run.tasks.find((task) => task.id === taskId)).toMatchObject({ awaitingReason: 'checkpoint', checkpoint: question }), WAIT);
    return { child, answer };
  };

  it('approves the checkpoint a child\'s runner waits at, and the runner goes on', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const { child, answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'May I drop the table?');

    const done = await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'May I drop the table?' });

    expect(done).toMatchObject({ ok: true });
    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    expect(child.view().run.tasks.find((task) => task.id === 'a')?.status).toBe('in_progress');
    release('a');
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    parent.destroy();
  });

  // An answer opens no turn, so a node short of one still owes its runner the answer it waits on.
  it('takes an answer once the budget cannot cover another planner turn', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const { child, answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'May I drop the table?');
    const ledger = await parent.ledger();
    ledger.nodeOf(child.entry().sessionId)!.spent({ source: 'claude-code', model: 'opus', inputTokens: 1_701_000, outputTokens: 0 } as never, { taskId: 'a', attempt: 1 });
    expect(child.entry().refused).toMatch(/refused this turn/);

    const done = await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'May I drop the table?' });

    expect(done).toMatchObject({ ok: true });
    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    release('a');
    parent.destroy();
  });

  it('tells a runner why, and a rejection with no reason asks for one and leaves it waiting', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const { child, answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'Which schema?');

    const bare = await child.control('a', { kind: 'checkpoint', answer: 'reject', question: 'Which schema?' });
    expect(bare).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('needs a reason') });
    expect(child.view().run.tasks.find((task) => task.id === 'a')?.checkpoint).toBe('Which schema?');

    expect(await child.control('a', { kind: 'checkpoint', answer: 'reject', question: 'Which schema?', reason: 'Use the old one.' })).toMatchObject({ ok: true });
    await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'Use the old one.' });
    release('a');
    parent.destroy();
  });

  it('takes no answer read for another question, and none twice', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const { child, answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'Second question?');

    expect(await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'First question?' })).toMatchObject({ ok: false, code: 'not_waiting' });
    expect(child.view().run.tasks.find((task) => task.id === 'a')?.checkpoint).toBe('Second question?');

    expect(await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'Second question?' })).toMatchObject({ ok: true });
    await answer;
    expect(await child.control('a', { kind: 'checkpoint', answer: 'reject', question: 'Second question?', reason: 'Changed my mind.' })).toMatchObject({ ok: false, code: 'not_waiting' });
    release('a');
    parent.destroy();
  });

  it('refuses a checkpoint no task waits at, and a message that would stand in for an answer', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(parent, 1);
    await vi.waitFor(() => expect(child.entry().state).toBe('parked'), WAIT);
    expect(await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'Anything?' })).toMatchObject({ ok: false, code: 'not_waiting' });

    const { answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'May I?');
    expect(await child.control('a', { kind: 'message', text: 'yes, go on' })).toMatchObject({ ok: false, code: 'refused', message: expect.stringContaining('checkpoint') });
    expect(sessions.get('a')!.messages).toEqual([]);
    expect(sessions.get('a')!.delivered).toEqual([]);

    await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'May I?' });
    await answer;
    release('a');
    parent.destroy();
  });

  it('messages the runner of the task named, and answers with the id to take it back by', async () => {
    const { parent, sessions, release } = await running(['a', 'b'], { d: [SUBMIT([childTask('a', 1), childTask('b', 2)]), REPLY, DONE] });
    const child = await childAt(parent, 1);
    await vi.waitFor(() => expect(child.entry().state).toBe('parked'), WAIT);

    const sent = await child.control('b', { kind: 'message', text: 'Mind the migrations.' });

    expect(sent).toMatchObject({ ok: true, id: expect.any(String) });
    const reached = (session: FakeRunnerSession) => [...session.delivered, ...session.messages.map((message) => message.text)];
    expect(reached(sessions.get('b')!).join()).toContain('Mind the migrations.');
    expect(reached(sessions.get('a')!)).toEqual([]);
    release('a');
    release('b');
    parent.destroy();
  });

  it('refuses a task its plan does not hold, by any name, and leaves the root alone', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const { child, answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'May I?');

    for (const name of ['d', 'missing', '#1', 'Write a']) {
      expect(await child.control(name, { kind: 'message', text: 'hello' })).toMatchObject({ ok: false, code: 'no_task' });
      expect(await child.control(name, { kind: 'checkpoint', answer: 'approve', question: 'May I?' })).toMatchObject({ ok: false, code: 'no_task' });
    }
    expect(parent.planTasks[0].status).toBe('in_progress');
    expect(child.view().run.tasks.find((task) => task.id === 'a')?.checkpoint).toBe('May I?');

    await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'May I?' });
    await answer;
    release('a');
    parent.destroy();
  });

  it('leaves a subplanner\'s own question with the plan above, which holds it', async () => {
    const { parent, planners, release } = await running(['a'], {
      d: [SUBMIT([childTask('a', 1)]), async (tools) => { await tools.checkpoint!({ question: 'Which way?' }, { signal: new AbortController().signal }); }, REPLY, DONE],
    });
    const child = await childAt(parent, 1);
    await vi.waitFor(() => expect(child.entry().state).toBe('parked'), WAIT);
    child.message('ask above');
    await vi.waitFor(() => expect(parent.escalations().find((e) => e.kind === 'checkpoint')).toBeDefined(), WAIT);

    expect(await child.control('d', { kind: 'checkpoint', answer: 'approve', question: 'Which way?' })).toMatchObject({ ok: false, code: 'no_task' });
    expect(parent.escalations().find((e) => e.kind === 'checkpoint')).toBeDefined();

    await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', reason: 'left' }, { kind: 'user' });
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('The plan above answered your question: approved'), WAIT);
    release('a');
    parent.destroy();
  });

  it('answers a checkpoint at depth two on the plan that holds it, and not through its parent', async () => {
    const { parent, sessions, release } = await running(['a'], {
      d: [SUBMIT([nestedTask('n', 1), nestedCheck('c', 2, 'n')]), DONE],
      n: [SUBMIT([childTask('a', 1)]), REPLY, DONE],
    });
    const { child: nested, answer } = await asks(parent, sessions.get('a')!, 2, 'a', 'Deep question?');
    const above = await childAt(parent, 1);

    expect(await above.control('a', { kind: 'checkpoint', answer: 'approve', question: 'Deep question?' })).toMatchObject({ ok: false, code: 'no_task' });

    expect(await nested.control('a', { kind: 'checkpoint', answer: 'approve', question: 'Deep question?' })).toMatchObject({ ok: true });
    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    release('a');
    parent.destroy();
  });

  it('answers a depth-two subplanner\'s question on the delegated task that waits for it in its parent', async () => {
    const { parent, planners, release } = await running(['a'], {
      d: [SUBMIT([nestedTask('n', 1), nestedCheck('c', 2, 'n')]), REPLY, DONE],
      n: [SUBMIT([childTask('a', 1)]), async (tools) => { await tools.checkpoint!({ question: 'Which file?' }, { signal: new AbortController().signal }); }, REPLY, DONE],
    });
    const nested = await childAt(parent, 2);
    await vi.waitFor(() => expect(nested.entry().state).toBe('parked'), WAIT);
    nested.message('ask above');
    const above = await childAt(parent, 1);
    await vi.waitFor(() => expect(above.view().run.tasks.find((task) => task.id === 'n')).toMatchObject({ awaitingReason: 'checkpoint', checkpoint: 'Which file?' }), WAIT);

    expect(await nested.control('n', { kind: 'checkpoint', answer: 'approve', question: 'Which file?' })).toMatchObject({ ok: false, code: 'no_task' });
    expect(await above.control('n', { kind: 'checkpoint', answer: 'reject', question: 'Which file?', reason: 'Use a.txt.' })).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(planners.n.asked.join('\n')).toContain('Use a.txt.'), WAIT);
    release('a');
    parent.destroy();
  });

  it('keeps two children apart when their tasks share an id', async () => {
    const tasks = [delegated(), delegated({ id: 'e', order: 2, title: 'Second subtree' })];
    const runner = heldTasks(['a']);
    const spawned = vi.spyOn(runner.runner, 'spawn');
    const { parent } = tree({ d: [SUBMIT([childTask('a', 1)]), REPLY, DONE], e: [SUBMIT([childTask('a', 1)]), REPLY, DONE] }, { runner: runner.runner, tasks });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2), WAIT);
    const sessions = await Promise.all(spawned.mock.results.map((result) => result.value as Promise<FakeRunnerSession>));
    const answer = sessions[0].callCheckpoint('Only one of you?');
    const [first, second] = await Promise.all((await parent.children.list()).map((entry) => parent.children.find(entry.sessionId)));
    const holding = (child: typeof first) => child!.view().run.tasks.find((task) => task.id === 'a')?.checkpoint === 'Only one of you?';
    await vi.waitFor(() => expect(holding(first) || holding(second)).toBe(true), WAIT);
    const [asked, other] = holding(first) ? [first!, second!] : [second!, first!];

    expect(await other.control('a', { kind: 'checkpoint', answer: 'approve', question: 'Only one of you?' })).toMatchObject({ ok: false, code: 'not_waiting' });
    expect(await asked.control('a', { kind: 'checkpoint', answer: 'approve', question: 'Only one of you?' })).toMatchObject({ ok: true });
    await answer;
    parent.destroy();
  });

  it('refuses a message to a task with no runner left, and reads only once the plan has ended', async () => {
    const { parent, release } = await running(['b'], { d: [SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), REPLY, DONE] });
    const child = await childAt(parent, 1);
    await vi.waitFor(() => expect(child.view().run.tasks.find((task) => task.id === 'a')?.status).toBe('completed'), WAIT);

    expect(await child.control('a', { kind: 'message', text: 'one more thing' })).toMatchObject({ ok: false, code: 'refused' });

    release('b');
    await vi.waitFor(() => expect(parent.planTasks[0].status).toBe('completed'), WAIT);
    expect(await child.control('b', { kind: 'message', text: 'too late' })).toEqual(expect.objectContaining({ ok: false, code: 'view_only' }));
    expect(await child.control('b', { kind: 'checkpoint', answer: 'approve', question: 'Any?' })).toEqual(expect.objectContaining({ ok: false, code: 'view_only' }));
    parent.destroy();
  });

  it('refuses once Stop halts the tree', async () => {
    const { parent, sessions } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const { child, answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'May I?');

    await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    expect(await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'May I?' })).toMatchObject({ ok: false });
    await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
    parent.destroy();
  });

  it('keeps who pressed it on the child\'s record, and tells its subplanner on its next turn without opening one', async () => {
    const { parent, frames, planners, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(parent, 1);
    await vi.waitFor(() => expect(child.entry().state).toBe('parked'), WAIT);
    const seen: ChildFrame[] = [];
    child.watch((frame) => seen.push(frame));
    const turns = planners.d.asked.length;
    const { answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'Which schema?');

    await child.control('a', { kind: 'checkpoint', answer: 'reject', question: 'Which schema?', reason: 'The old one.' });
    await answer;

    expect(seen).toContainEqual(expect.objectContaining({
      type: 'execution_action',
      record: expect.objectContaining({ command: 'answer_checkpoint', actor: 'subplanner', person: true, outcome: 'done', task: expect.objectContaining({ id: 'a' }) }),
      text: expect.stringMatching(/^A person /),
    }));
    expect(frames.filter((frame) => frame.type === 'execution_action' && frame.record.command === 'answer_checkpoint')).toEqual([]);
    expect(planners.d.asked.length).toBe(turns);

    release('a');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toMatch(/A person acted on your plan: Rejected the checkpoint[^\n]*They said: The old one\./), WAIT);
    parent.destroy();
  });

  it('lists the tasks waiting at a checkpoint for as long as they wait, and says when that changes', async () => {
    const { parent, sessions, release } = await running(['a'], { d: [SUBMIT([childTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(parent, 1);
    await vi.waitFor(() => expect(child.entry().state).toBe('parked'), WAIT);
    expect(child.entry().checkpoints).toBeUndefined();
    let told = 0;
    parent.children.onChange(() => { told += 1; });

    const { answer } = await asks(parent, sessions.get('a')!, 1, 'a', 'May I?');
    expect(child.entry().checkpoints).toEqual(['a']);
    await vi.waitFor(() => expect(told).toBeGreaterThan(0), WAIT);

    const before = told;
    await child.control('a', { kind: 'checkpoint', answer: 'approve', question: 'May I?' });
    await answer;
    expect(child.entry().checkpoints).toBeUndefined();
    await vi.waitFor(() => expect(told).toBeGreaterThan(before), WAIT);
    release('a');
    parent.destroy();
  });
});
