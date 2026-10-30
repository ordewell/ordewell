import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Escalation, RunView } from '@ordewell/core';
import App from '../App';
import { api, post } from './hostBridge';

/**
 * The escalation inbox (ADR-0053): what waits on a person, drawn from the run
 * view's list and answered through the host's `answerEscalation`. It is shown
 * only while something waits, and sits beside the composer without moving it.
 */

const failed: Escalation = {
  id: 'failed:t1:2',
  kind: 'failed',
  task: { id: 't1', ref: '#1', title: 'Add rate limiting' },
  attempt: 2,
  reason: 'Task #1 failed on attempt 2.',
  options: [
    { id: 'retry', label: 'Retry' },
    { id: 'skip', label: 'Skip' },
    { id: 'complete', label: 'Mark complete', confirm: 'Mark #1 complete without a passing check?' },
  ],
};
const gate: Escalation = {
  id: 'merge-gate:t2:1',
  kind: 'merge-gate',
  task: { id: 't2', ref: '#2', title: 'Redeploy' },
  reason: 'Task #2 waits at its merge gate.',
  options: [{ id: 'merge-all', label: 'Merge all' }],
};

const runView = (escalations?: Escalation[]): RunView => ({ tasks: [], runMerge: null, handoff: null, mergeResult: null, ...(escalations ? { escalations } : {}) });
const show = (...escalations: Escalation[]) => post({ type: 'runView', view: runView(escalations) });
const inbox = () => screen.queryByRole('region', { name: /waiting on you/i });

describe('the escalation inbox', () => {
  beforeEach(() => {
    render(<App />);
    api.postMessage.mockClear();
  });

  it('lists each escalation with its task, its reason and its options, under a count', () => {
    show(failed, gate);

    const region = inbox()!;
    expect(within(region).getByText('2 waiting on you')).toBeTruthy();
    const entries = within(region).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(within(entries[0]).getByText('#1 Add rate limiting')).toBeTruthy();
    expect(within(entries[0]).getByText('Task #1 failed on attempt 2.')).toBeTruthy();
    for (const name of ['Retry', 'Skip', 'Mark complete']) expect(within(entries[0]).getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    expect(within(entries[1]).getByRole('button', { name: /Merge all/ })).toBeTruthy();
  });

  it('sends an option as an answer to that escalation, and shows it sending until the host replies', () => {
    show(failed, gate);

    fireEvent.click(screen.getByRole('button', { name: 'Retry: #1 Add rate limiting' }));

    const sent = api.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'answerEscalation');
    expect(sent).toMatchObject({ type: 'answerEscalation', id: 'failed:t1:2', option: 'retry' });
    expect(sent).not.toHaveProperty('confirmed');
    expect(screen.queryByRole('button', { name: 'Retry: #1 Add rate limiting' })).toBeNull();
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Sending: Retry');

    post({ type: 'escalationAnswered', requestId: sent.requestId, id: sent.id, ok: true });
    expect(screen.getByRole('button', { name: 'Retry: #1 Add rate limiting' })).toBeTruthy();
  });

  it('is operable from the keyboard: every control is a focusable button with a name, and Esc closes a question', () => {
    show(failed);
    const region = inbox()!;

    const buttons = within(region).getAllByRole('button');
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect((button as HTMLButtonElement).type).toBe('button');
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button.tabIndex).toBeGreaterThanOrEqual(0);
      expect(button.getAttribute('aria-label') ?? button.textContent).toBeTruthy();
    }
    const bar = within(region).getByRole('button', { name: '1 waiting on you' });
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(bar);
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(region.querySelector('.escalation-inbox-body')!.hasAttribute('hidden')).toBe(true);
    fireEvent.click(bar);

    fireEvent.click(screen.getByRole('button', { name: 'Mark complete: #1 Add rate limiting' }));
    const yes = screen.getByRole('button', { name: 'Yes, Mark complete' });
    expect(document.activeElement).toBe(yes);
    fireEvent.keyDown(yes, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Yes, Mark complete' })).toBeNull();
    expect(api.postMessage.mock.calls.some(([m]) => m.type === 'answerEscalation')).toBe(false);
  });

  it('asks an option\'s question first and sends the yes with the answer', () => {
    show(failed);

    fireEvent.click(screen.getByRole('button', { name: 'Mark complete: #1 Add rate limiting' }));
    expect(api.postMessage.mock.calls.some(([m]) => m.type === 'answerEscalation')).toBe(false);
    expect(screen.getByText('Mark #1 complete without a passing check?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Mark complete' }));

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'answerEscalation', option: 'complete', confirmed: true }));
  });

  it('takes a required note before it sends', () => {
    show({ ...gate, options: [{ id: 'reply', label: 'Reply', note: 'required' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Reply: #2 Redeploy' }));
    const send = screen.getByRole('button', { name: 'Reply' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Note (required)'), { target: { value: ' use the staging key ' } });
    fireEvent.click(send);

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'answerEscalation', option: 'reply', note: 'use the staging key' }));
  });

  it('opens the task: the plan dock expands with its card open', () => {
    post({ type: 'planUpdated', plan: {
      tasks: [{ id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai', status: 'failed', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build', prompt: 'add it' }],
      generatedAt: '', lastUpdated: '', status: 'draft', runners: ['claude-code'],
    } });
    show(failed);

    fireEvent.click(screen.getByRole('button', { name: 'Open task #1 Add rate limiting' }));

    expect(document.querySelector('.plan-dock.expanded')).toBeTruthy();
    expect(document.querySelector('.plan-dock-body')!.hasAttribute('hidden')).toBe(false);
  });

  it('shows nothing when nothing waits, or when an older daemon sent no list', () => {
    post({ type: 'runView', view: runView() });
    expect(inbox()).toBeNull();
    show();
    expect(inbox()).toBeNull();
    show(gate);
    expect(inbox()).toBeTruthy();
    show();
    expect(inbox()).toBeNull();
  });

  it('shows a stale refusal in the host\'s words after its entry has left the list', () => {
    show(failed);
    fireEvent.click(screen.getByRole('button', { name: 'Skip: #1 Add rate limiting' }));
    const sent = api.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'answerEscalation');

    show();
    post({ type: 'escalationAnswered', requestId: sent.requestId, id: sent.id, ok: false, message: 'That is no longer waiting on you: nothing was changed.' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Not done — Skip: #1 Add rate limiting');
    expect(alert.textContent).toContain('That is no longer waiting on you: nothing was changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Skip: #1 Add rate limiting' }));
    expect(inbox()).toBeNull();
  });

  it('leaves the composer as it is: enabled, with its queued messages stacked directly above it', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['also cover caching'] });
    const input = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    const placeholder = input.placeholder;

    show(failed, gate);

    const pending = document.querySelector('.pending-messages')!;
    expect(document.querySelector('.chat-input-row textarea')).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe(placeholder);
    expect(pending.querySelector('.pending-message-state')!.textContent).toBe('queued');
    expect(pending.nextElementSibling!.classList.contains('chat-input')).toBe(true);
    // The inbox is earlier in the column, so the queue and composer keep their bottom edge.
    expect(inbox()!.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
