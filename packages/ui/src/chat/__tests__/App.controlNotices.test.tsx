import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from '../../test/ChatApp';

import { hostApi as api } from '../../test/hostApi';

function send(msg: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

const now = new Date().toISOString();
const task = (status: 'pending' | 'in_progress' | 'failed') => ({
  id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const,
  status, dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
});
const planOf = (status: 'draft' | 'running', taskStatus: 'pending' | 'in_progress' | 'failed') => ({
  tasks: [task(taskStatus)], generatedAt: now, status, runners: ['claude-code'], lastUpdated: now,
});

const notes = () => api.post.mock.calls.filter(([msg]) => (msg as { type: string }).type === 'addNote');

// The session records each of these controls at the command seam and the
// timeline says what came of it, a refusal included: a note the webview wrote
// before asking could only contradict that line.
describe('a control that goes through the command seam leaves its notice to the timeline', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('a card\'s Cancel asks and writes no note of its own', () => {
    send({ type: 'planUpdated', plan: planOf('running', 'in_progress') });
    act(() => { fireEvent.click(screen.getByText('Only task')); });
    api.post.mockClear();

    act(() => { fireEvent.click(screen.getAllByText('Cancel')[0]); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'cancel', taskId: 't1' }));
    expect(notes()).toEqual([]);
  });

  it('Mark complete, at the bottom of the card\'s details, asks the host and writes no note of its own', () => {
    send({ type: 'planUpdated', plan: planOf('draft', 'pending') });
    act(() => { fireEvent.click(screen.getByText('Only task')); });
    api.post.mockClear();

    act(() => { fireEvent.click(screen.getByText('Mark complete')); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'markComplete', taskId: 't1' }));
    expect(notes()).toEqual([]);
  });

  it('the card\'s check is a status, and asks for nothing', () => {
    send({ type: 'planUpdated', plan: planOf('draft', 'pending') });
    api.post.mockClear();

    act(() => { fireEvent.click(document.querySelector('.task-check')!); });

    expect(api.post).not.toHaveBeenCalled();
  });

  it('Skip asks and writes no note of its own', () => {
    send({ type: 'planUpdated', plan: planOf('running', 'failed') });
    act(() => { fireEvent.click(screen.getByText('Only task')); });
    api.post.mockClear();

    act(() => { fireEvent.click(screen.getAllByText('Skip')[0]); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'skip', taskId: 't1' }));
    expect(notes()).toEqual([]);
  });

  it('Don\'t Resume asks and writes no note of its own', () => {
    const paused = { ...task('in_progress'), status: 'awaiting_user' as const, awaitingReason: 'usage-limit', resumeAt: new Date(Date.now() + 60 * 60_000).toISOString() };
    send({ type: 'planUpdated', plan: { ...planOf('running', 'in_progress'), tasks: [paused] } });
    act(() => { fireEvent.click(screen.getByText('Only task')); });
    api.post.mockClear();

    act(() => { fireEvent.click(screen.getAllByText('Don\'t Resume')[0]); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'cancelResume', taskId: 't1' }));
    expect(notes()).toEqual([]);
  });

  it('Execute Plan asks and writes no note of its own', () => {
    send({ type: 'planUpdated', plan: planOf('draft', 'pending') });
    api.post.mockClear();

    act(() => { fireEvent.click(screen.getByText('Execute Plan')); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'executePlan' }));
    expect(notes()).toEqual([]);
  });

  it('Stop asks and writes no "Execution stopped." of its own', () => {
    send({ type: 'planUpdated', plan: planOf('running', 'in_progress') });
    api.post.mockClear();

    act(() => { fireEvent.click(screen.getByText('Stop')); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'stopExecution' }));
    expect(notes()).toEqual([]);
  });
});
