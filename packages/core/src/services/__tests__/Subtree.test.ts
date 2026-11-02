import { describe, expect, it } from 'vitest';
import { createTask, type Task, type TaskStatus } from '../../models/Task';
import { storedHandoff, type Handoff, type HandoffDigest, type HandoffFinding, type StoredHandoff, type SubtreeReport } from '../../models/Handoff';
import type { TaskLogEvent } from '../../models/TaskLog';
import { readTask } from '../readTask';
import { Subtree, takeReport, type NodePlan, type SubtreeNode } from '../Subtree';

const HERE = 'root/1';

const noLogs = { attempts: () => [], events: () => [] };

const finding = (id: string, severity: HandoffFinding['severity'] = 'major'): HandoffFinding => ({ id, severity, title: `${id} says so` });

const digest = (attempt: number, ...findings: HandoffFinding[]): HandoffDigest => ({ summary: 'ended', attempt, findings, findingCount: findings.length });

const task = (id: string, order: number, status: TaskStatus, handoff?: HandoffDigest): Task => createTask({ id, order, title: id, status, ...(handoff ? { handoff } : {}) });

const delegated = (id: string, order: number, status: TaskStatus, child?: string): Task => ({ ...task(id, order, status), type: 'delegated', ...(child ? { runnerSessionId: child } : {}) });

/** A tree below {@link HERE}, each node's session holding the plan given for it. */
const treeOf = (own: NodePlan, nodes: readonly SubtreeNode[], plans: Record<string, readonly Task[]>) => new Subtree({
  here: own.node,
  tasks: () => own.tasks,
  nodes: () => nodes,
  plan: ({ sessionId }) => plans[sessionId],
  logs: () => noLogs,
});

const ownPlan = (...tasks: Task[]): NodePlan => ({ node: HERE, tasks, logs: noLogs });

const reported = (subtree: Subtree, own: NodePlan) => {
  const report: Handoff & { subtree?: SubtreeReport } = { summary: 'done' };
  const taken = takeReport(report, { plan: own, subtree, tokens: 0 });
  if (!taken.ok) throw new Error(taken.refusal);
  return taken.handoff.subtree;
};

describe('the counts of a report (ADR-0057 R2, ADR-0055 D15)', () => {
  it('leave out a child a fresh retry discarded', () => {
    const own = ownPlan(delegated('d', 1, 'pending', 'new'), task('o', 2, 'completed'));
    const subtree = treeOf(own,
      [{ path: 'root/1/1', sessionId: 'old', taskId: 'd' }, { path: 'root/1/2', sessionId: 'new', taskId: 'd' }],
      { old: [task('gone', 1, 'completed', digest(1, finding('F1')))], new: [task('next', 1, 'pending')] });
    const report = reported(subtree, own);
    expect(report?.counts).toMatchObject({ done: 1, blocked: 2 });
    expect(report?.findings.major).toBe(0);
  });

  it('leave out a child whose task was removed from the plan', () => {
    const own = ownPlan(task('o', 1, 'completed'));
    const subtree = treeOf(own, [{ path: 'root/1/1', sessionId: 'old', taskId: 'd' }], { old: [task('gone', 1, 'completed', digest(1, finding('F1')))] });
    expect(reported(subtree, own)?.counts.done).toBe(1);
  });

  it('leave out what hung from a discarded child, grandchildren too', () => {
    const own = ownPlan(delegated('d', 1, 'pending', 'new'));
    const subtree = treeOf(own, [
      { path: 'root/1/1', sessionId: 'old', taskId: 'd' },
      { path: 'root/1/1/1', sessionId: 'grand', taskId: 'g' },
      { path: 'root/1/2', sessionId: 'new', taskId: 'd' },
    ], { old: [delegated('g', 1, 'completed', 'grand')], grand: [task('deep', 1, 'completed', digest(1, finding('F1')))], new: [task('next', 1, 'pending')] });
    expect(subtree.plans().map((plan) => plan.node)).toEqual(['root/1/2']);
  });

  it('keep a grandchild of a child a Continue reopened, whose first node holds it', () => {
    const own = ownPlan(delegated('d', 1, 'completed', 'child'));
    const subtree = treeOf(own, [
      { path: 'root/1/1', sessionId: 'child', taskId: 'd' },
      { path: 'root/1/1/1', sessionId: 'grand', taskId: 'g' },
      { path: 'root/1/2', sessionId: 'child', taskId: 'd' },
    ], { child: [delegated('g', 1, 'completed', 'grand')], grand: [task('deep', 1, 'completed')] });
    expect(subtree.plans().map((plan) => plan.node).sort()).toEqual(['root/1/1/1', 'root/1/2']);
  });

  it('still let a reference read the discarded child by the path it was pinned against (ADR-0057 R1)', () => {
    const own = ownPlan(delegated('d', 1, 'pending', 'new'));
    const subtree = treeOf(own,
      [{ path: 'root/1/1', sessionId: 'old', taskId: 'd' }, { path: 'root/1/2', sessionId: 'new', taskId: 'd' }],
      { old: [task('gone', 1, 'completed', digest(1, finding('F1')))], new: [] });
    expect(subtree.planAt('root/1/1')?.tasks.map((one) => one.id)).toEqual(['gone']);
  });
});

