import { describe, expect, it } from 'vitest';
import { memoStageLayout, stageLayout, stagesOf, stageSummary } from '../layout';

describe('stagesOf', () => {
  it('puts a task one stage past its latest dependency', () => {
    //   a ── b ── c
    //   └───────── d     (d depends on a and c: it waits for the later)
    const stages = stagesOf(['a', 'b', 'c', 'd', 'e'], new Map([
      ['b', ['a']], ['c', ['b']], ['d', ['a', 'c']],
    ]));
    expect(Object.fromEntries(stages)).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 1 });
  });

  it('ignores a dependency outside the plan', () => {
    expect(stagesOf(['a'], new Map([['a', ['gone']]])).get('a')).toBe(1);
  });
});

describe('stageLayout', () => {
  it('groups by stage and keeps plan order within one', () => {
    const layout = stageLayout([
      { id: 'a', stage: 1 }, { id: 'b', stage: 2 }, { id: 'c', stage: 1 }, { id: 'd', stage: 2 },
    ]);
    expect(layout.columns).toEqual([['a', 'c'], ['b', 'd']]);
    expect(layout.at.get('d')).toEqual({ column: 1, row: 1 });
  });

  it('leaves no empty column for a stage nothing is in', () => {
    const layout = stageLayout([{ id: 'a', stage: 1 }, { id: 'b', stage: 3 }]);
    expect(layout.columns).toEqual([['a'], ['b']]);
    expect(layout.at.get('b')).toEqual({ column: 1, row: 0 });
  });
});

describe('memoStageLayout', () => {
  it('answers a status tick with the same layout, and a new shape with a new one', () => {
    const layout = memoStageLayout();
    const nodes = [{ id: 'a', stage: 1 }];
    const first = layout('k1', nodes);
    expect(layout('k1', [{ id: 'a', stage: 1 }])).toBe(first);
    expect(layout('k2', nodes)).not.toBe(first);
  });
});

describe('stageSummary', () => {
  it('takes the first status that applies, in the design order', () => {
    expect(stageSummary(['passed', 'needs-you', 'failed']).status).toBe('needs-you');
    expect(stageSummary(['failed', 'running']).status).toBe('failed');
    expect(stageSummary(['blocked', 'running']).status).toBe('running');
    expect(stageSummary(['stalled', 'blocked']).status).toBe('running');
    expect(stageSummary(['waiting-for-merge', 'blocked']).status).toBe('blocked');
    expect(stageSummary(['not-started', 'waiting-for-merge']).status).toBe('waiting-for-merge');
    expect(stageSummary(['passed', 'not-started']).status).toBe('not-started');
    expect(stageSummary(['passed', 'skipped']).status).toBe('passed');
  });

  it('counts passed, skipped and waiting for merge as done', () => {
    expect(stageSummary(['passed', 'skipped', 'waiting-for-merge', 'running', 'failed'])).toMatchObject({ done: 3, total: 5 });
  });
});
