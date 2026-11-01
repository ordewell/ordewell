import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask } from '../../models/Task';
import { planUsage, taskUsageSummary } from '../../models/Usage';
import { listChildSessions, listSessions, loadSession } from '../../utils/sessionStore';
import type { PlannerTurn as Turn } from './sessionTestKit';
import { CALL, DONE, SUBMIT, childTask, delegated, check, removeRepos, taskOf, tree, writingRunner, type WorkerReport } from './delegationTestKit';

/* What a subtree sends up and what it costs, on real repositories (ADR-0057, ADR-0055 D20). */

afterEach(removeRepos);

const endsDone = async (parent: ReturnType<typeof tree>['parent'], id = 'd') => {
  await parent.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => {
    const task = taskOf(parent, id);
    if (task?.status === 'failed') throw new Error(`It failed: ${task.verdict?.reason}`);
    expect(task?.status).toBe('completed');
  }, { timeout: 20_000 });
};

describe('a subtree\'s task runners', () => {
  const spawnsOf = (runner: ReturnType<typeof writingRunner>) => (runner.spawn as ReturnType<typeof vi.fn>).mock.calls.map(([opts]) => [opts.taskId, opts.runnerConfig]);

  it('load only what a task needs unless the settings file says otherwise, and the root\'s are left as they are', async () => {
    const runner = writingRunner({ a: ['a.txt'] });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner });
    await endsDone(parent, 'c');
    expect(spawnsOf(runner)).toEqual([['a', 'minimal'], ['c', undefined]]);
    parent.destroy();
  });

  it('keep what the user set', async () => {
    const runner = writingRunner({ a: ['a.txt'] });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, settings: { taskRunnerConfig: 'user' } });
    await endsDone(parent);
    expect(spawnsOf(runner)[0]).toEqual(['a', 'user']);
    parent.destroy();
  });
});

describe('a subplanner\'s own subagents (ADR-0056 M6)', () => {
  it('are withheld without `research`', async () => {
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await endsDone(parent);
    expect(planner.requests[0].plannerTools?.noSubagents).toBe(true);
    parent.destroy();
  });

  it('are left to the harness where its delegated task named `research`', async () => {
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated({ grants: ['research'] }), check()] });
    await endsDone(parent);
    expect(planner.requests[0].plannerTools?.subplanner).toBe(true);
    expect(planner.requests[0].plannerTools).not.toHaveProperty('noSubagents');
    parent.destroy();
  });
});

/** Calls until taken: a parent woken early by its child's end is told its check still runs. */
const UNTIL_TAKEN = (report: Parameters<typeof CALL>[0]): Turn => async (tools) => {
  await vi.waitFor(async () => {
    const reply = await tools.taskComplete!(report, { signal: new AbortController().signal });
    if (reply.isError) throw new Error(reply.text);
  }, { timeout: 15_000, interval: 25 });
};

