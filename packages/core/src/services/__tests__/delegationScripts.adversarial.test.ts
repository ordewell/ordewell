import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRunner } from '../../interfaces/IRunner';
import { childTask, removeRepos, taskOf, tree, writingRunner, CALL, SUBMIT } from './delegationTestKit';
import type { PlannerTurn } from './sessionTestKit';

afterEach(removeRepos);

const statusOf = (session: ReturnType<typeof tree>['parent'], id: string) => taskOf(session, id)?.status;
const verdictOf = (session: ReturnType<typeof tree>['parent'], id: string) => taskOf(session, id)?.verdict;

/* The [SUBMIT, SAYS_DONE, CALL(blocked)] scripts of `delegatedTask.e2e.test.ts` end `failed` either way (a subplanner's
 * `blocked` is a failing verdict), so those cases would pass just as well if the late report never reached the verdict and
 * the completion-reminder path had ended the child with a derived one. These pin the report: `reported: 'blocked'` with
 * the author's own words in the reason, which a derived end cannot produce. */
describe('the [SUBMIT, SAYS_DONE, CALL(blocked)] scripts', () => {
  const SAYS_DONE = CALL({ status: 'done', summary: 'It is done.' });

  it('really takes the second turn\'s blocked report, and does not end on a derived one', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE, CALL({ status: 'blocked', summary: 'No change was needed.' })], { runner: writingRunner({}) });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(verdictOf(parent, 'd')).toMatchObject({ reported: 'blocked' });
    parent.destroy();
  });

  it('really takes the fourth turn\'s blocked report after a skip', async () => {
    const signal = new AbortController().signal;
    const SKIP: PlannerTurn = async (tools) => { await tools.skipTask!({ task: 'a', reason: 'It cannot be done.' }, { signal }); };
    const inner = writingRunner({});
    const failing = { ...inner, spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => { const s = new (await import('../../testing')).FakeRunnerSession(`s-${opts.taskId}`, opts.taskId); setTimeout(() => s.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5); return s; }) };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), SKIP, SAYS_DONE, CALL({ status: 'blocked', summary: 'Nothing could be done.' })], { runner: failing as never });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(verdictOf(parent, 'd')).toMatchObject({ reported: 'blocked' });
    parent.destroy();
  });
});
