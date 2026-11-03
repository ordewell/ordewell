import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import App from '../App';
import { api, hostBridge, post } from './hostBridge';
import type { HostToWebview } from '@ordewell/ui/protocol';
import type { RunView } from '@ordewell/core';

/**
 * Execute is asynchronous: the host opens a run before any task claims. The
 * button must say so at once, take no second start, and give way to the run's
 * own Stop as soon as execution state arrives.
 */

const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

const activity = (over: Partial<Record<'starting' | 'running' | 'scheduled' | 'resumable' | 'advancesOnItsOwn', boolean>> = {}) => ({
  starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false, ...over,
});

const show = (msg: HostToWebview) => act(() => { post(msg); });

const startingButton = () => document.querySelector('.plan-action-btn.starting');
const executeButton = () => document.querySelector('.plan-action-btn.execute');

function lastStartRequest(): number | undefined {
  const sent = api.postMessage.mock.calls
    .map(([msg]) => msg as { type: string; command?: string; requestId?: number })
    .filter((msg) => msg.type === 'sendSystemCommand' && msg.command === 'executePlan');
  return sent.at(-1)?.requestId;
}

describe('a whole-plan start', () => {
  beforeEach(() => {
    render(<App />);
    hostBridge();
    show({ type: 'planUpdated', plan });
    api.postMessage.mockClear();
  });
  afterEach(() => api.postMessage.mockClear());

  it('shows Starting… before the host answers, and sends one request', () => {
    fireEvent.click(screen.getByText('Execute Plan'));

    expect(startingButton()).not.toBeNull();
    expect(executeButton()).toBeNull();
    expect(startingButton()?.hasAttribute('disabled')).toBe(true);
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'executePlan' }));
  });

  it('takes a rapid second click as the same start', () => {
    const button = screen.getByText('Execute Plan');
    fireEvent.click(button);
    fireEvent.click(button);

    const starts = api.postMessage.mock.calls.filter(([msg]) => (msg as { command?: string }).command === 'executePlan');
    expect(starts).toHaveLength(1);
  });

  it('keeps Approve all off while starting, and still joins a run with it once executing', () => {
    const waiting = { ...plan.tasks[0], waitsForApproval: true };
    const running = { ...plan, status: 'running' as const, tasks: [{ ...plan.tasks[0], status: 'in_progress' as const }] };

    // The click's own start is in flight: there is nothing for Approve all to
    // join yet, and a second whole-plan start must not be offered.
    fireEvent.click(screen.getByText('Execute Plan'));
    expect(screen.queryByText('Approve all')).toBeNull();

    show({ type: 'planUpdated', plan: running });
    show({
      type: 'runView',
      view: { tasks: [waiting], runMerge: null, handoff: null, mergeResult: null, activity: activity({ running: true, scheduled: true }) } as unknown as RunView,
    });

    expect(screen.queryByText('Approve all')).toBeTruthy();
    fireEvent.click(screen.getByText('Approve all'));

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'executePlan' }));
  });

  it('holds Mark back as soon as the status says running, before the run activity lands', () => {
    show({ type: 'planUpdated', plan: { ...plan, status: 'running' as const } });
    fireEvent.click(screen.getByText('Only task'));

    const button = screen.getByText('Mark complete') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Stop the run first/)).toBeTruthy();
  });

  it('becomes the run\'s Stop when execution state arrives', () => {
    fireEvent.click(screen.getByText('Execute Plan'));

    show({ type: 'planUpdated', plan: { ...plan, status: 'running', tasks: [{ ...plan.tasks[0], status: 'in_progress' }] } });
    show({ type: 'runView', view: { tasks: [], runMerge: null, handoff: null, mergeResult: null, activity: activity({ running: true, scheduled: true }) } });

    expect(startingButton()).toBeNull();
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('returns to Execute Plan when the host refuses the start', () => {
    fireEvent.click(screen.getByText('Execute Plan'));
    const requestId = lastStartRequest();

    show({ type: 'runActivity', activity: activity(), requestId });

    expect(startingButton()).toBeNull();
    expect(screen.getByText('Execute Plan')).toBeTruthy();
  });

  it('settles an immediate finish instead of leaving the spinner up', () => {
    fireEvent.click(screen.getByText('Execute Plan'));
    const requestId = lastStartRequest();

    // The Seam answered after a run that had already finished: its one answer
    // is idle, and the spinner must go with it.
    show({ type: 'runActivity', activity: activity(), requestId });

    expect(startingButton()).toBeNull();
    expect(screen.getByText('Execute Plan')).toBeTruthy();
  });

  it('drops a late start answer from a session the chat has left', () => {
    fireEvent.click(screen.getByText('Execute Plan'));
    const requestId = lastStartRequest();

    show({ type: 'restoreChat' });
    show({ type: 'planUpdated', plan });
    show({ type: 'runActivity', activity: activity({ starting: true, scheduled: true }), requestId });

    expect(startingButton()).toBeNull();
    expect(screen.getByText('Execute Plan')).toBeTruthy();
  });

  it('still stops a run whose start has just become execution', () => {
    fireEvent.click(screen.getByText('Execute Plan'));
    show({ type: 'planUpdated', plan: { ...plan, status: 'running', tasks: [{ ...plan.tasks[0], status: 'in_progress' }] } });

    fireEvent.click(screen.getByText('Stop'));

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendSystemCommand', command: 'stopExecution' });
  });
});
