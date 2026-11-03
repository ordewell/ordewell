import { describe, expect, it } from 'vitest';
import { ROOT_NODE } from '../../models/TreeEvent';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { FakeEventStore } from '../../testing';
import { ChildDirectory } from '../ChildDirectory';
import { rootMandate } from '../Mandate';
import { TreeLedger } from '../TreeLedger';

const mandate = rootMandate({ level: 'act', autorun: true, autonomous: true, delegationTokens: 1_000, runners: ['claude-code'], models: {} });

function carve(tree: TreeLedger, parent: string, tokens: number, sessionId: string, taskId: string): string {
  const carved = tree.carve(parent, mandate, { level: parent.split('/').length - 1, tokens }, { sessionId, taskId });
  if (!carved.ok) throw new Error(JSON.stringify(carved.refusal));
  return carved.budget.path;
}

const planOf = (tasks: Task[]) => ({ tasks }) as unknown as LegacyPlanState;

describe('ChildDirectory', () => {
  it('finds the title of a child whose task is a subtask of the plan above, with no Session left to say it', async () => {
    const tree = await TreeLedger.open(new FakeEventStore(), { sessionId: 'root', limit: 1_000 }, { sessionReserve: 10 });
    const above = carve(tree, ROOT_NODE, 500, 'above', 'd');
    carve(tree, above, 100, 'below', 'n');
    const nested = createTask({ id: 'n', order: 2, title: 'Nested deep', type: 'delegated' });
    const directory = new ChildDirectory({
      rootSessionId: () => 'root',
      ledger: async () => tree,
      rootTask: () => undefined,
      saved: (sessionId) => (sessionId === 'above' ? { meta: { goal: 'above' }, plan: planOf([createTask({ id: 'p', order: 1, title: 'Holder', subtasks: [nested] })]) } : null),
      logLocation: (sessionId) => ({ baseDir: '/x', sessionId }),
    });

    const entries = await directory.list();

    expect(entries.find((entry) => entry.sessionId === 'below')?.title).toBe('Nested deep');
  });
});
