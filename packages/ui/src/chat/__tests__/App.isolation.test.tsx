import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';
import { EMPTY_RUN, type RunTask, type RunView } from '@ordewell/core';
import App from '../../test/ChatApp';

import { hostApi as api } from '../../test/hostApi';

function send(msg: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const plan = {
  tasks: [{
    id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
    status: 'awaiting_user' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
    taskMode: 'build',
  }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

/** A run view as the host would fold it: only the fields the cards read need be real. */
function run(over: Partial<RunView>, tasks: Partial<RunTask>[] = []): RunView {
  return { ...EMPTY_RUN, ...over, tasks: tasks.map((t) => ({ id: 't1', subtasks: [], ...t })) as RunTask[] };
}
const sendRun = (view: RunView) => send({ type: 'runView', view });

const landed = [{ taskId: 't1', order: 1, title: 'Add rate limiting' }];
const handoff = {
  repos: [{ path: '.', integrationBranch: 'ordewell/run-1/integration', baseRef: 'abcdef0123456789', landed }],
  landed,
};
const groupHandoff = {
  repos: [
    { path: 'api', integrationBranch: 'ordewell/run-1/integration', baseRef: 'aaaa11112222', landed },
    { path: 'web', integrationBranch: 'ordewell/run-1/integration', baseRef: 'bbbb33334444', landed: [] },
  ],
  landed,
};

describe('App — worktree isolation (ADR-0013)', () => {
  beforeEach(() => {
    api.post.mockClear();
    render(<App />);
  });

  it('shows the conflict indicator from the run view', () => {
    send({ type: 'planUpdated', plan });
    sendRun(run({}, [{ isolation: { state: 'conflict', branch: 'ordewell/run-1/1-a', worktree: '.ordewell/worktrees/run-1/1-a', repos: [] } }]));

    expect(screen.getByText('Conflict')).toBeTruthy();
  });

  it('shows the handoff card and posts the chosen action to the host', () => {
    send({ type: 'planUpdated', plan });
    sendRun(run({ handoff }));

    expect(screen.getByText('ordewell/run-1/integration')).toBeTruthy();
    fireEvent.click(screen.getByText('Merge'));
    expect(api.post).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });
  });

  it('clears the handoff card when the run is discarded', () => {
    send({ type: 'planUpdated', plan });
    sendRun(run({ handoff }));
    expect(document.querySelector('.isolation-handoff')).toBeTruthy();

    sendRun(run({}, [{ isolation: { state: 'conflict', branch: 'b', worktree: 'w' } }]));
    sendRun(EMPTY_RUN);
    expect(document.querySelector('.isolation-handoff')).toBeNull();
    expect(document.querySelector('.task-isolation-badge')).toBeNull();
  });

  it('shows a deferred handoff with its note, and drops the note when the unmarked handoff follows', () => {
    send({ type: 'planUpdated', plan });
    sendRun(run({ handoff: { ...handoff, deferredTo: 'supervisor' } }));
    expect(screen.getByText(/supervisor may merge this when it wakes/i)).toBeTruthy();

    sendRun(run({ handoff }));
    expect(screen.queryByText(/supervisor may merge this/i)).toBeNull();
    expect(document.querySelector('.isolation-handoff')).toBeTruthy();
  });

  it('offers Merge all for a repo group and posts it to the host', () => {
    send({ type: 'planUpdated', plan });
    sendRun(run({ handoff: groupHandoff }));

    fireEvent.click(screen.getByText('Merge all'));
    expect(api.post).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });
  });

  it('shows a blocked Merge all result naming each repo, and clears it with the run', () => {
    send({ type: 'planUpdated', plan });
    sendRun(run({ handoff: groupHandoff }));
    sendRun(run({
      handoff: groupHandoff,
      mergeResult: { outcome: 'blocked', blocked: [{ repo: 'api', reason: 'conflict', files: ['src/a.ts'] }] },
    }));

    const block = document.querySelector('.isolation-merge-result');
    expect(block?.textContent).toBe('Merged nothing, so every tree is as it was: api would conflict in src/a.ts. Each repository\'s ordewell/run-1/integration is a plain branch you can merge by hand.');

    sendRun(EMPTY_RUN);
    expect(document.querySelector('.isolation-merge-result')).toBeNull();
  });
});
