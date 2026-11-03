import { describe, it, expect } from 'vitest';
import { EMPTY_RUN, type RunView, type SerializedTask } from '@ordewell/core';
import { RunViewHost } from '../RunViewHost';
import type { HostToWebview } from '@ordewell/ui/protocol';

function planned(id: string, order: number): SerializedTask {
  return {
    id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
  };
}

function host(seed: RunView = EMPTY_RUN): { host: RunViewHost; posted: RunView[] } {
  const posted: RunView[] = [];
  const h = new RunViewHost((msg: HostToWebview) => { if (msg.type === 'runView') posted.push(msg.view); });
  h.adopt(seed);
  posted.length = 0;
  return { host: h, posted };
}

const planned1: RunView = {
  tasks: [{ ...planned('t1', 1), subtasks: [] }],
  runMerge: null, handoff: null, mergeResult: null,
};

describe('RunViewHost', () => {
  it('folds a session event and posts the one run view', () => {
    const { host: h, posted } = host(planned1);

    h.receive({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, awaitingApproval: 2 }] });

    expect(posted).toHaveLength(1);
    expect(posted[0].tasks[0]).toMatchObject({ id: 't1', status: 'in_progress', awaitingApproval: 2 });
  });

  it('posts nothing for an event that leaves the run alone', () => {
    const { host: h, posted } = host(planned1);

    h.receive({ type: 'planner_liveness' });

    expect(posted).toEqual([]);
  });

  it('adopts a whole view for a client that joins mid-run, and resets to the empty run', () => {
    const { host: h, posted } = host();
    const view: RunView = { ...planned1, usage: { attempts: 1, totals: {}, byModel: [], wallTimeMs: 0 } };

    h.adopt(view);
    h.reset();

    expect(posted).toEqual([view, EMPTY_RUN]);
  });

  it('clears the isolation marks and the handoff and merge cards', () => {
    const seed: RunView = {
      ...planned1,
      tasks: [{ ...planned('t1', 1), isolation: { state: 'conflict', branch: 'b', worktree: 'w', repos: [] }, subtasks: [] }],
      handoff: { repos: [], landed: [] },
      mergeResult: { outcome: 'blocked', blocked: [] },
      runMerge: { waitingAtGate: false, paused: false, repos: [], landed: [] },
    };
    const { host: h, posted } = host(seed);

    h.clearIsolation();

    expect(posted).toHaveLength(1);
    expect(posted[0].tasks[0].isolation).toBeUndefined();
    expect(posted[0].handoff).toBeNull();
    expect(posted[0].mergeResult).toBeNull();
    expect(posted[0].runMerge).toBeNull();
  });
});
