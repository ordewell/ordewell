import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRunner } from '../../interfaces/IRunner';
import { git, removeRepos, check, childTask, delegated, taskOf, tree, writingRunner, CALL, SUBMIT } from './delegationTestKit';
import type { PlannerTurn as Turn } from './sessionTestKit';

/* Two gates pressed on delegation (ADR-0055 D7, D18): a nested subtree held to every ancestor's protected paths, and a
 * tree that runs with one slot at two levels. Both hold today; they are kept as the shape a later change must not break. */

afterEach(removeRepos);

const DONE = CALL({ status: 'done', summary: 'Done.', commit: { subject: 'Do it' } });

const statusOf = (session: ReturnType<typeof tree>['parent'], id: string) => taskOf(session, id)?.status;
const integrationOf = (session: ReturnType<typeof tree>['parent']) => session.planState?.isolation?.run.repos[0].integrationBranch ?? '';

const grandchild = (over: Record<string, unknown> = {}) => ({
  id: 'g', order: 1, title: 'Grandchild', description: 'g', type: 'delegated', goal: 'Write a',
  budget: { tokens: 1_000_000 }, protectedPaths: ['docs/'], sliceType: 'AFK', autonomy: 'AFK', dependencies: [], ...over,
});
const gate = (id: string, on: string) => ({ id, order: 2, title: `Read ${on}`, description: 'c', type: 'ai', prompt: 'read it', taskMode: 'plan', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: [on] });

describe('a nested subtree cannot reach past its ancestors\' protected paths', () => {
  it('fails the verdict of a grandchild that changes what its grandparent protected', async () => {
    // The root protects `tests/`; the nested delegated task protects only `docs/`.
    const wrote: Record<string, unknown> = {};
    const inner = writingRunner({ a: ['tests/guard.txt'] });
    const runner = {
      ...inner,
      spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => { wrote[opts.taskId] = true; return inner.spawn(opts); }),
    };
    const { root, parent } = tree(
      [SUBMIT([grandchild(), gate('gc', 'g')]), DONE],
      {
        runner,
        tasks: [delegated({ grants: ['delegate'] }), check()],
        below: { g: [SUBMIT([childTask('a', 1)]), CALL({ status: 'done', summary: 'Wrote it.', commit: { subject: 'Write a' } })] },
      },
    );
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(['failed', 'blocked', 'completed']).toContain(statusOf(parent, 'd')), { timeout: 30_000 });
    // Whatever the outer task's status, nothing may have carried the grandchild's edit of `tests/` up.
    const integration = integrationOf(parent);
    if (integration) expect(git(root, 'show', `${integration}:tests/guard.txt`)).toBe('the check reads this');
    else expect(git(root, 'show', 'HEAD:tests/guard.txt')).toBe('the check reads this');
    expect(wrote.a).toBe(true);
    // And the delegated task must not have passed on work that broke a protected path.
    expect(statusOf(parent, 'd')).not.toBe('completed');
    parent.destroy();
  });
});

describe('a subplanner\'s plan is held to what its tree has left (ADR-0056 M5)', () => {
  it('refuses budgets that together pass its room as it writes them, and takes them once they fit', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const submitting = (tasks: unknown[]) => async (tools: Parameters<ReturnType<typeof SUBMIT>>[0]) => {
      replies.push(await tools.submitPlan!({ tasks: tasks as never }, { signal: new AbortController().signal }));
    };
    // Its 2,000,000 less the 200,000 a subplanner keeps for its own turns.
    const twins = (tokens: number) => [grandchild({ budget: { tokens } }), gate('gc', 'g'), grandchild({ id: 'h', order: 3, title: 'Second', budget: { tokens } }), gate('hc', 'h')];
    const { parent, planner } = tree(
      [submitting(twins(1_000_000)), submitting(twins(900_000)), DONE],
      {
        runner: writingRunner({ a: ['a.txt'], b: ['b.txt'] }),
        tasks: [delegated({ grants: ['delegate'] }), check()],
        below: {
          g: [SUBMIT([childTask('a', 1)]), CALL({ status: 'done', summary: 'Wrote it.', commit: { subject: 'Write a' } })],
          h: [SUBMIT([childTask('b', 1)]), CALL({ status: 'done', summary: 'Wrote it.', commit: { subject: 'Write b' } })],
        },
      },
    );
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies.length).toBe(2), { timeout: 30_000 });
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('Level 1 refused limits.tokens: asked 2000000, and there is 1800000.') });
    expect(planner.requests[0].delegation?.tokens).toBe(1_800_000);
    expect(replies[1].isError).toBeFalsy();
    await vi.waitFor(() => expect(['failed', 'completed']).toContain(statusOf(parent, 'd')), { timeout: 30_000 });
    parent.destroy();
  });
});

