import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildPlanEntry, ChildPlanView } from '@ordewell/core';
import App from '../App';
import { api, lastAnswerId, post } from './hostBridge';

vi.mock('@ordewell/core/plan-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core/plan-utils')>();
  return { ...real, get DELEGATION_OFFERED() { return true; } };
});

const noRun = { tasks: [], runMerge: null, handoff: null, mergeResult: null };
function entry(o: Partial<ChildPlanEntry> = {}): ChildPlanEntry {
  return { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked', ...o };
}
function asking(question: string | null, child = entry()): ChildPlanView {
  return {
    child,
    plan: { tasks: [{ id: 'n', order: 1, title: 'Nested', type: 'delegated', status: 'awaiting_user', description: '', dependencies: [], subtasks: [] }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] },
    run: { ...noRun, tasks: [question === null
      ? { id: 'n', title: 'Nested', status: 'in_progress', subtasks: [] }
      : { id: 'n', title: 'Nested', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: question, subtasks: [] }] },
  } as unknown as ChildPlanView;
}
const refused = (error = 'The budget is spent.', answerId = lastAnswerId()) => post({ type: 'checkpointResult', answerId, error });
const type = (w: string) => fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: w } });
const approveBtn = () => screen.getByRole('button', { name: /Approve/ });
const notDelivered = () => screen.queryByRole('region', { name: 'Answers not delivered' });
const body = () => document.body.textContent ?? '';

const rootTask = (q: string) => ({ id: 'd1', title: 'Import ledger', type: 'delegated', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: q, subtasks: [] });
const rootView = (q: string | null) => ({ type: 'runView' as const, view: { tasks: q ? [rootTask(q)] : [], runMerge: null, handoff: null, mergeResult: null } });
const plan = { tasks: [{ id: 'd1', order: 1, title: 'Import ledger', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }], generatedAt: new Date().toISOString(), status: 'draft' as const, runners: ['claude-code'], lastUpdated: new Date().toISOString() };
const card = () => document.querySelector('.checkpoint-panel');
const rootAsked = (q = 'Round half up?') => { render(<App />); post({ type: 'planUpdated', plan } as never); post(rootView(q) as never); };
const rootRefused = (answerId = lastAnswerId()) => ({ type: 'checkpointResult', answerId, error: 'The budget is spent.' });
const rootApprove = () => fireEvent.click(document.querySelector('.checkpoint-approve-btn')!);

describe('answers whose question has moved on or been edited', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('an edit made after the refusal is not listed as the words that were sent', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    type('Half up.');
    fireEvent.click(approveBtn());
    refused();
    type('Half down, typed after the refusal and never sent.');
    post({ type: 'childView', view: asking('Another question?') });
    const list = notDelivered();
    expect(list).not.toBeNull();
    expect(within(list!).queryByText(/never sent/)).toBeNull();
    expect(within(list!).queryByText('Half up.')).not.toBeNull();
  });

  it('the root list says the same while the form is still open', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    type('Half up.');
    fireEvent.click(approveBtn());
    refused();
    type('Half down, never sent.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
    expect(within(notDelivered()!).queryByText(/never sent/)).toBeNull();
  });

  it('a root answer refused after the question left stays readable', () => {
    rootAsked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up, please.' } });
    rootApprove();
    post(rootView(null) as never);
    post(rootRefused() as never);
    expect(body()).toContain('Half up, please.');
  });

  it('a root answer whose card came back, then the question left, stays readable', () => {
    rootAsked();
    fireEvent.click(document.querySelector('.checkpoint-reject-btn')!);
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Wrong rounding.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
    post(rootRefused() as never);
    expect(card()).not.toBeNull();
    post(rootView(null) as never);
    expect(body()).toContain('Wrong rounding.');
  });

  it('a root answer refused after the question was replaced stays readable', () => {
    rootAsked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up, please.' } });
    rootApprove();
    post(rootView('A new question?') as never);
    post(rootRefused() as never);
    expect(body()).toContain('Half up, please.');
  });

  it('a late refusal of the old question leaves a newer answer on the same task shut', () => {
    rootAsked();
    rootApprove();
    const old = lastAnswerId();
    post(rootView('A new question?') as never);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'New words.' } });
    rootApprove();
    expect(card()).toBeNull();
    post(rootRefused(old) as never);
    expect(card()).toBeNull();
  });

  it('root words typed and never sent survive a withdrawn question', () => {
    rootAsked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Typed at the root.' } });
    post(rootView(null) as never);
    expect(body()).toContain('Typed at the root.');
  });

  it('root words typed survive a session switch and return, as a child\'s do', () => {
    rootAsked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Typed at the root.' } });
    post({ type: 'restoreChat', messages: [] } as never);
    post({ type: 'planUpdated', plan } as never);
    post(rootView('Round half up?') as never);
    fireEvent.click(document.querySelector('.plan-dock-toggle, .plan-dock-header, .plan-dock button')!);
    expect(screen.getByLabelText('Your answer')).toHaveValue('Typed at the root.');
  });

  it('words typed in a child plan that left the tree are reachable somewhere', () => {
    render(<App />);
    post({ type: 'children', rootId: 'root', children: [entry()] } as never);
    post({ type: 'childView', view: asking('Which rounding?') });
    type('Typed, unsent.');
    post({ type: 'childClosed' } as never);
    post({ type: 'children', rootId: 'root', children: [] } as never);
    expect(body()).toContain('Typed, unsent.');
  });

  it('a root question asked again after another one starts blank, not with the answer given before', () => {
    rootAsked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up.' } });
    rootApprove();
    post(rootView('Other?') as never);
    post(rootView('Round half up?') as never);
    expect(screen.getByLabelText('Your answer')).toHaveValue('');
  });
});
