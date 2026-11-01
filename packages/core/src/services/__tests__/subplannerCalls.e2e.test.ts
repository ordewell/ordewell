import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAiService } from '../AiService';
import { makeSession, scriptedPlanner } from './sessionTestKit';
import { CALL, DONE, SUBMIT, childTask, removeRepos, taskOf, tree, writingRunner } from './delegationTestKit';

/* What a subplanner is told, and what it is spared, on real repositories (ADR-0057 R5). */

afterEach(removeRepos);

const endsDone = async (parent: ReturnType<typeof tree>['parent']) => {
  await parent.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => {
    const task = taskOf(parent, 'd');
    if (task?.status === 'failed') throw new Error(`It failed: ${task.verdict?.reason}`);
    expect(task?.status).toBe('completed');
  }, { timeout: 20_000 });
};

describe('a subplanner\'s plan', () => {
  it('is answered with a request for one line, where nobody reads more: an empty reply would be nudged', async () => {
    const replies: string[] = [];
    const { parent } = tree([async (tools) => {
      replies.push((await tools.submitPlan!({ tasks: [childTask('a', 1)] as never }, { signal: new AbortController().signal })).text);
    }, DONE]);
    await endsDone(parent);
    expect(replies[0]).toContain('End your turn now, with one line');
    expect(replies[0]).not.toMatch(/the user/i);
    parent.destroy();
  });

  it('is answered as it was for a planner with someone to read it', async () => {
    const replies: string[] = [];
    const planner = scriptedPlanner([async (tools) => {
      replies.push((await tools.submitPlan!({ tasks: [childTask('a', 1)] as never }, { signal: new AbortController().signal })).text);
    }]);
    const session = makeSession({
      aiService: { reset: vi.fn(), ...planner.service } as unknown as Partial<IAiService>,
      modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({}) },
    });
    await session.startPlanning('a flat goal');
    expect(replies[0]).toContain('Tell them briefly what you submitted');
    session.destroy();
  });
});

describe('a subplanner\'s catalog', () => {
  it('is in what it is told, not a call its wake reminds it of', async () => {
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await endsDone(parent);
    expect(planner.asked[1]).toMatch(/Run update:/);
    expect(planner.asked[1]).not.toMatch(/call list_runners and list_models/);
    parent.destroy();
  });
});

describe('a subplanner\'s wake', () => {
  it('after a clean run asks for its report, with nothing about editing a plan or a user', async () => {
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await endsDone(parent);
    const wake = planner.asked[1];
    expect(wake).toMatch(/call task_complete/);
    expect(wake).toContain('<current_plan>');
    expect(wake).not.toContain('"op":"update"');
    expect(wake).not.toMatch(/the user/i);
    parent.destroy();
  });

  it('after a failure keeps how to change the plan, and the guards that hold it', async () => {
    const failing = writingRunner({ a: ['a.txt'] }, { reports: { a: { status: 'failed', reason: 'It broke.' } } });
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), CALL({ status: 'blocked', summary: 'a broke', reason: 'a broke' })], { runner: failing });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(planner.asked).toHaveLength(2), { timeout: 20_000 });
    expect(planner.asked[1]).toContain('"op":"update"');
    expect(planner.asked[1]).toMatch(/Loop guards hold you/);
    expect(planner.asked[1]).not.toMatch(/tell the user/i);
    parent.destroy();
  });
});
