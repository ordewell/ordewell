import { describe, it, expect } from 'vitest';
import { taskRowView, loopRowParts, loopLeaveNotice, type TaskRowSubject } from '..';
import { createTask } from '../../models/Task';
import { serializeTaskStatus } from '../../services/SessionMessage';

interface Node {
  id: string;
  order: number;
  title: string;
  status: string;
  dependencies: string[];
  loop?: { body: string[]; maxRounds: number };
  loopRound?: number;
  verdict?: { outcome: string; reported?: string } | null;
}

const check = (over: Partial<Node> = {}): Node => ({ id: 'c', order: 1, title: 'Review', status: 'pending', dependencies: [], loop: { body: ['f'], maxRounds: 3 }, ...over });
const fix = (over: Partial<Node> = {}): Node => ({ id: 'f', order: 2, title: 'Fix', status: 'pending', dependencies: ['c'], ...over });
const found = { outcome: 'fail', reported: 'failed' };

const rowOf = (node: Node, plan: Node[]) => taskRowView({ ...node, type: 'ai' } as TaskRowSubject, { tasks: plan });

describe('a loop\'s check between rounds that nothing will run (ADR-0045 L5)', () => {
  const stranded = check({ status: 'failed', verdict: found });
  const rowWith = (fixStatus: string) => taskRowView({ ...stranded, type: 'ai', loopStranded: true } as TaskRowSubject, { tasks: [stranded, fix({ status: fixStatus })] });

  it('reads as the failure it is, not as fixing, with Execute to go on while its fix has not landed', () => {
    const row = rowWith('pending');
    expect(row.status).toBe('failed');
    expect(row.loop).toMatchObject({ state: 'stopped', label: 'Stopped in round 1 of 3', detail: 'Nothing runs it now: execute the plan and the loop goes on' });
  });

  it('offers its next round once its fix has landed', () => {
    expect(rowWith('completed').loop).toMatchObject({ state: 'stopped', detail: 'Nothing runs it now: start it for round 2 of 3' });
  });

  it('is told on the status stream, and only when it is so', () => {
    const task = createTask({ id: 'c', loop: { body: ['f'], maxRounds: 3 } });
    expect(serializeTaskStatus(task).loopStranded).toBeUndefined();
    expect(serializeTaskStatus(task, null, null, [], 0, [], '', false, null, null, null, true).loopStranded).toBe(true);
  });
});

