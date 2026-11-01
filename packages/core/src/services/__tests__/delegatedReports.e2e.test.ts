import { afterEach, describe, expect, it, vi } from 'vitest';
import { DONE, SUBMIT, childTask, removeRepos, taskOf, tree, writingRunner } from './delegationTestKit';

/* What a subtree sends up and what it costs, on real repositories (ADR-0057, ADR-0055 D20). */

afterEach(removeRepos);

const endsDone = async (parent: ReturnType<typeof tree>['parent'], id = 'd') => {
  await parent.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => expect(taskOf(parent, id)?.status).toBe('completed'), { timeout: 20_000 });
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
