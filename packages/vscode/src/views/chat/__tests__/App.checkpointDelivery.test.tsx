import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChildPlanEntry, ChildPlanView } from '@ordewell/core';
import App from '../App';
import { api, lastAnswerId, post } from './hostBridge';

vi.mock('@ordewell/core/plan-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core/plan-utils')>();
  return { ...real, get DELEGATION_OFFERED() { return true; } };
});

const QUESTION = 'Round half up?';
const rootTask = (q: string) => ({ id: 'd1', title: 'Import ledger', type: 'delegated', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: q, subtasks: [] });
const rootView = (q: string | null) => ({ type: 'runView', view: { tasks: q ? [rootTask(q)] : [], runMerge: null, handoff: null, mergeResult: null } });
const plan = { tasks: [{ id: 'd1', order: 1, title: 'Import ledger', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }], generatedAt: new Date().toISOString(), status: 'draft' as const, runners: ['claude-code'], lastUpdated: new Date().toISOString() };

const ask = (q: string | null = QUESTION) => post(rootView(q) as never);
const asked = () => { render(<App />); post({ type: 'planUpdated', plan } as never); ask(); };
const type = (words: string) => fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: words } });
const typeRaise = (tokens: string) => fireEvent.change(screen.getByLabelText(/Raise its budget/), { target: { value: tokens } });
const approve = () => { fireEvent.click(document.querySelector('.checkpoint-approve-btn')!); return lastAnswerId(); };
const reject = (reason: string) => {
  fireEvent.click(document.querySelector('.checkpoint-reject-btn')!);
  fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
  return lastAnswerId();
};
const landed = (answerId: string) => post({ type: 'checkpointResult', answerId } as never);
const refused = (answerId: string, error = 'The budget is spent.') => post({ type: 'checkpointResult', answerId, error } as never);
const card = () => document.querySelector('.checkpoint-panel');
const notDelivered = () => screen.queryByRole('region', { name: 'Answers not delivered' });
const notSent = () => screen.queryByRole('region', { name: 'Words not sent' });
const text = (region: HTMLElement | null) => region?.textContent ?? '';
const answerBox = () => screen.getByLabelText('Your answer');
const raiseBox = () => screen.getByLabelText(/Raise its budget/);
const switchSession = () => { post({ type: 'restoreChat', messages: [] } as never); post({ type: 'planUpdated', plan } as never); };
const dismiss = (region: HTMLElement | null) => fireEvent.click(within(region!).getByRole('button', { name: 'Dismiss' }));
/** Results the host sent together, read by the page before it draws again. */
const together = (...results: { answerId: string; error?: string }[]) => act(() => {
  for (const result of results) window.dispatchEvent(new MessageEvent('message', { data: { type: 'checkpointResult', ...result } }));
});

/** One delivered answer, and the same question asked again after the run left it. */
function deliveredThenAskedAgain(words: string) {
  asked();
  type(words);
  const id = approve();
  ask(null);
  landed(id);
  ask();
}

/** Two answers to the same words out at once, and the question gone. */
function twoAnswersOut() {
  asked();
  type('Older words.');
  const older = approve();
  ask(null);
  ask();
  type('Newer words.');
  const newer = approve();
  ask(null);
  return { older, newer };
}

