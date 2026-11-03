import { describe, expect, it } from 'vitest';
import { IDLE_ACTIVITY, type RunView } from '@ordewell/core';
import { surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { buildGraph, describeEdges, graphTasks, type GraphContext, type GraphModel } from '../graphModel';
import { runTask } from './fixtures';

const CTX: GraphContext = { expanded: new Set(), executing: false, handoffPending: false, now: new Date('2026-11-03T12:00:00Z') };

function built(model: GraphModel) {
  if (!model.ok) throw new Error(model.reason);
  return model;
}

describe('buildGraph: dependencies', () => {
  it('has one node per top-level task, in order, and an edge per dependency', () => {
    const model = built(buildGraph([
      runTask({ id: 'c', order: 3, dependencies: ['a', 'b'] }),
      runTask({ id: 'a', order: 1 }),
      runTask({ id: 'b', order: 2, dependencies: ['a'] }),
    ], CTX));
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(model.edges.map((e) => e.id).sort()).toEqual(['a->b', 'a->c', 'b->c']);
    const c = model.nodes.find((n) => n.id === 'c')!;
    expect(c.dependsOn.sort()).toEqual(['a', 'b']);
    expect(model.nodes[0]!.dependents.sort()).toEqual(['b', 'c']);
  });

  it('draws a dependency on a subtask as one on the top-level task that holds it', () => {
    const model = built(buildGraph([
      runTask({ id: 'a', order: 1, subtasks: [runTask({ id: 'a1', order: 1 })] }),
      runTask({ id: 'b', order: 2, dependencies: ['a1'] }),
    ], CTX));
    expect(model.edges.map((e) => e.id)).toEqual(['a->b']);
  });

  it('ignores a dependency on a task that is not in the plan, and on itself', () => {
    const model = built(buildGraph([runTask({ id: 'a', order: 1, dependencies: ['gone', 'a'] })], CTX));
    expect(model.edges).toEqual([]);
  });

  it('refuses to lay out a loop of dependencies and names the tasks in it', () => {
    const model = buildGraph([
      runTask({ id: 'a', order: 1, dependencies: ['b'] }),
      runTask({ id: 'b', order: 2, dependencies: ['a'] }),
      runTask({ id: 'c', order: 3 }),
    ], CTX);
    expect(model).toEqual({ ok: false, reason: expect.stringContaining('#1, #2') });
    expect(model.ok ? '' : model.reason).not.toContain('#3');
  });
});

describe('buildGraph: what a node says', () => {
  it('is named by its order, title and status, and describes its edges', () => {
    const model = built(buildGraph([
      runTask({ id: 'a', order: 1, title: 'Add the route', status: 'completed' }),
      runTask({ id: 'b', order: 2, title: 'Wire it up', dependencies: ['a'] }),
    ], CTX));
    const [a, b] = model.nodes;
    expect(a!.label).toMatch(/^#1 Add the route, /);
    expect(a!.description).toBe('#2 depends on it');
    expect(b!.description).toBe('depends on #1');
  });

  it('says the runner, model and effort of an AI task and nothing of a manual one', () => {
    const model = built(buildGraph([
      runTask({ id: 'a', order: 1, type: 'ai', assignedRunner: 'claude-code', assignedModel: { modelId: 'm', modelLabel: 'Opus', thinkingEffort: 'high' } as never }),
      runTask({ id: 'b', order: 2, type: 'user' }),
    ], CTX));
    expect(model.nodes[0]!.assignment).toBe('Claude Code · Opus · high');
    expect(model.nodes[1]!.assignment).toBeNull();
    expect(model.nodes[1]!.badges.map((b) => b.kind)).toEqual(['manual']);
  });

  it('badges a research task', () => {
    const model = built(buildGraph([runTask({ id: 'a', order: 1, type: 'ai', research: true, assignedRunner: 'claude-code' })], CTX));
    expect(model.nodes[0]!.badges.map((b) => b.label)).toContain('Research');
  });

  it('changes its viewKey exactly when what it draws changes', () => {
    const before = built(buildGraph([runTask({ id: 'a', order: 1 })], CTX)).nodes[0]!;
    const same = built(buildGraph([runTask({ id: 'a', order: 1 })], CTX)).nodes[0]!;
    const after = built(buildGraph([runTask({ id: 'a', order: 1, status: 'in_progress' })], CTX)).nodes[0]!;
    expect(same.viewKey).toBe(before.viewKey);
    expect(after.viewKey).not.toBe(before.viewKey);
  });
});

describe('buildGraph: folding', () => {
  const parent = runTask({
    id: 'p', order: 2, title: 'Parent',
    subtasks: [runTask({ id: 'p1', order: 1, title: 'First', status: 'completed' }), runTask({ id: 'p2', order: 2, title: 'Second' })],
  });

  it('folds subtasks into their parent node: no node or edge of their own', () => {
    const model = built(buildGraph([runTask({ id: 'a', order: 1 }), parent], CTX));
    expect(model.nodes.map((n) => n.id)).toEqual(['a', 'p']);
    const node = model.nodes[1]!;
    expect(node.fold?.summary).toBe('2 subtasks');
    expect(node.fold?.subtasks.map((s) => s.orderLabel)).toEqual(['2.1', '2.2']);
  });

  it('is taller when opened, and so lays out again; a fold that is shut keeps the shape', () => {
    const shut = built(buildGraph([parent], CTX));
    const open = built(buildGraph([parent], { ...CTX, expanded: new Set(['p']) }));
    expect(open.nodes[0]!.height).toBeGreaterThan(shut.nodes[0]!.height);
    expect(open.layoutKey).not.toBe(shut.layoutKey);
  });

  it('does not grow a node that holds nothing', () => {
    const model = built(buildGraph([runTask({ id: 'a', order: 1 })], { ...CTX, expanded: new Set(['a']) }));
    expect(model.nodes[0]!.fold).toBeNull();
    expect(model.nodes[0]!.height).toBe(78);
  });

  it('folds a delegated task\'s child plan into its node', () => {
    const model = built(buildGraph([runTask({
      id: 'd', order: 1, type: 'ai', assignedRunner: 'claude-code',
      delegation: { goal: 'Port the parser', children: [], budget: { remaining: 3 } } as never,
    })], CTX));
    const node = model.nodes[0]!;
    if (node.row.delegated) {
      expect(node.fold?.childPlan?.goal).toBe('Port the parser');
      expect(node.fold?.summary).toMatch(/^Child plan/);
    } else {
      expect(node.fold).toBeNull();
    }
  });
});

describe('buildGraph: loops', () => {
  const tasks = (round?: number) => [
    runTask({ id: 'check', order: 1, status: 'in_progress', loop: { body: ['fix'], maxRounds: 3 }, loopRound: round }),
    runTask({ id: 'fix', order: 2, dependencies: ['check'] }),
  ];

  it('badges the check with its round of the most, and its body with the check it runs for', () => {
    const model = built(buildGraph(tasks(2), CTX));
    expect(model.nodes[0]!.loop).toMatchObject({ role: 'check', label: '⟲ 2/3' });
    expect(model.nodes[1]!.loop).toMatchObject({ role: 'body', label: '⟲ #1' });
  });

  it('starts at round 1 and never shows a round past the most', () => {
    expect(built(buildGraph(tasks(), CTX)).nodes[0]!.loop?.label).toBe('⟲ 1/3');
    expect(built(buildGraph(tasks(9), CTX)).nodes[0]!.loop?.label).toBe('⟲ 3/3');
  });

  it('draws no back-edge: the body depends on the check and nothing returns', () => {
    const model = built(buildGraph(tasks(1), CTX));
    expect(model.edges.map((e) => e.id)).toEqual(['check->fix']);
  });

  it('badges a task in no loop with nothing', () => {
    expect(built(buildGraph([runTask({ id: 'a', order: 1 })], CTX)).nodes[0]!.loop).toBeNull();
  });
});

describe('buildGraph: the critical path', () => {
  const chain = [
    runTask({ id: 'a', order: 1, status: 'completed' }),
    runTask({ id: 'b', order: 2, status: 'in_progress', dependencies: ['a'] }),
    runTask({ id: 'c', order: 3, dependencies: ['b'] }),
    runTask({ id: 'd', order: 4, dependencies: ['c'] }),
    runTask({ id: 'e', order: 5, dependencies: ['a'] }),
  ];

  it('is drawn only while the plan runs', () => {
    expect(built(buildGraph(chain, CTX)).nodes.some((n) => n.critical)).toBe(false);
    expect(built(buildGraph(chain, { ...CTX, executing: true })).nodes.some((n) => n.critical)).toBe(true);
  });

  it('is the longest chain of work not yet settled, and leaves the done work out', () => {
    const model = built(buildGraph(chain, { ...CTX, executing: true }));
    expect(model.nodes.filter((n) => n.critical).map((n) => n.id)).toEqual(['b', 'c', 'd']);
    expect(model.edges.filter((e) => e.critical).map((e) => e.id).sort()).toEqual(['b->c', 'c->d']);
  });

  it('is not drawn for a single unfinished task', () => {
    const model = built(buildGraph([runTask({ id: 'a', order: 1, status: 'in_progress' })], { ...CTX, executing: true }));
    expect(model.nodes[0]!.critical).toBe(false);
  });
});

describe('buildGraph: edge states', () => {
  const state = (tasks: Parameters<typeof buildGraph>[0]) => built(buildGraph(tasks, CTX)).edges[0]!.state;

  it('reads each by what its source did', () => {
    const dep = { dependencies: ['a'] };
    expect(state([runTask({ id: 'a', order: 1, status: 'completed' }), runTask({ id: 'b', order: 2, ...dep })])).toBe('satisfied');
    expect(state([runTask({ id: 'a', order: 1, status: 'failed' }), runTask({ id: 'b', order: 2, ...dep })])).toBe('failed');
    expect(state([runTask({ id: 'a', order: 1, status: 'in_progress' }), runTask({ id: 'b', order: 2, ...dep })])).toBe('pending');
    expect(state([runTask({ id: 'a', order: 1, status: 'completed' }), runTask({ id: 'b', order: 2, status: 'in_progress', ...dep })])).toBe('active');
  });

  it('marks the edge out of a landed task whose work waits for Merge all', () => {
    const landed = runTask({ id: 'a', order: 1, status: 'completed', isolation: { state: 'integrated' } as never });
    const model = built(buildGraph([landed, runTask({ id: 'b', order: 2, dependencies: ['a'] })], { ...CTX, handoffPending: true }));
    expect(model.edges[0]!.state).toBe('merge');
  });
});

describe('buildGraph: layoutKey', () => {
  it('is the same across a status change, so the nodes do not move', () => {
    const plan = (status: 'pending' | 'in_progress' | 'completed') => [
      runTask({ id: 'a', order: 1, status }),
      runTask({ id: 'b', order: 2, dependencies: ['a'] }),
    ];
    expect(built(buildGraph(plan('pending'), CTX)).layoutKey).toBe(built(buildGraph(plan('completed'), { ...CTX, executing: true })).layoutKey);
  });

  it('changes when a dependency is added or a task is', () => {
    const one = built(buildGraph([runTask({ id: 'a', order: 1 }), runTask({ id: 'b', order: 2 })], CTX)).layoutKey;
    const wired = built(buildGraph([runTask({ id: 'a', order: 1 }), runTask({ id: 'b', order: 2, dependencies: ['a'] })], CTX)).layoutKey;
    const more = built(buildGraph([runTask({ id: 'a', order: 1 }), runTask({ id: 'b', order: 2 }), runTask({ id: 'c', order: 3 })], CTX)).layoutKey;
    expect(new Set([one, wired, more]).size).toBe(3);
  });
});

describe('describeEdges', () => {
  it('words each case', () => {
    expect(describeEdges([], [])).toBe('no dependencies');
    expect(describeEdges(['#1'], ['#3'])).toBe('depends on #1; #3 depends on it');
    expect(describeEdges([], ['#2', '#3', '#4'])).toBe('#2, #3 and #4 depend on it');
  });
});

describe('graphTasks', () => {
  const plan = surfacePlan([
    surfaceTask({ id: 'a', order: 1, title: 'One' }),
    surfaceTask({ id: 'b', order: 2, title: 'Two', dependencies: ['a'] }),
  ]);
  const idle = { tasks: [], runMerge: null, handoff: null, mergeResult: null, activity: IDLE_ACTIVITY, escalations: [] } as RunView;

  it('draws a plan that has not started, which the run holds nothing of yet', () => {
    expect(graphTasks(plan, idle).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('takes the run\'s entry where it has one, being the newer word on a task', () => {
    const running = runTask({ id: 'a', order: 1, status: 'in_progress', attempted: true });
    const tasks = graphTasks(plan, { ...idle, tasks: [running] });
    expect(tasks[0]).toBe(running);
    expect(tasks[1]!.id).toBe('b');
  });

  it('falls back to the run alone when there is no plan', () => {
    const only = runTask({ id: 'a', order: 1 });
    expect(graphTasks(null, { ...idle, tasks: [only] })).toEqual([only]);
  });
});