describe('a loop\'s check row (ADR-0045)', () => {
  it('says how many rounds it may run, before it runs', () => {
    const row = rowOf(check(), [check(), fix()]);
    expect(row.loop).toEqual({ role: 'check', state: 'waiting', label: 'Loop of up to 3 rounds', detail: null, body: ['#2'] });
    expect(loopRowParts(row.loop!)).toEqual(['Loop of up to 3 rounds', 'Runs #2 if it fails']);
  });

  it.each(['in_progress', 'awaiting_user'])('says its round while it is %s', (status) => {
    const node = check({ status, loopRound: 2 });
    expect(rowOf(node, [node, fix()]).loop).toMatchObject({ state: 'running', label: 'Round 2 of 3' });
  });

  it('says round 1 on its first run, and the next round while it waits to start again', () => {
    const first = check({ status: 'in_progress' });
    expect(rowOf(first, [first, fix()]).loop).toMatchObject({ label: 'Round 1 of 3' });
    const next = check({ status: 'pending', loopRound: 2, verdict: null });
    expect(rowOf(next, [next, fix({ status: 'completed' })]).loop).toMatchObject({ state: 'running', label: 'Round 2 of 3' });
  });

  it('shows a check between rounds as waiting for its fix, not as failed (L3)', () => {
    const node = check({ status: 'failed', loopRound: 1, verdict: found });
    const row = rowOf(node, [node, fix({ status: 'in_progress' })]);
    expect(row.loop).toMatchObject({ state: 'repeating', label: 'Round 1 of 3: fixing', detail: 'Found problems: runs again once #2 has landed' });
    expect(row.status).toBe('todo');
    expect(row.actions).toEqual(rowOf({ ...node, loop: undefined }, [{ ...node, loop: undefined }, fix()]).actions);
  });

  it('shows the loop stopped, naming the body task that did not pass (L7)', () => {
    const node = check({ status: 'failed', loopRound: 1, verdict: found });
    const row = rowOf(node, [node, fix({ status: 'failed' })]);
    expect(row.loop).toMatchObject({ state: 'stopped', label: 'Stopped in round 1 of 3', detail: '#2 did not pass: retry it and the loop goes on' });
    expect(row.status).toBe('failed');
  });

  it('names every body task that is waiting on, and every one that stopped it', () => {
    const two = { body: ['f', 'g'], maxRounds: 3 };
    const g = fix({ id: 'g', order: 3, title: 'Polish' });
    const going = check({ status: 'failed', loopRound: 1, verdict: found, loop: two });
    expect(rowOf(going, [going, fix(), g]).loop).toMatchObject({ state: 'repeating', detail: 'Found problems: runs again once #2, #3 have landed' });
    expect(rowOf(going, [going, fix({ status: 'failed' }), { ...g, status: 'skipped' }]).loop).toMatchObject({ state: 'stopped', detail: '#2, #3 did not pass: retry them and the loop goes on' });
  });

  it('reads a skipped body task as stopping the loop too', () => {
    const node = check({ status: 'failed', loopRound: 2, verdict: found });
    expect(rowOf(node, [node, fix({ status: 'skipped' })]).loop).toMatchObject({ state: 'stopped' });
  });

  it('has nothing to say of its loop once it is skipped, but how many rounds it had', () => {
    const node = check({ status: 'skipped' });
    expect(rowOf(node, [node, fix({ status: 'skipped' })]).loop).toMatchObject({ state: 'ended', label: 'Loop of up to 3 rounds' });
  });

  it('puts what the loop waits for in place of what it will run, once it has run', () => {
    const node = check({ status: 'failed', loopRound: 1, verdict: found });
    expect(loopRowParts(rowOf(node, [node, fix({ status: 'in_progress' })]).loop!)).toEqual(['Round 1 of 3: fixing', 'Found problems: runs again once #2 has landed']);
    const done = check({ status: 'completed', loopRound: 1 });
    expect(loopRowParts(rowOf(done, [done, fix({ status: 'skipped' })]).loop!)).toEqual(['Completed in round 1 of 3']);
  });

  it('says when it passed, in which round', () => {
    const node = check({ status: 'completed', loopRound: 2, verdict: { outcome: 'pass', reported: 'done' } });
    expect(rowOf(node, [node, fix({ status: 'skipped' })]).loop).toMatchObject({ state: 'passed', label: 'Passed in round 2 of 3' });
  });

  it('says completed, not passed, when the user marked it complete', () => {
    const node = check({ status: 'completed' });
    expect(rowOf(node, [node, fix({ status: 'skipped' })]).loop).toMatchObject({ label: 'Completed in round 1 of 3' });
  });

  it('says how many rounds it failed after, when it ran out (L6)', () => {
    const node = check({ status: 'failed', loopRound: 3, verdict: found });
    const row = rowOf(node, [node, fix({ status: 'skipped' })]);
    expect(row.loop).toMatchObject({ state: 'out-of-rounds', label: 'Failed after 3 rounds' });
    expect(row.status).toBe('failed');
    const single = check({ status: 'failed', loop: { body: ['f'], maxRounds: 1 }, verdict: found });
    expect(rowOf(single, [single, fix()]).loop).toMatchObject({ label: 'Failed after 1 round' });
  });

  it('is no failure to fix when the check reported blocked or could not run (L2)', () => {
    const node = check({ status: 'failed', loopRound: 1, verdict: { outcome: 'fail', reported: 'blocked' } });
    expect(rowOf(node, [node, fix()]).loop).toMatchObject({ state: 'failed', label: 'Failed in round 1 of 3' });
  });

  it('reads a check between rounds as going on when it is shown without a plan', () => {
    const node = check({ status: 'failed', loopRound: 1, verdict: found });
    expect(taskRowView({ ...node, type: 'ai' } as TaskRowSubject).loop).toMatchObject({ state: 'repeating', body: ['f'] });
  });
});