describe('a report by reference (ADR-0057 R1, R2)', () => {
  const FINDINGS: Record<string, WorkerReport> = { a: { findings: [{ severity: 'major', title: 'A race in the writer', detail: 'It loses a write.' }, { severity: 'minor', title: 'A stale comment' }] } };
  const runner = () => writingRunner({ a: ['a.txt'] }, { reports: FINDINGS });
  const REPORT = (replies: { text: string; isError?: boolean }[] = []) => CALL({
    status: 'done', summary: 'It holds.', commit: { subject: 'Write a' }, promote: ['#1/F1'],
    findings: [{ severity: 'info', title: 'Mine', evidence: [{ kind: 'task', task: '#1/F2' }] }],
  }, replies);

  it('pins a subplanner\'s references in its own plan, whatever the parent\'s plan holds, and renders the finding verbatim', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const { parent } = tree([SUBMIT([childTask('a', 1)]), REPORT(replies)], { runner: runner() });
    await endsDone(parent);

    expect(replies).toEqual([{ text: 'Recorded. End your turn now.' }]);
    const { handoff } = taskOf(parent, 'd')!;
    expect(handoff?.subtree).toMatchObject({
      node: 'root/1',
      counts: { done: 1, failed: 0, blocked: 0, skipped: 0, commits: 0 },
      findings: { major: 1, minor: 1 },
      promoted: [{ ref: { node: 'root/1', task: 'a', attempt: 1, finding: 'F1', label: '#1' }, finding: { title: 'A race in the writer', detail: 'It loses a write.' } }],
    });
    expect(handoff?.subtree?.counts.tokens).toBeGreaterThanOrEqual(0);
    expect(handoff?.findings[0].evidence?.[0]).toEqual({ kind: 'task', node: 'root/1', task: 'a', attempt: 1, finding: 'F2', label: '#1' });
    parent.destroy();
  });

  it('refuses a reference that names no task of the child plan, though the parent\'s plan has that task, and leaves the attempt open', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const RETRIES: Turn = async (tools, text) => {
      await CALL({ status: 'done', summary: 's', promote: ['#2/F1'] }, replies)(tools, text);
      await CALL({ status: 'done', summary: 's', commit: { subject: 'Write a' } }, replies)(tools, text);
    };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), RETRIES], { runner: runner() });
    await endsDone(parent);
    expect(replies[1].isError).toBeFalsy();
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('"#2/F1" names no task in the plan') });
    parent.destroy();
  });

  it('reads back from the root what a report names, and lists what it left out by reference', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), REPORT()], { runner: runner() });
    await endsDone(parent);

    const read = await parent.readBelow({ task: '1:#1@1/F1' });
    expect(read.text).toContain('A race in the writer');
    const delegatedRead = await parent.readBelow({ task: '#1' });
    expect(delegatedRead.text).toContain('Promoted (each in its author\'s words):');
    expect(delegatedRead.text).toContain('- 1:#1@1/F2 [minor] A stale comment');
    expect(await parent.readBelow({ task: '9:#1/F1' })).toMatchObject({ isError: true });
    parent.destroy();
  });

  it('lets a task that depends on a delegated task read below it, directly or not, and no other', async () => {
    const seen: Record<string, string> = {};
    const inner = writingRunner({ a: ['a.txt'] }, { reports: FINDINGS });
    const reading: typeof inner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        if (opts.readTask) seen[opts.taskId] = (await opts.readTask({ task: '1:#1@1/F1' })).text;
        return inner.spawn(opts);
      }),
    };
    const other = createTask({ id: 'o', order: 3, title: 'Another', prompt: 'other', dependencies: ['c'] });
    const unrelated = createTask({ id: 'u', order: 4, title: 'Unrelated', prompt: 'other' });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), REPORT()], { runner: reading, tasks: [delegated(), check(), other, unrelated] });
    await endsDone(parent, 'o');
    expect(seen.c).toContain('A race in the writer');
    expect(seen.o).toContain('A race in the writer');
    await vi.waitFor(() => expect(seen.u).toBeDefined());
    expect(seen.u).toContain('names no plan below this one that you may read');
    parent.destroy();
  });

  it('counts the same in a report nobody wrote', async () => {
    const NOTHING: Turn = async () => undefined;
    const { parent } = tree([SUBMIT([childTask('a', 1)]), NOTHING, NOTHING], { runner: runner() });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(taskOf(parent, 'd')?.status).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd')?.handoff?.subtree).toMatchObject({ counts: { done: 1 }, findings: { major: 1, minor: 1 }, promoted: [], open: [] });
    parent.destroy();
  });

  it('puts what its branch changed outside its scope in what is open, from code', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), REPORT()], {
      runner: writingRunner({ a: ['src/in.ts', 'docs/out.md'] }, { reports: FINDINGS }),
      tasks: [delegated({ scope: { paths: ['src/'] } }), check()],
    });
    await endsDone(parent);
    expect(taskOf(parent, 'd')?.handoff?.subtree?.outsideScope).toEqual({ paths: ['docs/out.md'], count: 1 });
    parent.destroy();
  });

  it('climbs two levels: a finding promoted from a grandchild keeps its author\'s words and path at the root', async () => {
    const task = { id: 'g', order: 1, title: 'Grandchild', description: 'g', type: 'delegated', goal: 'Write a', budget: { tokens: 1_000_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', autonomy: 'AFK', dependencies: [] };
    const gate = { id: 'gc', order: 2, title: 'Read the grandchild', description: 'c', type: 'ai', prompt: 'read it', taskMode: 'plan', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['g'] };
    const { parent } = tree([
      SUBMIT([task, gate]),
      UNTIL_TAKEN({ status: 'done', summary: 'The child is done.', commit: { subject: 'Write a, once more' }, promote: ['1:#1/F1'] }),
    ], {
      runner: runner(),
      tasks: [delegated({ grants: ['delegate'] }), check()],
      below: { g: [SUBMIT([childTask('a', 1)]), CALL({ status: 'done', summary: 'The grandchild is done.', commit: { subject: 'Write a' }, promote: ['#1/F1'] })] },
    });
    await endsDone(parent);

    const [item] = taskOf(parent, 'd')?.handoff?.subtree?.promoted ?? [];
    expect(item).toMatchObject({ ref: { node: 'root/1/1', task: 'a', attempt: 1, finding: 'F1', label: '#1' }, finding: { title: 'A race in the writer' } });
    expect((await parent.readBelow({ task: '1/1:#1@1/F1' })).text).toContain('A race in the writer');
    parent.destroy();
  });
});

