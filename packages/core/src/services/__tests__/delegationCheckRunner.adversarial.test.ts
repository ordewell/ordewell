import { describe, expect, it } from 'vitest';
import { checksDelegatedTask, checksHoldingMerge } from '../../models/Delegation';
import { createTask } from '../../models/Task';

/**
 * ADR-0055 D8 and D9 hold a merge until a delegated task's check has passed,
 * and refuse a model `skip_task` on that check. Both are read from
 * `TaskOrchestrator.checkRules`, which maps every task's runner to
 * `registry.get(runner)?.manifest.modes` — so a runner this host does not have
 * (switched off since, a plugin removed, a plan opened from another machine)
 * appears as a key with `undefined` beside it.
 *
 * `readsOnly` then reads the check as not read-only, so it is not a check at
 * all: the hold is empty and a model may skip it. D9 is meant to fail closed,
 * so a check whose runner cannot be read here still has to be the check.
 */
describe('a check whose runner this host cannot read', () => {
  const delegated = createTask({ id: 'd', order: 1, title: 'Delegated', type: 'delegated', goal: 'g', budget: { tokens: 1_000 }, protectedPaths: ['tests/'] });
  const check = createTask({ id: 'c', order: 2, title: 'Check the subtree', type: 'ai', prompt: 'read it', taskMode: 'plan', dependencies: ['d'] });
  const landed = () => true;
  const unknownRunner = { runnerModes: { 'claude-code': undefined } } as never;

  it('still holds the merge its delegated task landed work for', () => {
    expect(checksHoldingMerge([delegated, check], landed, unknownRunner).map((task) => task.id)).toEqual(['c']);
  });

  it('is still a check no model may skip', () => {
    expect(checksDelegatedTask([delegated, check], check, unknownRunner)).toBe(true);
  });
});
