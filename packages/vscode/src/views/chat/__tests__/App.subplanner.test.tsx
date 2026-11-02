import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildPlanEntry, ChildPlanView } from '@ordewell/core';
import App from '../App';
import { api, post } from './hostBridge';

const noRun = { tasks: [], runMerge: null, handoff: null, mergeResult: null };

function entry(overrides: Partial<ChildPlanEntry> = {}): ChildPlanEntry {
  return { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked', ...overrides };
}

function asking(child: ChildPlanEntry, question = 'Which rounding?', type: 'structured' | 'delegated' = 'structured'): ChildPlanView {
  return {
    child,
    plan: { tasks: [{ id: 'n', order: 1, title: 'Nested', type, status: 'awaiting_user', description: '', dependencies: [], subtasks: [] }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] },
    run: { ...noRun, tasks: [{ id: 'n', title: 'Nested', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: question, subtasks: [] }] },
  } as unknown as ChildPlanView;
}

const sent = (type: string) => api.postMessage.mock.calls.map(([message]) => message as { type: string }).filter((message) => message.type === type);

describe('subplanner navigation', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('makes an ended child view only', () => {
    render(<App />);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', title: 'Delegate', depth: 1, state: 'ended' as const };
    post({ type: 'childView', view: { child, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } });
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.queryByLabelText('Message subplanner')).toBeNull();
  });
  it('shows a question waiting inside the child plan', () => {
    render(<App />);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', title: 'Delegate', depth: 1, state: 'parked' as const };
    post({ type: 'childView', view: { child, plan: { tasks: [{ id: 'n', order: 1, title: 'Nested', type: 'delegated', status: 'awaiting_user', description: '', dependencies: [], subtasks: [] }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] } as never, run: { tasks: [{ id: 'n', title: 'Nested', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Which rounding?', subtasks: [] }], runMerge: null, handoff: null, mergeResult: null } } as never });
    expect(screen.getByText('Which rounding?')).toBeTruthy();
  });
  it('keeps a refused message in the composer', () => {
    render(<App />);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', title: 'Delegate', depth: 1, state: 'parked' as const };
    post({ type: 'childView', view: { child, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } });
    fireEvent.change(screen.getByLabelText('Message subplanner'), { target: { value: 'Keep these words' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    post({ type: 'childMessageResult', childId: 'child', error: 'Budget exhausted' });
    expect(screen.getByLabelText('Message subplanner')).toHaveValue('Keep these words');
    expect(screen.getByRole('status')).toHaveTextContent('Budget exhausted');
  });
  it('keeps an unanswered checkpoint visible while reading a child', () => {
    render(<App />);
    post({ type: 'runView', view: { tasks: [{ id: 'd', title: 'Delegate', type: 'delegated', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Which rounding?', subtasks: [] }], runMerge: null, handoff: null, mergeResult: null } } as never);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' as const };
    post({ type: 'children', rootId: 'root', children: [child] });
    post({ type: 'childView', view: { child, plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } });
    expect(screen.getByRole('button', { name: /question awaits/ })).toBeTruthy();
  });
  it('sends a message to the selected child and offers its nested child and runner chat', () => {
    render(<App />);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'working' as const };
    const nested = { sessionId: 'nested', parent: 'child', node: '0/1/1', taskId: 'n', title: 'Nested', depth: 2, state: 'parked' as const };
    post({ type: 'children', rootId: 'root', children: [child, nested] });
    post({ type: 'childView', view: { child, plan: { tasks: [{ id: 'n', order: 1, title: 'Nested', type: 'delegated', status: 'in_progress', description: '', dependencies: [], subtasks: [], attempted: true }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] } as never, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } });
    fireEvent.change(screen.getByLabelText('Message subplanner'), { target: { value: 'Please check it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'messageChild', childId: 'child', text: 'Please check it' });
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openChildTaskLog', childId: 'child', taskId: 'n' });
    fireEvent.click(screen.getByRole('button', { name: /Open subplanner: Nested/ }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openChild', childId: 'nested' });
  });
  it('opens a delegated child by session identity and returns to its parent', () => {
    render(<App />);
    post({ type: 'setRunSettings', autonomous: false, run: {}, maxParallel: 1, delegationOffered: true } as never);
    post({ type: 'planUpdated', plan: { tasks: [{ id: 'd', order: 1, title: 'Delegate', description: '', type: 'delegated', status: 'in_progress', dependencies: [], subtasks: [], goal: 'Child goal', budget: { tokens: 1000 } }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] } } as never);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' as const };
    post({ type: 'children', rootId: 'root', children: [child] });
    fireEvent.click(screen.getByRole('button', { name: 'Open subplanner' }));
    fireEvent.click(screen.getByRole('button', { name: /Delegate.*parked/ }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openChild', childId: 'child' });
    post({ type: 'childView', view: { child, goal: 'Child goal', plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } });
    expect(screen.getByText('Child goal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'closeChild' });
  });

  describe('a question in a child plan', () => {
    it('is answered on the child that holds it, never on the root', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry()) });
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'approve' });
      expect(sent('checkpointApprove')).toEqual([]);
      expect(sent('checkpointReject')).toEqual([]);
    });
    it('needs a reason to reject, and sends it', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry()) });
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      expect(screen.getByRole('button', { name: 'Send Rejection' })).toBeDisabled();
      fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Use floor.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'reject', reason: 'Use floor.' });
    });
    it('carries the words of an answer to a nested subplanner, and offers no raise', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
      expect(screen.queryByLabelText(/Raise its budget/)).toBeNull();
      fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'approve', reason: 'Floor.' });
    });
    it('holds a second answer until the first comes back, and keeps the words through a refusal', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
      fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
      post({ type: 'childControlResult', childId: 'child', taskId: 'n', error: 'The budget is spent.' });
      expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();
      expect(screen.getByLabelText('Your answer')).toHaveValue('Floor.');
      expect(screen.getByRole('status')).toHaveTextContent('The budget is spent.');
    });
    it('does not carry an answer over to the question that replaces it', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
      fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
      post({ type: 'childView', view: asking(entry(), 'Which currency?', 'delegated') });
      expect(screen.getByText('Which currency?')).toBeTruthy();
      expect(screen.getByLabelText('Your answer')).toHaveValue('');
    });
    it.each([
      ['an ended child', entry({ state: 'ended' }), 'View only'],
      ['a refused child', entry({ refused: 'The budget is spent.' }), 'The budget is spent.'],
    ])('reads, without an answer, on %s', (_name, child, why) => {
      render(<App />);
      post({ type: 'childView', view: asking(child) });
      expect(screen.getByText('Which rounding?')).toBeTruthy();
      expect(screen.getByText(why)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
      expect(screen.queryByLabelText('Message subplanner')).toBeNull();
    });
    it('is found from the root, wherever in the tree it sits', () => {
      render(<App />);
      post({ type: 'children', rootId: 'root', children: [entry(), entry({ sessionId: 'nested', parent: 'child', node: '0/1/1', taskId: 'n', title: 'Nested', depth: 2, checkpoints: ['r'] })] });
      const questions = screen.getByRole('region', { name: 'Questions in subplanners' });
      fireEvent.click(within(questions).getByRole('button', { name: /Nested/ }));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'openChild', childId: 'nested' });
    });
    it('is found from another child, and not offered again on the one that holds it', () => {
      render(<App />);
      const child = entry({ checkpoints: ['n'] });
      const other = entry({ sessionId: 'other', node: '0/2', taskId: 'e', title: 'Other', checkpoints: ['t'] });
      post({ type: 'children', rootId: 'root', children: [child, other] });
      post({ type: 'childView', view: asking(child) });
      const questions = screen.getByRole('region', { name: 'Questions in subplanners' });
      expect(within(questions).queryByRole('button', { name: /Delegate/ })).toBeNull();
      expect(within(questions).getByRole('button', { name: /Other/ })).toBeTruthy();
    });
  });

  describe('moving through nested plans', () => {
    it('goes back one level from a nested child, however it was reached', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry({ sessionId: 'deep', parent: 'nested', depth: 3 }), plan: null, run: noRun } });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'openChild', childId: 'nested' });
      expect(sent('closeChild')).toEqual([]);
    });
    it('goes back to the root from a first-level child, with no tree told yet', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'closeChild' });
      expect(sent('openChild')).toEqual([]);
      expect(screen.queryByRole('button', { name: 'Back to parent' })).toBeNull();
    });
    it('is a labelled landmark that moves focus to the plan it opened', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      expect(within(screen.getByRole('navigation', { name: 'Subplanner navigation' })).getByRole('button', { name: 'Back to parent' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Delegate' })).toHaveFocus();
      post({ type: 'childView', view: { child: entry({ sessionId: 'nested', parent: 'child', title: 'Nested', depth: 2 }), plan: null, run: noRun } });
      expect(screen.getByRole('heading', { name: 'Nested' })).toHaveFocus();
    });
    it('gives focus back to what opened the child', () => {
      render(<App />);
      post({ type: 'children', rootId: 'root', children: [entry({ checkpoints: ['n'] })] });
      const opener = screen.getByRole('button', { name: /Delegate/ });
      opener.focus();
      fireEvent.click(opener);
      post({ type: 'childView', view: asking(entry()) });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      expect(screen.getByRole('button', { name: /Delegate/ })).toHaveFocus();
    });
    it('keeps what the person was writing at the root', () => {
      render(<App />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'A half-written prompt' } });
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      expect(screen.getByRole('textbox')).toHaveValue('A half-written prompt');
    });
    it('does not fall back into a child the person just left', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      post({ type: 'childView', view: { child: entry({ state: 'working' }), plan: null, run: noRun } });
      expect(screen.queryByRole('button', { name: 'Back to parent' })).toBeNull();
    });
    it('lists a retried task\'s children by identity, the ended one too', () => {
      render(<App />);
      const parent = entry();
      const ended = entry({ sessionId: 'first', parent: 'child', taskId: 'n', title: 'Nested', depth: 2, state: 'ended' });
      const fresh = entry({ sessionId: 'second', parent: 'child', taskId: 'n', title: 'Nested', depth: 2, state: 'working' });
      post({ type: 'children', rootId: 'root', children: [parent, ended, fresh] });
      post({ type: 'childView', view: asking(parent, 'Which?', 'delegated') });
      fireEvent.click(screen.getByRole('button', { name: /Nested · ended/ }));
      expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'openChild', childId: 'first' });
      fireEvent.click(screen.getByRole('button', { name: /Nested · working/ }));
      expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'openChild', childId: 'second' });
    });
    it('says when a nested delegated task has no child plan yet', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which?', 'delegated') });
      fireEvent.click(screen.getByRole('button', { name: 'Open subplanner' }));
      expect(screen.getByText('No child plan has started.')).toBeTruthy();
    });
    it('shows why a child could not be opened, at the root', () => {
      render(<App />);
      post({ type: 'childClosed' });
      post({ type: 'childNotice', childId: 'child', message: 'Child plan not found.' });
      expect(screen.getByRole('status')).toHaveTextContent('Child plan not found.');
    });
    it('clears its message box when a message lands, and drops the words of no other child', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      fireEvent.change(screen.getByLabelText('Message subplanner'), { target: { value: 'Carry on' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      post({ type: 'childMessageResult', childId: 'other', status: 'woken' });
      expect(screen.getByLabelText('Message subplanner')).toHaveValue('Carry on');
      post({ type: 'childMessageResult', childId: 'child', status: 'queued' });
      expect(screen.getByLabelText('Message subplanner')).toHaveValue('');
      expect(screen.getByRole('status')).toHaveTextContent('Message queued.');
    });
  });
});