describe('a delegated task on a surface (ADR-0055 D20)', () => {
  it('adds its child\'s tasks and planner to the plan\'s usage, charged once', async () => {
    const SPENDS_THEN_DONE: Turn = async (tools, text) => {
      built.planner.requests[0].onProgress?.({ type: 'usage', record: { source: 'claude-code', model: 'opus', inputTokens: 300, outputTokens: 0 } } as never);
      await DONE(tools, text);
    };
    const built = tree([SUBMIT([childTask('a', 1)]), SPENDS_THEN_DONE], { runner: writingRunner({ a: ['a.txt'] }, { usage: 700 }) });
    const { parent } = built;
    await endsDone(parent, 'c');

    const usage = planUsage(parent.planTasks);
    // 700 from the child's task and 300 from its subplanner are the delegated task's; the root's check reported its own 700.
    expect(taskUsageSummary(taskOf(parent, 'd')!).totals.inputTokens).toBe(1_000);
    expect(usage.totals.inputTokens).toBe(1_700);
    expect(usage.byModel).toEqual([expect.objectContaining({ source: 'claude-code', model: 'opus', totals: expect.objectContaining({ inputTokens: 1_700 }) })]);
    // The ledger charged the child once: a roll-up is a view of what it spent, not more spending.
    expect(taskOf(parent, 'd')?.handoff?.subtree?.counts.tokens).toBe(1_000);
    parent.destroy();
  });

  it('holds no context meter of a session that is not its own', async () => {
    const inner = writingRunner({ a: ['a.txt'] }, { usage: 700 });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: inner });
    await endsDone(parent);
    expect(taskUsageSummary(taskOf(parent, 'd')!).contextFill).toBeUndefined();
    parent.destroy();
  });

  it('logs one line each time a child task\'s status changes, and reads it back from the saved log', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE]);
    await endsDone(parent);
    const said = parent.taskLog('d', 1).flatMap((event) => (event.type === 'text' ? [event.text] : []));
    const lines = said.join('').split('\n').filter(Boolean);
    expect(lines).toEqual(expect.arrayContaining(['#1 "Write a": completed', '#2 "Write b": completed']));
    expect(new Set(lines).size).toBe(lines.length);
    parent.destroy();
  });

  it('never offers a child session as a session to open', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await endsDone(parent);
    const child = taskOf(parent, 'd')?.runnerSessionId ?? parent.planState?.isolation?.run.tasks.d?.childSession;
    parent.destroy();
    await vi.waitFor(() => expect(listChildSessions('session-root', root)).toHaveLength(1));
    const [saved] = listChildSessions('session-root', root);
    if (child) expect(saved).toBe(child);
    expect(listSessions(root).map((meta) => meta.id)).toEqual(['session-root']);
    expect(loadSession(saved, root)).toBeNull();
  });
});
