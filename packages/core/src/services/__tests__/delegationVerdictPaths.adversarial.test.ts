import { afterEach, describe, expect, it, vi } from 'vitest';
import { childTask, delegated, git, removeRepos, taskOf, tree, writingRunner, CALL, SUBMIT } from './delegationTestKit';
import type { Tree } from './delegationTestKit';
import type { PlannerTurn } from './sessionTestKit';

afterEach(removeRepos);

const SAYS_DONE = CALL({ status: 'done', summary: 'It is done.', commit: { subject: 'Write a' } });

const landed = ({ root, parent }: Tree) => git(root, 'ls-tree', '-r', '--name-only', '-z', parent.planState?.isolation?.run.repos[0].integrationBranch ?? 'main').split('\0');

/** One child task that writes `files`, under `rules`, run to the delegated task's verdict. */
async function verdictOver(files: string[], rules: string[]): Promise<{ run: Tree; status: string | undefined; reason: string | undefined }> {
  const run = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({ a: ['a.txt', ...files] }), tasks: [delegated({ protectedPaths: rules })] });
  await run.parent.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => expect(['completed', 'failed']).toContain(taskOf(run.parent, 'd')?.status), { timeout: 20_000 });
  const task = taskOf(run.parent, 'd');
  return { run, status: task?.status, reason: task?.verdict?.reason };
}

/* A protected path is the one check of the work no model reads (ADR-0055 D7), so
 * what it reads has to be every path the branch changed: a list trimmed for
 * display, or a rule a name can step around, lands what the rule was to stop. */
describe('the paths a verdict reads', () => {
  it.each<[file: string, rule: string]>([
    ['.ordewell/skills/deploy/SKILL.md', '.ordewell/skills/'],
    ['tests/.ordewell/planted.test.ts', '**/*.test.ts'],
    ['src/.ordewell/deep/a.ts', 'src/'],
  ])('holds %s under %j, though no diff a person reads lists it', async (file, rule) => {
    const { run, status, reason } = await verdictOver([file], [rule]);
    expect(status).toBe('failed');
    expect(reason).toContain(file);
    expect(landed(run)).not.toContain(file);
    expect(landed(run)).not.toContain('a.txt');
    run.parent.destroy();
  });

  it('holds a file named around a line break under a pattern', async () => {
    const file = 'src/x\ny/guard.test.ts';
    const { run, status } = await verdictOver([file], ['**/*.test.ts']);
    expect(status).toBe('failed');
    expect(landed(run)).not.toContain(file);
    expect(landed(run)).not.toContain('a.txt');
    run.parent.destroy();
  });

  it('still lands what no rule names', async () => {
    const { run, status } = await verdictOver(['docs/.ordewell/note.md'], ['tests/']);
    expect(status).toBe('completed');
    expect(landed(run)).toContain('docs/.ordewell/note.md');
    run.parent.destroy();
  });
});

/* A workspace can be a folder of its repository, while a worktree is the whole of it:
 * what a task changes beside that folder lands with the rest, so a verdict reads it too. */
describe('the paths a verdict reads, in a workspace below the repository root', () => {
  async function verdictIn(folder: string, files: string[], rules: string[]) {
    const run = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({ a: ['a.txt', ...files] }), tasks: [delegated({ protectedPaths: rules })], folder });
    await run.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(taskOf(run.parent, 'd')?.status), { timeout: 20_000 });
    const task = taskOf(run.parent, 'd');
    const integration = run.parent.planState?.isolation?.run.repos[0].integrationBranch ?? 'main';
    return { run, status: task?.status, reason: task?.verdict?.reason, files: git(run.root, 'ls-tree', '-r', '--name-only', '--full-tree', integration).split('\n') };
  }

  it.each<[case_: string, file: string, rule: string]>([
    ['beside the folder, from the repository root', '../ci/deploy.yml', 'ci/'],
    ['in the folder, by its place in the workspace', 'tests/guard.test.ts', 'tests/'],
    ['in the folder, from the repository root', 'tests/guard.test.ts', 'pkg/tests/'],
    ['in the folder, by a pattern from the repository root', 'tests/guard.test.ts', 'pkg/**/*.test.ts'],
    ['beside the folder, by a name at any depth', '../deep/er/secret.env', '*.env'],
  ])('holds a change %s', async (_, file, rule) => {
    const { run, status, reason, files } = await verdictIn('pkg', [file], [rule]);
    expect(status).toBe('failed');
    expect(reason).toContain(file.replace('../', ''));
    expect(files).not.toContain('pkg/a.txt');
    run.parent.destroy();
  });

  it('still lands what no rule names, on either side of the folder', async () => {
    const { run, status, files } = await verdictIn('pkg', ['../docs/note.md'], ['ci/', 'pkg/tests/']);
    expect(status).toBe('completed');
    expect(files).toContain('pkg/a.txt');
    expect(files).toContain('docs/note.md');
    run.parent.destroy();
  });

  it('counts a change beside the folder as work, which is all that lands', async () => {
    const run = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({ a: ['../docs/note.md'] }), tasks: [delegated({ protectedPaths: ['ci/'] })], folder: 'pkg' });
    await run.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(taskOf(run.parent, 'd')?.status), { timeout: 20_000 });
    expect(taskOf(run.parent, 'd')?.status).toBe('completed');
    run.parent.destroy();
  });
});

/* `task_complete` is the attempt's end: a start behind it runs past every read
 * the report was judged by (ADR-0055 D6, D7), so nothing may start there. */
describe('work after a report is taken', () => {
  const SIGNAL = { signal: new AbortController().signal };
  const REPORT = { status: 'done', summary: 'It is done.', commit: { subject: 'Write a' } } as const;

  it('starts nothing and edits no plan, so a task after the report lands nothing', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const plantsAfterReporting: PlannerTurn = async (tools) => {
      replies.push(await tools.taskComplete!(REPORT, SIGNAL));
      replies.push(await tools.editPlan!({ ops: [{ op: 'add', task: { ...childTask('b', 2), id: undefined, order: undefined } }] as never }, SIGNAL));
      replies.push(await tools.retryTask!({ task: 'a', from: 'session', message: 'Add one thing more.' }, SIGNAL));
    };
    const run = tree([SUBMIT([childTask('a', 1)]), plantsAfterReporting], { runner: writingRunner({ a: ['a.txt'] }), tasks: [delegated()] });

    await run.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(taskOf(run.parent, 'd')?.status), { timeout: 20_000 });

    expect(replies[0].isError).toBeFalsy();
    expect(replies[1]).toMatchObject({ isError: true, text: expect.stringContaining('reported') });
    expect(replies[2]).toMatchObject({ isError: true, text: expect.stringContaining('reported') });
    expect(taskOf(run.parent, 'd')?.status).toBe('completed');
    expect(landed(run)).toContain('a.txt');
    run.parent.destroy();
  });
});