describe('the delivery of a root checkpoint answer', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('does not call a delivered answer refused when the same question is asked again and refused', () => {
    deliveredThenAskedAgain('Half up, delivered.');
    type('Half down, refused.');
    const second = approve();
    refused(second);
    ask(null);

    const list = text(notDelivered());
    expect(list).toContain('Half down, refused.');
    expect(list).not.toContain('Half up, delivered.');
  });

  it('lists a delivered answer nowhere once its question has gone', () => {
    asked();
    type('Half up.');
    const id = approve();
    landed(id);
    expect(card()).toBeNull();
    ask(null);
    expect(notDelivered()).toBeNull();
    expect(notSent()).toBeNull();
  });

  it('starts blank when the question is asked again after a delivered answer', () => {
    deliveredThenAskedAgain('Half up.');
    expect(answerBox()).toHaveValue('');
  });

  it('settles an older answer the host took a newer one over, whichever result comes first', () => {
    const first = twoAnswersOut();
    landed(first.newer);
    refused(first.older);
    expect(notDelivered()).toBeNull();
    cleanup();

    const second = twoAnswersOut();
    refused(second.older);
    landed(second.newer);
    expect(notDelivered()).toBeNull();
  });

  it('lists only the newer answer when the older landed, whichever result comes first', () => {
    const first = twoAnswersOut();
    landed(first.older);
    refused(first.newer);
    expect(text(notDelivered())).toContain('Newer words.');
    expect(text(notDelivered())).not.toContain('Older words.');
    cleanup();

    const second = twoAnswersOut();
    refused(second.newer);
    landed(second.older);
    expect(text(notDelivered())).toContain('Newer words.');
    expect(text(notDelivered())).not.toContain('Older words.');
  });

  it('reads results the host sent together before the page drew again', () => {
    const { older, newer } = twoAnswersOut();
    together({ answerId: older }, { answerId: newer, error: 'Refused at once.' });
    expect(text(notDelivered())).toContain('Newer words.');
    expect(text(notDelivered())).toContain('Refused at once.');
    expect(text(notDelivered())).not.toContain('Older words.');
  });

  it('keeps both of two refusals the host sent together', () => {
    asked();
    const older = reject('Wrong rounding.');
    ask(null);
    ask();
    type('Newer words.');
    const newer = approve();
    ask(null);
    together({ answerId: older, error: 'Refused.' }, { answerId: newer, error: 'Refused.' });
    expect(text(notDelivered())).toContain('Wrong rounding.');
    expect(text(notDelivered())).toContain('Newer words.');
  });

  it('reads a result that comes before the page drew the answer it names', () => {
    asked();
    type('Half up.');
    act(() => {
      fireEvent.click(document.querySelector('.checkpoint-approve-btn')!);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'checkpointResult', answerId: lastAnswerId(), error: 'Refused at once.' } }));
    });
    ask(null);
    expect(text(notDelivered())).toContain('Half up.');
  });

  it('makes no claim on an older refusal while a newer answer is still out', () => {
    const { older, newer } = twoAnswersOut();
    refused(older);
    expect(notDelivered()).toBeNull();
    refused(newer, 'Refused too.');
    expect(text(notDelivered())).toContain('Newer words.');
    expect(text(notDelivered())).toContain('Refused too.');
  });

  it('leaves a card closed on a newer answer when an older answer to the same question is refused', () => {
    asked();
    type('Older words.');
    const older = approve();
    ask(null);
    ask();
    type('Newer words.');
    const newer = approve();
    refused(older);
    expect(card()).toBeNull();
    refused(newer);
    expect(answerBox()).toHaveValue('Newer words.');
  });

  it('drops a refused answer when its retry lands, and hides it while the retry is out', () => {
    asked();
    type('Half up.');
    const first = approve();
    refused(first);
    expect(answerBox()).toHaveValue('Half up.');
    const retry = approve();
    ask(null);
    expect(notDelivered()).toBeNull();
    landed(retry);
    expect(notDelivered()).toBeNull();
    expect(notSent()).toBeNull();
  });

  it('ignores a result for an answer it does not hold', () => {
    asked();
    type('Half up.');
    const id = approve();
    refused('an answer of another page');
    landed('an answer of another page');
    expect(card()).toBeNull();
    ask(null);
    refused(id);
    expect(text(notDelivered())).toContain('Half up.');
  });
});

describe('words a person typed after an answer went', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('keeps words retyped to match a delivered answer when the question is withdrawn', () => {
    deliveredThenAskedAgain('Half up.');
    type('Half up.');
    ask(null);
    expect(text(notSent())).toContain('Half up.');
    expect(notDelivered()).toBeNull();
  });

  it('keeps words retyped to match an answer whose result comes after them', () => {
    asked();
    type('Half up.');
    const id = approve();
    ask(null);
    ask();
    type('Half up.');
    landed(id);
    expect(answerBox()).toHaveValue('Half up.');
    ask(null);
    expect(text(notSent())).toContain('Half up.');
  });

  it('keeps a retyped raise equal to a delivered one', () => {
    asked();
    typeRaise('700000');
    const id = approve();
    ask(null);
    landed(id);
    ask();
    typeRaise('700000');
    ask(null);
    expect(text(notSent())).toContain('700000');
  });

  it('claims nothing unsent for words retyped and given', () => {
    deliveredThenAskedAgain('Half up.');
    type('Half up.');
    const again = approve();
    ask(null);
    landed(again);
    expect(notSent()).toBeNull();
    expect(notDelivered()).toBeNull();
  });
});

