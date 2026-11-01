import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRunner } from '../../interfaces/IRunner';
import { git, removeRepos, check, childTask, delegated, taskOf, tree, writingRunner, CALL, SUBMIT } from './delegationTestKit';

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

