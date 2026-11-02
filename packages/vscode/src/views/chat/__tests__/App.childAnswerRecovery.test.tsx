import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildPlanEntry, ChildPlanView } from '@ordewell/core';
import App from '../App';
import { api, lastAnswerId, post } from './hostBridge';

const noRun = { tasks: [], runMerge: null, handoff: null, mergeResult: null };

function entry(overrides: Partial<ChildPlanEntry> = {}): ChildPlanEntry {
  return { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked', ...overrides };
}

/** A child plan whose one task asks `question`, or asks nothing when it is withdrawn. */
function asking(question: string | null, child = entry()): ChildPlanView {
  return {
    child,
    plan: { tasks: [{ id: 'n', order: 1, title: 'Nested', type: 'delegated', status: 'awaiting_user', description: '', dependencies: [], subtasks: [] }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] },
    run: { ...noRun, tasks: [question === null
      ? { id: 'n', title: 'Nested', status: 'in_progress', subtasks: [] }
      : { id: 'n', title: 'Nested', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: question, subtasks: [] }] },
  } as unknown as ChildPlanView;
}

const elsewhere = () => post({ type: 'childView', view: { ...asking('Other?', entry({ sessionId: 'other', parent: 'child', title: 'Other plan', depth: 2 })), plan: null, run: noRun } as ChildPlanView });
const refused = (error = 'The budget is spent.') => post({ type: 'checkpointResult', answerId: lastAnswerId(), error });
const approveWith = (words: string) => {
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: words } });
  fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
};
const notDelivered = () => screen.getByRole('region', { name: 'Answers not delivered' });

describe('a refused answer in a child plan', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('stays readable when the question changed while the person was away', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    elsewhere();
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    expect(screen.getByLabelText('Your answer')).toHaveValue('');
    expect(within(notDelivered()).getByText('Which rounding?')).toBeTruthy();
    expect(within(notDelivered()).getByText('Floor.')).toBeTruthy();
    expect(within(notDelivered()).getByText(/The budget is spent\./)).toBeTruthy();
  });

  it('stays readable when the question was withdrawn', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking(null) });
    expect(within(notDelivered()).getByText('Floor.')).toBeTruthy();
  });

  it('stays readable when the task left the plan', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: { ...asking(null), plan: null, run: noRun } as ChildPlanView });
    expect(within(notDelivered()).getByText('Floor.')).toBeTruthy();
  });

  it('keeps a rejection reason that was refused, whatever replaced the question', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Use floor.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    expect(within(notDelivered()).getByText('Use floor.')).toBeTruthy();
  });

  it('is not overwritten by an answer to the question that replaced it', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    approveWith('Euro.');
    expect(within(notDelivered()).getByText('Floor.')).toBeTruthy();
    post({ type: 'checkpointResult', answerId: lastAnswerId() });
    expect(within(notDelivered()).getByText('Floor.')).toBeTruthy();
  });

  it('keeps every one of repeated refusals, one per question', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    approveWith('Euro.');
    refused('The plan is shut.');
    post({ type: 'childView', view: asking('Which locale?') });
    const region = notDelivered();
    expect(within(region).getByText('Floor.')).toBeTruthy();
    expect(within(region).getByText('Euro.')).toBeTruthy();
    expect(within(region).getByText(/The plan is shut\./)).toBeTruthy();
  });

  it('keeps the latest words when the same question is refused again', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    approveWith('Ceiling.');
    refused();
    expect(screen.getByLabelText('Your answer')).toHaveValue('Ceiling.');
    post({ type: 'childView', view: asking('Which currency?') });
    expect(within(notDelivered()).getByText('Ceiling.')).toBeTruthy();
    expect(within(notDelivered()).queryByText('Floor.')).toBeNull();
  });

  it('keeps an edit of the recovered words through navigation', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Floor, to cents.' } });
    elsewhere();
    post({ type: 'childView', view: asking('Which rounding?') });
    expect(screen.getByLabelText('Your answer')).toHaveValue('Floor, to cents.');
    post({ type: 'childView', view: asking('Which currency?') });
    expect(within(notDelivered()).getByText('Floor.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Words not sent' })).getByText('Floor, to cents.')).toBeTruthy();
  });

  it('keeps an edit of a recovered rejection reason through navigation', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Use floor.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
    refused();
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Use floor, always.' } });
    elsewhere();
    post({ type: 'childView', view: asking('Which rounding?') });
    expect(screen.getByPlaceholderText(/Why are you rejecting/)).toHaveValue('Use floor, always.');
    post({ type: 'childView', view: asking(null) });
    expect(within(notDelivered()).getByText('Use floor.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Words not sent' })).getByText('Use floor, always.')).toBeTruthy();
  });

  it('is sent again from the recovered form with the edit', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    elsewhere();
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor, again.');
    expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'answerChildCheckpoint', answerId: expect.any(String), childId: 'child', taskId: 'n', question: 'Which rounding?', answer: 'approve', reason: 'Floor, again.' });
  });

  it('is let go on request, and shows nothing once it landed', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking(null) });
    fireEvent.click(within(notDelivered()).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Answers not delivered' })).toBeNull();
    post({ type: 'childView', view: asking('Which currency?') });
    approveWith('Euro.');
    post({ type: 'checkpointResult', answerId: lastAnswerId() });
    post({ type: 'childView', view: asking(null) });
    expect(screen.queryByRole('region', { name: 'Answers not delivered' })).toBeNull();
  });
});
