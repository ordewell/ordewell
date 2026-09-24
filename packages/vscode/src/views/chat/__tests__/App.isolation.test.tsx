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

const handoff = {
  branch: 'ordewell/run-1/integration',
  baseRef: 'abcdef0123456789',
  landed: [{ taskId: 't1', order: 1, title: 'Add rate limiting' }],
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
});
