import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildPlanEntry, ChildPlanView } from '@ordewell/core';
import App from '../App';
import { api, lastAnswerId, post } from './hostBridge';

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
const typeAnswer = (w: string) => fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: w } });
const approveWith = (w: string) => { typeAnswer(w); fireEvent.click(screen.getByRole('button', { name: /Approve/ })); };
const region = () => screen.queryByRole('region', { name: 'Answers not delivered' });
const body = () => document.body.textContent ?? '';

describe('child answers that were refused or never sent', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  const unsent = () => screen.queryByRole('region', { name: 'Words not sent' });

  it('words typed and never sent survive a replaced question, listed as not sent', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('A long answer the person typed but has not sent.');
    post({ type: 'childView', view: asking('Which currency?') });
    expect(words()).toHaveValue('');
    expect(within(unsent()!).getByText('A long answer the person typed but has not sent.')).toBeTruthy();
    expect(within(unsent()!).getByText('Your answer, not sent:')).toBeTruthy();
    expect(region()).toBeNull();
  });
  it('words typed and never sent go back to their form when the question returns', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('Typed, unsent.');
    post({ type: 'childView', view: asking('Which currency?') });
    post({ type: 'childView', view: asking('Which rounding?') });
    expect(words()).toHaveValue('Typed, unsent.');
    expect(unsent()).toBeNull();
  });
  it('words typed and never sent survive a withdrawn question', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('Typed, unsent.');
    post({ type: 'childView', view: asking(null) });
    expect(within(unsent()!).getByText('Typed, unsent.')).toBeTruthy();
  });
  it('words typed and never sent survive the child ending, where no form can come back', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('Typed, unsent.');
    post({ type: 'childView', view: asking('Which rounding?', entry({ state: 'ended' })) });
    expect(within(unsent()!).getByText('Typed, unsent.')).toBeTruthy();
  });
  it('a rejection reason typed and never sent survives a replaced question, named as a reason', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Half a reason.' } });
    post({ type: 'childView', view: asking('Which currency?') });
    expect(within(unsent()!).getByText('Half a reason.')).toBeTruthy();
    expect(within(unsent()!).getByText('Your rejection reason, not sent:')).toBeTruthy();
  });
  it('letting go of words never sent leaves them gone, and a refused answer beside them stays', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Never sent.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    fireEvent.click(within(unsent()!).getByRole('button', { name: 'Dismiss' }));
    expect(unsent()).toBeNull();
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(screen.getByPlaceholderText(/Why are you rejecting/)).toHaveValue('');
  });
  it('letting go of a refused answer leaves the words typed and never sent', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Never sent.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    fireEvent.click(within(region()!).getByRole('button', { name: 'Dismiss' }));
    expect(region()).toBeNull();
    expect(within(unsent()!).getByText('Never sent.')).toBeTruthy();
  });
  it('an approval sent with words, a rejection reason only typed: the reason is not read as sent', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Changed my mind about this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    approveWith('Floor.');
    expect(api.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ answer: 'approve', reason: 'Floor.' }));
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    expect(within(region()!).getByText('Your answer:')).toBeTruthy();
    expect(within(region()!).queryByText(/rejection reason/)).toBeNull();
    expect(within(region()!).queryByText('Changed my mind about this.')).toBeNull();
    expect(within(unsent()!).getByText('Changed my mind about this.')).toBeTruthy();
  });
  it('a wordless approval that was refused is not listed as a rejection, nor listed at all', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Never sent.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    refused();
    post({ type: 'childView', view: asking('Which currency?') });
    expect(region()).toBeNull();
    expect(within(unsent()!).getByText('Your rejection reason, not sent:')).toBeTruthy();
  });
  it('a rejection sent and refused does not make the words only typed read as an approval given', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('Unsent approval words.');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'No.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
    refused();
    post({ type: 'childView', view: asking(null) });
    expect(within(region()!).queryByText('Your answer:')).toBeNull();
    expect(within(region()!).getByText('Your rejection reason:')).toBeTruthy();
    expect(within(region()!).getByText('No.')).toBeTruthy();
    expect(within(unsent()!).getByText('Unsent approval words.')).toBeTruthy();
  });
  it('words refused for a plan that closed under the person are told at the root, and can be let go', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Words only here.');
    post({ type: 'childClosed' });
    refused('The child plan is no longer open.');
    expect(body()).toContain('Not answered in Delegate');
    const list = within(region()!);
    expect(list.getByText('Words only here.')).toBeTruthy();
    expect(list.getByText('The child plan is no longer open.')).toBeTruthy();
    expect(list.getByText('Delegate')).toBeTruthy();
    fireEvent.click(list.getByRole('button', { name: 'Dismiss' }));
    expect(region()).toBeNull();
  });
  it('the root does not list words typed to a child that is still in the tree', () => {
    render(<App />);
    post({ type: 'children', rootId: 'root', children: [entry()] });
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('Typed, unsent.');
    post({ type: 'childClosed' });
    expect(body()).not.toContain('Typed, unsent.');
  });
  it('the root lists words typed to a child that has left the tree', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    typeAnswer('Typed, unsent.');
    post({ type: 'childClosed' });
    expect(within(unsent()!).getByText('Typed, unsent.')).toBeTruthy();
  });

  it('an ended child lists what was refused to it', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Which rounding?') });
    approveWith('Floor.');
    refused('This child plan has ended, so it only reads.');
    post({ type: 'childView', view: asking('Which rounding?', entry({ state: 'ended' })) });
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    expect(within(region()!).getByText(/only reads/)).toBeTruthy();
  });
  it('a refused answer under a question that returns goes back to its form, not the region', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Q2?') });
    expect(region()).not.toBeNull();
    post({ type: 'childView', view: asking('Q1?') });
    expect(region()).toBeNull();
    expect(screen.getByLabelText('Your answer')).toHaveValue('Floor.');
  });
  it('the form for the next question stays shut while an older answer is out, then opens', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    post({ type: 'childView', view: asking('Q2?') });
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
    refused();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeEnabled();
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
  });
  it('two tasks and two children keep their answers apart', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Same?') });
    approveWith('Mine.');
    refused();
    post({ type: 'childView', view: asking('Same?', entry({ sessionId: 'sibling', title: 'Sibling' })) });
    expect(screen.getByLabelText('Your answer')).toHaveValue('');
    post({ type: 'checkpointResult', answerId: 'an answer of another page', error: 'x' });
    expect(region()).toBeNull();
  });
  it('a refused answer survives a root session switch and return', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    post({ type: 'childClosed' });
    refused('The child plan is no longer open.');
    post({ type: 'childView', view: asking('Q2?') });
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
  });
  it('a landed resend drops the refused entry', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    approveWith('Ceiling.');
    post({ type: 'checkpointResult', answerId: lastAnswerId() });
    post({ type: 'childView', view: asking('Q2?') });
    expect(region()).toBeNull();
    post({ type: 'childView', view: asking('Q1?') });
    expect(screen.getByLabelText('Your answer')).toHaveValue('');
  });

  const landed = (answerId = lastAnswerId()) => post({ type: 'checkpointResult', answerId });
  const back = () => fireEvent.click(screen.getByRole('button', { name: 'Back to parent' }));
  const reopen = (view: ChildPlanView) => {
    post({ type: 'children', rootId: 'root', children: [entry({ checkpoints: ['n'] })] });
    fireEvent.click(screen.getByRole('button', { name: 'A question waits in Delegate' }));
    post({ type: 'childView', view });
  };
  const form = (title: string) => within(screen.getByRole('group', { name: `Question on ${title}` }));
  const words = (title = 'Nested') => form(title).getByLabelText('Your answer') as HTMLTextAreaElement;
  function two(n: string | null, m: string | null): ChildPlanView {
    const task = (id: string, title: string) => ({ id, order: 1, title, type: 'delegated', status: 'awaiting_user', description: '', dependencies: [], subtasks: [] });
    const run = (id: string, title: string, q: string | null) => (q === null
      ? { id, title, status: 'in_progress', subtasks: [] }
      : { id, title, status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: q, subtasks: [] });
    return { ...asking(null), plan: { ...asking(null).plan, tasks: [task('n', 'Nested'), task('m', 'Other')] }, run: { ...noRun, tasks: [run('n', 'Nested', n), run('m', 'Other', m)] } } as unknown as ChildPlanView;
  }

  it('a refusal arriving after the question was replaced is readable, and the later answer leaves it', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    post({ type: 'childView', view: asking('Q2?') });
    expect(region()).toBeNull();
    expect(screen.getByRole('button', { name: /Approve/ }).matches(':disabled')).toBe(true);
    refused();
    expect(screen.getByRole('button', { name: /Approve/ }).matches(':disabled')).toBe(false);
    expect(words()).toHaveValue('');
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    approveWith('Euro.');
    landed();
    post({ type: 'childView', view: asking('Q3?') });
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    expect(within(region()!).queryByText('Euro.')).toBeNull();
  });
  it('a refusal arriving after the question was withdrawn is readable', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    post({ type: 'childView', view: asking(null) });
    refused();
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    expect(within(region()!).getByText('The budget is spent.')).toBeTruthy();
  });
  it('a refusal arriving on the root is told there, and is read on return to a replaced question', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    back();
    refused();
    expect(body()).toContain('Not answered in Delegate: The budget is spent.');
    reopen(asking('Q2?'));
    expect(words()).toHaveValue('');
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
  });
  it('a resend of an edit, refused after the question moved, keeps one entry with the edit and the newest error', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    approveWith('Floor, edited.');
    post({ type: 'childView', view: asking('Q2?') });
    refused('The plan is shut.');
    const r = within(region()!);
    expect(r.getByText('Floor, edited.')).toBeTruthy();
    expect(r.queryByText('Floor.')).toBeNull();
    expect(r.getByText('The plan is shut.')).toBeTruthy();
    expect(r.queryByText('The budget is spent.')).toBeNull();
    expect(r.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });
  it('a resend that lands after the question moved leaves nothing behind', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    approveWith('Floor, edited.');
    post({ type: 'childView', view: asking('Q2?') });
    landed();
    expect(region()).toBeNull();
    post({ type: 'childView', view: asking('Q1?') });
    expect(words()).toHaveValue('');
  });
  it('repeat refusals: resending one lands only that one', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Q2?') });
    approveWith('Euro.');
    refused();
    post({ type: 'childView', view: asking('Q1?') });
    expect(words()).toHaveValue('Floor.');
    expect(within(region()!).getByText('Euro.')).toBeTruthy();
    approveWith('Floor, again.');
    landed();
    post({ type: 'childView', view: asking('Q3?') });
    expect(within(region()!).getByText('Euro.')).toBeTruthy();
    expect(within(region()!).queryByText(/Floor/)).toBeNull();
  });
  it('a refused question coming back while a later answer is out stays shut, then has its words', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    post({ type: 'childView', view: asking('Q2?') });
    approveWith('Euro.');
    post({ type: 'childView', view: asking('Q1?') });
    expect(words()).toHaveValue('Floor.');
    expect(screen.getByRole('button', { name: /Approve/ }).matches(':disabled')).toBe(true);
    refused();
    expect(screen.getByRole('button', { name: /Approve/ }).matches(':disabled')).toBe(false);
    expect(words()).toHaveValue('Floor.');
    expect(within(region()!).getByText('Euro.')).toBeTruthy();
    expect(within(region()!).queryByText('Floor.')).toBeNull();
  });
  it('an edit survives leaving by Back, and a result on another task while away', () => {
    render(<App />);
    post({ type: 'childView', view: two('Q1?', 'QM?') });
    typeAndGive('Nested', 'Floor.');
    refused();
    fireEvent.change(words('Nested'), { target: { value: 'Floor, edited.' } });
    typeAndGive('Other', 'Other words.');
    const other = lastAnswerId();
    back();
    refused('Other refused.', other);
    reopen(two('Q1?', 'QM?'));
    expect(words('Nested')).toHaveValue('Floor, edited.');
    expect(words('Other')).toHaveValue('Other words.');
    landed('an answer no longer here');
    expect(words('Nested')).toHaveValue('Floor, edited.');
    post({ type: 'childView', view: two('Q2?', null) });
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    expect(within(region()!).getByText('Other words.')).toBeTruthy();
    expect(within(unsent()!).getByText('Floor, edited.')).toBeTruthy();
  });
  it('an edit that empties a recovered answer stays empty, and brings nothing back', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    typeAnswer('');
    back();
    reopen(asking('Q1?'));
    expect(words()).toHaveValue('');
    post({ type: 'childView', view: asking('Q2?') });
    expect(region()).toBeNull();
  });
  it('an edit moves back to its returning question, and is not listed twice', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    typeAnswer('Floor, edited.');
    post({ type: 'childView', view: asking('Q2?') });
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    expect(within(unsent()!).getByText('Floor, edited.')).toBeTruthy();
    post({ type: 'childView', view: asking('Q1?') });
    expect(words()).toHaveValue('Floor, edited.');
    expect(region()).toBeNull();
  });
  it('a question asked again after its answer landed starts blank, and a stray result does nothing', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    landed();
    refused('A stray result.');
    post({ type: 'childView', view: asking('Q1?') });
    expect(words()).toHaveValue('');
    expect(body()).not.toContain('A stray result.');
    expect(region()).toBeNull();
  });
  it('an out answer cannot be given twice', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    expect(screen.getByRole('button', { name: /Approve/ }).matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reject' }).matches(':disabled')).toBe(true);
    expect(words().matches(':disabled')).toBe(true);
    expect(api.postMessage.mock.calls.filter(([m]) => m.type === 'answerChildCheckpoint')).toHaveLength(1);
  });
  it('approval then rejection, each refused: both sets of words stay readable', () => {
    render(<App />);
    post({ type: 'childView', view: asking('Q1?') });
    approveWith('Floor.');
    refused();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'No.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
    refused('Second refusal.');
    post({ type: 'childView', view: asking('Q2?') });
    expect(within(region()!).getByText('Floor.')).toBeTruthy();
    expect(within(region()!).getByText('No.')).toBeTruthy();
    expect(within(region()!).getByText('Second refusal.')).toBeTruthy();
  });

  function typeAndGive(title: string, w: string) {
    fireEvent.change(words(title), { target: { value: w } });
    fireEvent.click(form(title).getByRole('button', { name: /Approve/ }));
  }
});