describe('a loop\'s body row (ADR-0045)', () => {
  it('says which check it runs for, by its order label, before the loop runs it', () => {
    const row = rowOf(fix(), [check(), fix()]);
    expect(row.loop).toEqual({ role: 'body', label: 'Runs if #1 fails', check: '#1', round: null });
    expect(row.status).toBe('todo');
  });

  it('has one part to say: which check it runs for', () => {
    expect(loopRowParts(rowOf(fix(), [check(), fix()]).loop!)).toEqual(['Runs if #1 fails']);
  });

  it('says its round once it runs', () => {
    const plan = (body: string, round?: number) => [check({ status: 'failed', loopRound: round, verdict: found }), fix({ status: body })];
    expect(rowOf(plan('in_progress', 2)[1], plan('in_progress', 2)).loop).toMatchObject({ label: 'Runs if #1 fails (round 2 of 3)', round: 2 });
    expect(rowOf(plan('completed', 1)[1], plan('completed', 1)).loop).toMatchObject({ round: 1 });
  });

  it('keeps the round it ran in while the check runs again', () => {
    const plan = [check({ status: 'in_progress', loopRound: 2 }), fix({ status: 'completed' })];
    expect(rowOf(plan[1], plan).loop).toMatchObject({ round: 1 });
  });

  it('names the check by its dotted reference when ordered after others', () => {
    const plan = [{ id: 'a', order: 1, title: 'Build', status: 'completed', dependencies: [] }, check({ order: 2, dependencies: ['a'] }), fix({ order: 3 })];
    expect(rowOf(plan[2], plan).loop).toMatchObject({ label: 'Runs if #2 fails', check: '#2' });
  });

  it('is not blocked by its check between rounds, though the check is stored failed (L3, L4)', () => {
    const plan = [check({ status: 'failed', loopRound: 1, verdict: found }), fix()];
    expect(rowOf(plan[1], plan)).toMatchObject({ status: 'todo', blockedBy: null });
  });

  it('is in no loop outside one', () => {
    const plan = [{ id: 'a', order: 1, title: 'A', status: 'pending', dependencies: [] }, fix({ dependencies: [] })];
    expect(rowOf(plan[1], plan).loop).toBeNull();
    expect(rowOf(plan[0] as Node, plan).loop).toBeNull();
  });
});

describe('a plan whose rows carry no status', () => {
  it('still names the check a body task runs for, with no round', () => {
    const plan = [{ id: 'c', order: 1, title: 'Review', dependencies: [], loop: { body: ['f'], maxRounds: 3 } }, { id: 'f', order: 2, title: 'Fix', dependencies: ['c'] }];

    expect(taskRowView({ id: 'f', order: 2, type: 'ai', status: 'pending', dependencies: ['c'] }, { tasks: plan }).loop).toMatchObject({ label: 'Runs if #1 fails', round: null });
  });
});

describe('what removing a body task does to its loop (ADR-0045 L8)', () => {
  const plan = (body: string[]) => [{ ...check(), loop: { body, maxRounds: 3 } }, fix(), fix({ id: 'g', order: 3, title: 'Polish' })];

  it('says it leaves the loop', () => {
    expect(loopLeaveNotice(plan(['f', 'g']), 'f')).toBe('It is in the body of #1 Review\'s loop, and leaves it.');
  });

  it('says the loop is dropped with its only body task', () => {
    expect(loopLeaveNotice(plan(['f']), 'f')).toBe('It is the whole body of #1 Review\'s loop, so the loop is dropped with it.');
  });

  it('has nothing to say of a task in no loop, or of a check', () => {
    expect(loopLeaveNotice(plan(['f']), 'g')).toBeNull();
    expect(loopLeaveNotice(plan(['f']), 'c')).toBeNull();
  });
});

describe('what the status stream carries of a loop (ADR-0045)', () => {
  it('names the check\'s loop and round, and what its evidence reported, so a stream alone can draw it', () => {
    const task = createTask({
      id: 'c', status: 'failed', loop: { body: ['f'], maxRounds: 3 }, loopRound: 2,
      verdict: { outcome: 'fail', reason: 'two problems', checks: [], decidedAt: '2026-10-21T00:00:00Z', reported: 'failed' },
    });

    expect(serializeTaskStatus(task)).toMatchObject({ loop: { body: ['f'], maxRounds: 3 }, loopRound: 2, verdict: { outcome: 'fail', reported: 'failed' } });
  });

  it('says nothing of a loop on any other task', () => {
    const status = serializeTaskStatus(createTask({ id: 'f', status: 'pending' }));

    expect(status).not.toHaveProperty('loop');
    expect(status).not.toHaveProperty('loopRound');
  });
});
