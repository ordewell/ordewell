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

const task = (over: Record<string, unknown>) => ({
  description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [],
  assignedRunner: 'claude-code', taskMode: 'build', ...over,
});

const plan = {
  tasks: [
    task({ id: 't1', order: 1, title: 'Bump the version', status: 'completed' }),
    task({ id: 'o2', order: 2, title: 'Redeploy on dev', dependencies: ['t1'], ops: true, prompt: 'push and watch' }),
  ],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

const landed = [{ taskId: 't1', order: 1, title: 'Bump the version' }];
const gate = {
  paused: true,
  repos: [{ path: '.', integrationBranch: 'ordewell/run-1/integration', baseRef: 'abcdef0123456789', landed }],
  landed,
};

describe('App — ops tasks and merge gates (ADR-0020)', () => {
  beforeEach(() => {
    api.postMessage.mockClear();
    render(<App />);
  });

  it('marks an ops task', () => {
    send({ type: 'planUpdated', plan });
    expect(screen.getByText('Ops')).toBeTruthy();
  });

  it('marks a task that waits at its merge gate, and offers Merge all mid-run without the end-of-run actions', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'mergeGate', gate, tasks: { o2: ['t1'] } });

    expect(screen.getByText('Waits for Merge all')).toBeTruthy();
    expect(screen.getByText(/Paused for Merge all/)).toBeTruthy();
    expect(screen.queryByText('Discard')).toBeNull();
    fireEvent.click(document.querySelector('.isolation-handoff .task-action-btn.run')!);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });

    send({ type: 'mergeGate', gate: null, tasks: {} });
    expect(screen.queryByText('Waits for Merge all')).toBeNull();
    expect(document.querySelector('.isolation-handoff')).toBeNull();
  });

  it('flips a pending task between change and ops from its card', () => {
    send({ type: 'planUpdated', plan });
    fireEvent.click(screen.getByText('Redeploy on dev'));

    fireEvent.click(screen.getByLabelText(/Ops task — runs in your checkout/));

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'editTask', taskId: 'o2', edit: { kind: 'ops', ops: false } });
  });
});
