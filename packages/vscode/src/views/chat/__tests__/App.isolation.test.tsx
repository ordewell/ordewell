import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';
import App from '../App';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const plan = {
  tasks: [{
    id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
    status: 'awaiting_user' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
    completionMarker: 'm1', taskMode: 'build',
  }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

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
    api.postMessage.mockClear();
    render(<App />);
  });

  it('shows the conflict indicator from a taskIsolation message', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'taskIsolation', taskId: 't1', isolation: { state: 'conflict', branch: 'ordewell/run-1/1-a', worktree: '.ordewell/worktrees/run-1/1-a' } });

    expect(screen.getByText('Conflict')).toBeTruthy();
  });

  it('shows the handoff card and posts the chosen action to the host', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'isolationHandoff', ...handoff });

    expect(screen.getByText('ordewell/run-1/integration')).toBeTruthy();
    fireEvent.click(screen.getByText('Merge'));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });
  });

  it('clears the handoff card when the run is discarded', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'isolationHandoff', ...handoff });
    expect(document.querySelector('.isolation-handoff')).toBeTruthy();

    send({ type: 'isolationCleared' });
    expect(document.querySelector('.isolation-handoff')).toBeNull();
    expect(document.querySelector('.task-isolation-badge')).toBeNull();
  });

  it('offers Merge all for a repo group and posts it to the host', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'isolationHandoff', ...groupHandoff });

    fireEvent.click(screen.getByText('Merge all'));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });
  });

  it('shows a blocked Merge all result naming each repo, and clears it with the run', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'isolationHandoff', ...groupHandoff });
    send({
      type: 'isolationMergeResult',
      result: { outcome: 'blocked', blocked: [{ repo: 'api', reason: 'conflict', files: ['src/a.ts'] }] },
    });

    const block = document.querySelector('.isolation-merge-block');
    expect(block?.textContent).toContain('api');
    expect(block?.textContent).toContain('src/a.ts');

    send({ type: 'isolationCleared' });
    expect(document.querySelector('.isolation-merge-result')).toBeNull();
  });
});