describe('a raise of the budget that did not arrive', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('stays readable with the answer and the refusal once the question goes', () => {
    asked();
    type('Half up.');
    typeRaise('700000');
    const id = approve();
    ask(null);
    refused(id, 'The budget is spent.');
    const list = text(notDelivered());
    expect(list).toContain('Half up.');
    expect(list).toContain('Your raise (tokens):700000');
    expect(list).toContain('The budget is spent.');
    expect(notSent()).toBeNull();
  });

  it('stays readable on a wordless approval', () => {
    asked();
    typeRaise('700000');
    const id = approve();
    refused(id);
    ask(null);
    expect(text(notDelivered())).toContain('700000');
    expect(notSent()).toBeNull();
  });

  it('stays readable when typed and never sent', () => {
    asked();
    typeRaise('700000');
    ask(null);
    expect(text(notSent())).toContain('Your raise (tokens), not sent:700000');
    expect(notDelivered()).toBeNull();
  });

  it('is told apart from the reason of a rejection it never went with', () => {
    asked();
    typeRaise('700000');
    const id = reject('Wrong rounding.');
    ask(null);
    refused(id);
    expect(text(notDelivered())).toContain('Wrong rounding.');
    expect(text(notDelivered())).not.toContain('700000');
    expect(text(notSent())).toContain('700000');
  });

  it('is shown as it was typed, not as the number it means', () => {
    asked();
    typeRaise('7e5');
    const id = approve();
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'answerCheckpoint', raiseTokens: 700000 }));
    refused(id);
    expect(raiseBox()).toHaveValue('7e5');
    ask(null);
    expect(text(notDelivered())).toContain('7e5');
    expect(notSent()).toBeNull();
  });

  it('keeps what was refused apart from a raise typed after the refusal', () => {
    asked();
    typeRaise('700000');
    const id = approve();
    refused(id);
    typeRaise('800000');
    ask(null);
    expect(text(notDelivered())).toContain('700000');
    expect(text(notDelivered())).not.toContain('800000');
    expect(text(notSent())).toContain('800000');
  });

  it('comes back to the card if the question is asked again, and leaves when dismissed', () => {
    asked();
    typeRaise('700000');
    const id = approve();
    ask(null);
    refused(id);
    ask();
    expect(raiseBox()).toHaveValue('700000');
    ask(null);
    dismiss(notDelivered());
    expect(notDelivered()).toBeNull();
    expect(notSent()).toBeNull();
    ask();
    expect(raiseBox()).toHaveValue('');
  });
});

describe('a checkpoint answer across a session switch', () => {
  beforeEach(() => { api.postMessage.mockClear(); });

  it('keeps a late refusal readable, and opens no card for it', () => {
    asked();
    type('Half up.');
    typeRaise('700000');
    const id = approve();
    switchSession();
    refused(id);
    expect(card()).toBeNull();
    expect(text(notDelivered())).toContain('Half up.');
    expect(text(notDelivered())).toContain('700000');
  });

  it('claims nothing for an answer that landed while another session was on screen', () => {
    asked();
    type('Half up.');
    const id = approve();
    switchSession();
    landed(id);
    expect(notDelivered()).toBeNull();
    expect(notSent()).toBeNull();
  });

  it('finds the refused words in the card of the question on coming back', () => {
    asked();
    type('Half up.');
    const id = approve();
    switchSession();
    ask();
    refused(id);
    expect(answerBox()).toHaveValue('Half up.');
  });
});

const entry: ChildPlanEntry = { sessionId: 'child', parent: 'root', node: '0/1', taskId: 'd', title: 'Delegate', depth: 1, state: 'parked' };
function childAsking(question: string | null): ChildPlanView {
  return {
    child: entry,
    plan: { tasks: [{ id: 'n', order: 1, title: 'Nested', type: 'delegated', status: 'awaiting_user', description: '', dependencies: [], subtasks: [] }], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] },
    run: { tasks: [question === null
      ? { id: 'n', title: 'Nested', status: 'in_progress', subtasks: [] }
      : { id: 'n', title: 'Nested', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: question, subtasks: [] }], runMerge: null, handoff: null, mergeResult: null },
  } as unknown as ChildPlanView;
}

describe('the delivery of a child checkpoint answer', () => {
  beforeEach(() => { api.postMessage.mockClear(); });
  const askChild = (q: string | null = QUESTION) => post({ type: 'childView', view: childAsking(q) });
  function deliveredInChild(words: string) {
    render(<App />);
    askChild();
    type(words);
    const id = approve();
    askChild(null);
    landed(id);
    askChild();
  }

  it('does not call a delivered answer refused when the same question is asked again and refused', () => {
    deliveredInChild('Half up, delivered.');
    type('Half down, refused.');
    const second = approve();
    refused(second);
    askChild(null);
    expect(text(notDelivered())).toContain('Half down, refused.');
    expect(text(notDelivered())).not.toContain('Half up, delivered.');
  });

  it('keeps words retyped to match a delivered answer when the question is withdrawn', () => {
    deliveredInChild('Half up.');
    type('Half up.');
    askChild(null);
    expect(text(notSent())).toContain('Half up.');
  });

  it('keeps a form as it was while the answer is out, and clears it when the answer lands', () => {
    render(<App />);
    askChild();
    type('Half up.');
    const id = approve();
    expect(answerBox()).toHaveValue('Half up.');
    landed(id);
    expect(answerBox()).toHaveValue('');
    expect(notSent()).toBeNull();
  });
});