describe('a root\'s plan is held to what its tree has left (ADR-0056 M5)', () => {
  it('counts what an open child holds, and reads the setting as it stands', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const raise: Turn = async (tools) => {
      replies.push(await tools.editPlan!({ ops: [{ op: 'update', taskId: 'e', changes: { budget: { tokens: 4_000_000 } } }] as never }, { signal: new AbortController().signal }));
    };
    const talkToRoot: Turn = async () => {
      await rootTree.parent.continueConversation('Give e more.');
      rootTree.parent.applyRunSettings({ delegationTokens: 7_000_000 });
      await rootTree.parent.continueConversation('Now give e more.');
    };
    const rootTree = tree([talkToRoot, SUBMIT([childTask('a', 1)]), DONE], {
      rootTurns: [raise, raise],
      tasks: [delegated(), check(), delegated({ id: 'e', order: 3, title: 'Later subtree', budget: { tokens: 1_000_000 }, dependencies: ['c'] }), check({ id: 'ec', order: 4, title: 'Check later', dependencies: ['e'] })],
    });
    await rootTree.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 30_000 });

    // Five million less the two the open child holds; the raise then fits what a seven million tree has left.
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('Level 0 refused limits.tokens: asked 4000000, and there is 3000000.') });
    expect(replies[1].isError).toBeFalsy();
    expect(taskOf(rootTree.parent, 'e')?.budget?.tokens).toBe(4_000_000);
    rootTree.parent.destroy();
  });
});

describe('a tree runs with one slot', () => {
  it('does not deadlock two levels down at Parallel 1', async () => {
    const { parent } = tree(
      [SUBMIT([grandchild(), gate('gc', 'g')]), DONE],
      {
        parallel: 1,
        runner: writingRunner({ a: ['a.txt'] }),
        tasks: [delegated({ grants: ['delegate'] }), check()],
        below: { g: [SUBMIT([childTask('a', 1)]), CALL({ status: 'done', summary: 'Wrote it.', commit: { subject: 'Write a' } })] },
      },
    );
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 30_000 });
    parent.destroy();
  });
});

describe('a subplanner assigns only what its mandate holds (ADR-0056 M3)', () => {
  const submitting = (replies: { text: string; isError?: boolean }[], tasks: unknown[], first?: () => void) => async (tools: Parameters<ReturnType<typeof SUBMIT>>[0]) => {
    first?.();
    replies.push(await tools.submitPlan!({ tasks: tasks as never }, { signal: new AbortController().signal }));
  };
  const on = (assignedRunner: string, assignedModel?: string) => ({ ...childTask('a', 1), assignedRunner, ...(assignedModel ? { assignedModel: { modelId: assignedModel } } : {}) });

  it('refuses a runner the user enabled after it was carved, and a live narrowing still reaches it', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const settings: { enabledRunners: string[] } = { enabledRunners: ['claude-code'] };
    const { parent } = tree(
      [
        submitting(replies, [on('codex')], () => { settings.enabledRunners = ['claude-code', 'codex']; }),
        submitting(replies, [on('claude-code')]),
        DONE,
      ],
      { settings },
    );
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 30_000 });

    expect(replies[0].isError).toBe(true);
    expect(replies[0].text).toMatch(/codex/);
    expect(replies[1].isError).toBeFalsy();
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 30_000 });
    parent.destroy();
  });

  it('holds a model allowlist the user cleared after it was carved', async () => {
    const settings: { modelAllowlist: Record<string, string[]> } = { modelAllowlist: { 'claude-code': ['claude-sonnet-4-6'] } };
    const spawned: Record<string, string | undefined> = {};
    const inner = writingRunner({ a: ['a.txt'] });
    const runner = {
      ...inner,
      spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => { spawned[opts.taskId] = opts.modelId; return inner.spawn(opts); }),
    };
    const { parent } = tree(
      [submitting([], [on('claude-code', 'claude-opus-4-8')], () => { settings.modelAllowlist = {}; }), DONE],
      { runner, settings },
    );
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned.a).toBeDefined(), { timeout: 30_000 });

    expect(spawned.a).toBe('claude-sonnet-4-6');
    parent.destroy();
  });
});
