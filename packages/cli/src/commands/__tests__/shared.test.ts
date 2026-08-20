import { describe, it, expect } from 'vitest';
import { taskViews } from '../shared';
import type { SerializedPlan, SerializedTask } from '@ordewell/core';

const task = (over: Partial<SerializedTask>): SerializedTask => ({
  id: 't',
  order: 1,
  title: 'Task',
  type: 'ai',
  description: '',
  dependencies: [],
  assignedRunner: 'claude-code',
  assignedModel: null,
  taskMode: 'build',
  prompt: null,
  userSteps: undefined,
  thinkingEffort: undefined,
  autonomy: undefined,
  sliceType: undefined,
  userStoriesCovered: undefined,
  subtasks: [],
  ...over,
});

const plan = (tasks: SerializedTask[]): SerializedPlan => ({
  tasks,
  runners: ['claude-code'],
  generatedAt: '',
});

describe('taskViews', () => {
  it('recursively maps subtasks, sorted by order within each level', () => {
    const views = taskViews(
      plan([
        task({
          id: 'parent',
          order: 1,
          title: 'Parent',
          subtasks: [
            task({ id: 'child-b', order: 2, title: 'Child B' }),
            task({ id: 'child-a', order: 1, title: 'Child A' }),
          ],
        }),
        task({ id: 'solo', order: 2, title: 'Solo' }),
      ]),
    );

    expect(views).toHaveLength(2);
    const parent = views[0];
    expect(parent.subtasks).toHaveLength(2);
    expect(parent.subtasks!.map((s) => s.id)).toEqual(['child-a', 'child-b']);
    expect(parent.subtasks![0]).toMatchObject({ id: 'child-a', title: 'Child A', order: 1 });
    expect(parent.subtasks![0].subtasks).toEqual([]);
    expect(views[1].subtasks).toEqual([]);
  });

  it('recurses through nested grandchildren', () => {
    const views = taskViews(
      plan([
        task({
          id: 'root',
          order: 1,
          subtasks: [
            task({
              id: 'mid',
              order: 1,
              subtasks: [task({ id: 'leaf', order: 1, title: 'Leaf' })],
            }),
          ],
        }),
      ]),
    );
    expect(views[0].subtasks![0].subtasks![0].id).toBe('leaf');
  });
});