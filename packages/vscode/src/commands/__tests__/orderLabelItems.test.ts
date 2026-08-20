import { describe, it, expect } from 'vitest';
import { orderLabelItems } from '../CommandRegistry';
import { createEmptyPlan, createTask } from '@ordewell/core';

describe('orderLabelItems', () => {
  it('labels subtasks with parent-scoped dotted labels in the quickpick', () => {
    const plan = createEmptyPlan();
    plan.tasks = [
      createTask({ id: 't1', order: 1, title: 'Solo' }),
      createTask({
        id: 'p2', order: 2, title: 'Parent',
        subtasks: [
          createTask({ id: 's1', order: 1, title: 'Sub A' }),
          createTask({ id: 's2', order: 2, title: 'Sub B' }),
        ],
      }),
    ];
    const items = orderLabelItems(plan);
    expect(items.map((i) => i.label)).toEqual([
      '1. Solo',
      '2. Parent',
      '2.1. Sub A',
      '2.2. Sub B',
    ]);
    expect(items[2].description).toBe('s1');
  });
});