describe('the listing a read of a report gives (ADR-0057 R2)', () => {
  const reportAt = (node: string): StoredHandoff => ({
    ...storedHandoff({ summary: 'What the child plan did.' })!,
    attempt: 1,
    subtree: { node, counts: { done: 1, failed: 0, blocked: 0, skipped: 0, commits: 0, tokens: 0 }, findings: { blocker: 0, major: 0, minor: 0, info: 0 }, open: [], promoted: [] },
  });
  const loggedReport = (handoff: StoredHandoff, id = 'd') => ({
    attempts: (taskId: string) => (taskId === id ? [1] : []),
    events: (taskId: string): TaskLogEvent[] => (taskId === id ? [{ type: 'handoff', handoff }] : []),
  });
  const findings = (count: number) => Array.from({ length: count }, (_, i) => finding(`F${i + 1}`));
  const textOf = ({ text }: { text: string }) => text;

  const own = ownPlan(delegated('d', 1, 'completed', 'child'), task('other', 2, 'pending'));
  const subtree = treeOf(own, [{ path: 'root/1/1', sessionId: 'child', taskId: 'd' }], { child: [task('c', 1, 'completed', digest(1, ...findings(150)))] });
  const log = loggedReport(reportAt('root/1/1'));

  it('says where it goes on when it stops', () => {
    const lines = textOf(readTask({ task: '#1' }, undefined, own.tasks, log, subtree)).split('\n');
    expect(lines).toContain('- 1/1:#1@1/F100 [major] F100 says so');
    expect(lines).not.toContain('- 1/1:#1@1/F101 [major] F101 says so');
    expect(lines.at(-1)).toBe('+50 more: read "#1@1/from:101".');
  });

  it('reads on from there, every finding by its reference on some page, and repeats no report', () => {
    const lines = textOf(readTask({ task: '#1@1/from:101' }, undefined, own.tasks, log, subtree)).split('\n');
    expect(lines).toContain('- 1/1:#1@1/F101 [major] F101 says so');
    expect(lines).toContain('- 1/1:#1@1/F150 [major] F150 says so');
    expect(lines.filter((line) => line.startsWith('- 1/1:'))).toHaveLength(50);
    expect(lines).not.toContain('What the child plan did.');
    expect(lines.at(-1)).not.toContain('more');
  });

  it('answers a page past the end', () => {
    expect(textOf(readTask({ task: '#1/from:151' }, undefined, own.tasks, log, subtree))).toContain('(nothing past entry 150)');
  });

  it('holds a page to what the reader may read, as it holds the report', () => {
    const reply = readTask({ task: '#1/from:101' }, 'other', own.tasks, log, subtree);
    expect(reply).toMatchObject({ isError: true });
    expect(reply.text).toContain('is not a task this one may read');
  });

  it('refuses a page of a task that left no report to list', () => {
    expect(readTask({ task: '#2/from:101' }, undefined, own.tasks, log, subtree)).toMatchObject({ isError: true });
  });

  it('keeps reading a title that looks like a page', () => {
    const named = ownPlan({ ...delegated('d', 1, 'completed', 'child'), title: 'Split/from:101' });
    expect(textOf(readTask({ task: 'Split/from:101' }, undefined, named.tasks, log, subtree))).toContain('What the child plan did.');
  });

  it('lists what a discarded child held for the report of that child, a reference meaning what it meant (R1)', () => {
    const after = ownPlan(delegated('d', 1, 'completed', 'new'));
    const retried = treeOf(after, [
      { path: 'root/1/1', sessionId: 'old', taskId: 'd' },
      { path: 'root/1/2', sessionId: 'new', taskId: 'd' },
    ], { old: [task('gone', 1, 'completed', digest(1, finding('F1')))], new: [task('next', 1, 'pending')] });
    expect(textOf(readTask({ task: '#1' }, undefined, after.tasks, loggedReport(reportAt('root/1/1')), retried))).toContain('- 1/1:#1@1/F1 [major] F1 says so');
  });

  it('lists a grandchild a Continue left under the child\'s first node', () => {
    const continued = treeOf(own, [
      { path: 'root/1/1', sessionId: 'child', taskId: 'd' },
      { path: 'root/1/1/1', sessionId: 'grand', taskId: 'g' },
      { path: 'root/1/2', sessionId: 'child', taskId: 'd' },
    ], { child: [delegated('g', 1, 'completed', 'grand')], grand: [task('deep', 1, 'completed', digest(1, finding('F1')))] });
    expect(textOf(readTask({ task: '#1' }, undefined, own.tasks, loggedReport(reportAt('root/1/2')), continued))).toContain('- 1/1/1:#1@1/F1 [major] F1 says so');
  });

  it('reads a page of a report in a plan below, the pointer carrying its path', () => {
    const child = [delegated('g', 1, 'completed', 'grand')];
    const below = new Subtree({
      here: HERE,
      tasks: () => own.tasks,
      nodes: () => [{ path: 'root/1/1', sessionId: 'child', taskId: 'd' }, { path: 'root/1/1/1', sessionId: 'grand', taskId: 'g' }],
      plan: ({ sessionId }) => (sessionId === 'child' ? child : [task('deep', 1, 'completed', digest(1, ...findings(150)))]),
      logs: ({ sessionId }) => (sessionId === 'child' ? loggedReport(reportAt('root/1/1/1'), 'g') : noLogs),
    });
    expect(textOf(readTask({ task: '1/1:#1' }, undefined, own.tasks, noLogs, below)).split('\n').at(-1)).toBe('+50 more: read "1/1:#1@1/from:101".');
    expect(textOf(readTask({ task: '1/1:#1@1/from:101' }, undefined, own.tasks, noLogs, below))).toContain('- 1/1/1:#1@1/F150 [major] F150 says so');
  });

  describe('of a removed delegated task, reached by a citation (R1)', () => {
    const cited = (taskId: string, attempt: number) => ({ ...digest(1), findings: [{ ...finding('F1'), evidence: [{ kind: 'task' as const, task: taskId, attempt }] }] });
    const after = ownPlan(task('o', 1, 'completed', cited('d', 1)));
    const removed = treeOf(after, [{ path: 'root/1/1', sessionId: 'child', taskId: 'd' }], { child: [task('c', 1, 'completed', digest(1, ...findings(150)))] });

    it('lists what the report left out, as it does while the task stands', () => {
      const lines = textOf(readTask({ task: 'd@1' }, undefined, after.tasks, log, removed)).split('\n');
      expect(lines).toContain('- 1/1:#1@1/F100 [major] F100 says so');
      expect(lines.at(-1)).toBe('+50 more: read "d@1/from:101".');
    });

    it('reads on from there', () => {
      expect(textOf(readTask({ task: 'd@1/from:101' }, undefined, after.tasks, log, removed))).toContain('- 1/1:#1@1/F150 [major] F150 says so');
    });
  });
});
