import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildPlanEntry, ChildPlanView } from '@ordewell/core';
import App from '../../test/ChatApp';
import { api, lastAnswerId, post } from './webview';

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

const sent = (type: string) => api.post.mock.calls.map(([message]) => message as { type: string }).filter((message) => message.type === type);

describe('subplanner navigation', () => {
  beforeEach(() => { api.post.mockClear(); });

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
    expect(api.post).toHaveBeenCalledWith({ type: 'messageChild', childId: 'child', text: 'Please check it' });
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(api.post).toHaveBeenCalledWith({ type: 'openChildTaskLog', childId: 'child', taskId: 'n' });
    fireEvent.click(screen.getByRole('button', { name: /Open subplanner: Nested/ }));
    expect(api.post).toHaveBeenCalledWith({ type: 'openChild', childId: 'nested' });
  });
  it('opens a delegated child by session identity and returns to its parent', () => {
    render(<App />);
    post({ type: 'setRunSettings', autonomous: false, run: {}, maxParallel: 1, delegationOffered: true } as never);
    post({ type: 'planUpdated', plan: { tasks: [{ id: 'd', order: 1, title: 'Delegate', description: '', type: 'delegated', status: 'in_progress', dependencies: [], subtasks: [], goal: 'Child goal', budget: { tokens: 1000 } }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] } } as never);
    const child = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' as const };
    post({ type: 'children', rootId: 'root', children: [child] });
    fireEvent.click(screen.getByRole('button', { name: 'Open subplanner' }));
    fireEvent.click(screen.getByRole('button', { name: /Delegate.*parked/ }));
    expect(api.post).toHaveBeenCalledWith({ type: 'openChild', childId: 'child' });
    post({ type: 'childView', view: { child, goal: 'Child goal', plan: null, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } });
    expect(screen.getByText('Child goal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
    expect(api.post).toHaveBeenCalledWith({ type: 'closeChild' });
  });

  describe('a question in a child plan', () => {
    it('is answered on the child that holds it, never on the root', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry()) });
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(api.post).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', answerId: expect.any(String), childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'approve' });
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
      expect(api.post).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', answerId: expect.any(String), childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'reject', reason: 'Use floor.' });
    });
    it('carries the words of an answer to a nested subplanner, and offers no raise', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
      expect(screen.queryByLabelText(/Raise its budget/)).toBeNull();
      fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(api.post).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', answerId: expect.any(String), childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'approve', reason: 'Floor.' });
    });
    it('holds a second answer until the first comes back, and keeps the words through a refusal', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
      fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
      post({ type: 'checkpointResult', answerId: lastAnswerId(), error: 'The budget is spent.' });
      expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();
      expect(screen.getByLabelText('Your answer')).toHaveValue('Floor.');
      expect(screen.getByRole('status')).toHaveTextContent('The budget is spent.');
    });
    describe('when the person leaves before the result', () => {
      const nested = entry({ sessionId: 'nested', parent: 'child', title: 'Nested plan', depth: 2 });
      const answerThenLeave = () => {
        render(<App />);
        post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
        fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
        fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
        post({ type: 'childView', view: { ...asking(nested), plan: null, run: noRun } as ChildPlanView });
      };
      const refused = (error = 'The child plan is no longer open.') => post({ type: 'checkpointResult', answerId: lastAnswerId(), error });

      it('tells of a refusal by name, and hands back the words on return', () => {
        answerThenLeave();
        refused();
        expect(screen.getByRole('status')).toHaveTextContent('Not answered in Delegate: The child plan is no longer open.');
        post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
        expect(screen.getByLabelText('Your answer')).toHaveValue('Floor.');
        expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();
      });
      it('tells of a refusal at the root, when the person went there', () => {
        render(<App />);
        post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
        fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
        refused();
        expect(screen.getByRole('status')).toHaveTextContent('Not answered in Delegate');
      });
      it('holds the question shut for a person back while the answer is still out', () => {
        answerThenLeave();
        post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
        expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
        expect(screen.getByLabelText('Your answer')).toHaveValue('Floor.');
        refused('The budget is spent.');
        expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();
        expect(screen.getByLabelText('Your answer')).toHaveValue('Floor.');
      });
      it('reopens a refused rejection with its reason', () => {
        render(<App />);
        post({ type: 'childView', view: asking(entry()) });
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
        fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Use floor.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
        post({ type: 'childView', view: { ...asking(nested), plan: null, run: noRun } as ChildPlanView });
        refused();
        post({ type: 'childView', view: asking(entry()) });
        expect(screen.getByPlaceholderText(/Why are you rejecting/)).toHaveValue('Use floor.');
      });
      it('keeps nothing of an answer that landed', () => {
        answerThenLeave();
        post({ type: 'checkpointResult', answerId: lastAnswerId() });
        expect(screen.queryByRole('status')).toBeNull();
        post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
        expect(screen.getByLabelText('Your answer')).toHaveValue('');
        expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();
      });
      it('does not hand a refused answer to the question that replaced it', () => {
        answerThenLeave();
        refused();
        post({ type: 'childView', view: asking(entry(), 'Which currency?', 'delegated') });
        expect(screen.getByLabelText('Your answer')).toHaveValue('');
      });
    });
    it('does not carry an answer over to the question that replaces it', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry(), 'Which rounding?', 'delegated') });
      fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor.' } });
      post({ type: 'childView', view: asking(entry(), 'Which currency?', 'delegated') });
      expect(screen.getByText('Which currency?')).toBeTruthy();
      expect(screen.getByLabelText('Your answer')).toHaveValue('');
    });
    it('reads, without an answer, on an ended child', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry({ state: 'ended', refused: 'The budget is spent.' })) });
      expect(screen.getByText('Which rounding?')).toBeTruthy();
      expect(screen.getByText('View only')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
      expect(screen.queryByLabelText('Message subplanner')).toBeNull();
    });
    it('takes an answer on a child that refuses a message, as an answer opens no turn', () => {
      render(<App />);
      post({ type: 'childView', view: asking(entry({ refused: 'The budget is spent.' })) });
      expect(screen.getByText('The budget is spent.')).toBeTruthy();
      expect(screen.queryByLabelText('Message subplanner')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
      expect(api.post).toHaveBeenCalledWith({ type: 'answerChildCheckpoint', answerId: expect.any(String), childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'approve' });
    });
    it('is found from the root, wherever in the tree it sits', () => {
      render(<App />);
      post({ type: 'children', rootId: 'root', children: [entry(), entry({ sessionId: 'nested', parent: 'child', node: '0/1/1', taskId: 'n', title: 'Nested', depth: 2, checkpoints: ['r'] })] });
      const questions = screen.getByRole('region', { name: 'Questions in subplanners' });
      fireEvent.click(within(questions).getByRole('button', { name: /Nested/ }));
      expect(api.post).toHaveBeenCalledWith({ type: 'openChild', childId: 'nested' });
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
      expect(api.post).toHaveBeenCalledWith({ type: 'openChild', childId: 'nested' });
      expect(sent('closeChild')).toEqual([]);
    });
    it('goes back to the root from a first-level child, with no tree told yet', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      expect(api.post).toHaveBeenCalledWith({ type: 'closeChild' });
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
    it('does not fall into a child still on its way when the person left', () => {
      render(<App />);
      const nested = entry({ sessionId: 'nested', parent: 'child', taskId: 'n', title: 'Nested', depth: 2 });
      post({ type: 'children', rootId: 'root', children: [entry(), nested] });
      post({ type: 'childView', view: asking(entry(), 'Which?', 'delegated') });
      fireEvent.click(screen.getByRole('button', { name: /Open subplanner: Nested/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      post({ type: 'childView', view: { child: nested, plan: null, run: noRun } });
      expect(screen.queryByRole('button', { name: 'Back to parent' })).toBeNull();
    });
    it('opens a child the person left, when they ask for it again', () => {
      render(<App />);
      post({ type: 'children', rootId: 'root', children: [entry({ checkpoints: ['n'] })] });
      post({ type: 'childView', view: asking(entry()) });
      fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
      fireEvent.click(screen.getByRole('button', { name: /A question waits in Delegate/ }));
      post({ type: 'childView', view: asking(entry()) });
      expect(screen.getByRole('button', { name: 'Back to parent' })).toBeTruthy();
    });
    it('lists a retried task\'s children by identity, the ended one too', () => {
      render(<App />);
      const parent = entry();
      const ended = entry({ sessionId: 'first', parent: 'child', taskId: 'n', title: 'Nested', depth: 2, state: 'ended' });
      const fresh = entry({ sessionId: 'second', parent: 'child', taskId: 'n', title: 'Nested', depth: 2, state: 'working' });
      post({ type: 'children', rootId: 'root', children: [parent, ended, fresh] });
      post({ type: 'childView', view: asking(parent, 'Which?', 'delegated') });
      fireEvent.click(screen.getByRole('button', { name: /Nested · ended/ }));
      expect(api.post).toHaveBeenLastCalledWith({ type: 'openChild', childId: 'first' });
      fireEvent.click(screen.getByRole('button', { name: /Nested · working/ }));
      expect(api.post).toHaveBeenLastCalledWith({ type: 'openChild', childId: 'second' });
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
    it('shows a child\'s notice in its own panel, never in another\'s', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      post({ type: 'childNotice', childId: 'nested', message: 'That tab could not open.' });
      expect(screen.queryByRole('status')).toBeNull();
      post({ type: 'childNotice', childId: 'child', message: 'That tab could not open.' });
      expect(screen.getByRole('status')).toHaveTextContent('That tab could not open.');
      post({ type: 'childView', view: { child: entry({ sessionId: 'nested', parent: 'child', title: 'Nested', depth: 2 }), plan: null, run: noRun } });
      expect(screen.queryByRole('status')).toBeNull();
    });
    it('shows a notice for no particular child wherever the person is', () => {
      render(<App />);
      post({ type: 'childView', view: { child: entry(), plan: null, run: noRun } });
      post({ type: 'childNotice', childId: '', message: 'Tree unavailable' });
      expect(screen.getByRole('status')).toHaveTextContent('Tree unavailable');
    });
    describe('words written to a child', () => {
      const nested = entry({ sessionId: 'nested', parent: 'child', taskId: 'n', title: 'Nested', depth: 2 });
      const show = (child: ChildPlanEntry) => post({ type: 'childView', view: { child, plan: null, run: noRun } });
      const write = (words: string) => fireEvent.change(screen.getByLabelText('Message subplanner'), { target: { value: words } });
      const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      const box = () => screen.getByLabelText('Message subplanner');

      it('stay across a nested child and back, and another child starts clean', () => {
        render(<App />);
        show(entry());
        write('Half a thought');
        show(nested);
        expect(box()).toHaveValue('');
        show(entry());
        expect(box()).toHaveValue('Half a thought');
      });
      it('are gone once they land, even with the person back from elsewhere', () => {
        render(<App />);
        show(entry());
        write('Carry on');
        send();
        show(nested);
        post({ type: 'childMessageResult', childId: 'child', status: 'woken' });
        expect(screen.queryByRole('status')).toBeNull();
        show(entry());
        expect(box()).toHaveValue('');
      });
      it('still hold Send when the person comes back before the result', () => {
        render(<App />);
        show(entry());
        write('Carry on');
        send();
        show(nested);
        show(entry());
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
        post({ type: 'childMessageResult', childId: 'child', status: 'queued' });
        expect(box()).toHaveValue('');
        expect(screen.getByRole('status')).toHaveTextContent('Message queued.');
      });
      it('stay, and the failure is told by name, when the person moved to another child', () => {
        render(<App />);
        show(entry());
        write('Carry on');
        send();
        show(nested);
        post({ type: 'childMessageResult', childId: 'child', error: 'The child plan is no longer open.' });
        expect(screen.getByRole('status')).toHaveTextContent('Not sent to Delegate: The child plan is no longer open.');
        show(entry());
        expect(box()).toHaveValue('Carry on');
        expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
      });
      it('are told of as failed in the panel the person lands in, when its view is still on its way', () => {
        render(<App />);
        post({ type: 'children', rootId: 'root', children: [entry(), nested] });
        post({ type: 'childView', view: asking(entry(), 'Which?', 'delegated') });
        write('Carry on');
        send();
        fireEvent.click(screen.getByRole('button', { name: /Open subplanner: Nested/ }));
        post({ type: 'childMessageResult', childId: 'child', error: 'The child plan is no longer open.' });
        show(nested);
        expect(screen.getByRole('status')).toHaveTextContent('Not sent to Delegate');
      });
      it('are told of as failed at the root, when the person went there', () => {
        render(<App />);
        show(entry());
        write('Carry on');
        send();
        fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
        post({ type: 'childMessageResult', childId: 'child', error: 'The child plan is no longer open.' });
        expect(screen.getByRole('status')).toHaveTextContent('Not sent to Delegate: The child plan is no longer open.');
      });
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
