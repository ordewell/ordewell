import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';
import App from '../../test/ChatApp';

import { hostApi as api } from '../../test/hostApi';

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
  waitingAtGate: true,
  paused: true,
  repos: [{ path: '.', integrationBranch: 'ordewell/run-1/integration', baseRef: 'abcdef0123456789', landed }],
  landed,
};

describe('App — ops tasks and merge gates (ADR-0020)', () => {
  beforeEach(() => {
    api.post.mockClear();
    render(<App />);
  });

  it('marks an ops task', () => {
    send({ type: 'planUpdated', plan });
    expect(screen.getByText('Ops')).toBeTruthy();
  });

  it('marks a task that waits at its merge gate, and offers Merge all mid-run without the end-of-run actions', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'runView', view: { tasks: [{ id: 'o2', subtasks: [], mergeGate: ['t1'] }], runMerge: gate, handoff: null, mergeResult: null } });

    expect(screen.getByText('Waits for Merge all')).toBeTruthy();
    expect(screen.getByText(/Paused for Merge all/)).toBeTruthy();
    expect(screen.queryByText('Discard')).toBeNull();
    fireEvent.click(document.querySelector('.isolation-handoff .task-action-btn.run')!);
    expect(api.post).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });

    send({ type: 'runView', view: { tasks: [], runMerge: null, handoff: null, mergeResult: null } });
    expect(screen.queryByText('Waits for Merge all')).toBeNull();
    expect(document.querySelector('.isolation-handoff')).toBeNull();
  });

  it('offers Merge all quietly mid-run without a gate, and removes it after merging', () => {
    send({ type: 'planUpdated', plan: { ...plan, status: 'running' } });
    send({ type: 'runView', view: { tasks: [], runMerge: { ...gate, waitingAtGate: false, paused: false }, handoff: null, mergeResult: null } });

    expect(screen.getByText('1 landed task not merged')).toBeTruthy();
    expect(screen.getByText('1 unmerged')).toBeTruthy();
    expect(screen.queryByText('Waits for Merge all')).toBeNull();
    expect(document.querySelector('.isolation-handoff')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Merge all' }));
    expect(api.post).toHaveBeenCalledWith({ type: 'isolationAction', action: 'merge', taskId: undefined });

    send({ type: 'runView', view: { tasks: [], runMerge: null, handoff: null, mergeResult: null } });
    expect(screen.queryByRole('button', { name: 'Merge all' })).toBeNull();
    expect(screen.queryByText('1 unmerged')).toBeNull();
    expect(document.querySelector('.isolation-handoff')).toBeNull();
  });

  it('flips a pending task between change and ops from its card', () => {
    send({ type: 'planUpdated', plan });
    fireEvent.click(screen.getByText('Redeploy on dev'));

    fireEvent.click(screen.getByLabelText(/Ops task: runs in your checkout/));

    expect(api.post).toHaveBeenCalledWith({ type: 'editTask', taskId: 'o2', edit: { kind: 'ops', ops: false } });
  });
});
