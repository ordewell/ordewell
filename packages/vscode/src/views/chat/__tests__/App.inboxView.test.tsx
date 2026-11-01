import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Escalation, RunView } from '@ordewell/core';
import App from '../App';
import { INBOX_VIEW_DEFAULT } from '../inboxView';
import { ALL_SLASH_COMMANDS, slashHelp } from '../../../commands/slashCommands';
import { api, post } from './hostBridge';

/**
 * How the escalation inbox (ADR-0053) shares the panel: it starts as its one-line
 * bar, remembers open or closed, gives way to the plan dock, and `/inbox` turns the
 * view off and on. Layout itself (the composer staying in the panel) is the
 * stylesheet's, checked in a real browser: jsdom has no layout.
 */

const failed: Escalation = {
  id: 'failed:t1:2',
  kind: 'failed',
  task: { id: 't1', ref: '#1', title: 'Add rate limiting' },
  attempt: 2,
  reason: 'Task #1 failed on attempt 2.',
  options: [{ id: 'retry', label: 'Retry' }, { id: 'reply', label: 'Reply', note: 'required' }],
};
const gate: Escalation = {
  id: 'merge-gate:t2:1',
  kind: 'merge-gate',
  task: { id: 't2', ref: '#2', title: 'Redeploy' },
  reason: 'Task #2 waits at its merge gate.',
  options: [{ id: 'merge-all', label: 'Merge all' }],
};

const runView = (escalations: Escalation[]): RunView => ({ tasks: [], runMerge: null, handoff: null, mergeResult: null, escalations });
const show = (...escalations: Escalation[]) => post({ type: 'runView', view: runView(escalations) });
const region = () => screen.queryByRole('region', { name: /waiting on you/i });
const bar = () => within(region()!).getByRole('button', { name: /waiting on you|not done/ });
const bodyHidden = () => region()!.querySelector('.escalation-inbox-body')!.hasAttribute('hidden');
const plan = (title = 'Add rate limiting') => post({ type: 'planUpdated', plan: {
  tasks: [{ id: 't1', order: 1, title, description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build', prompt: 'add it' }],
  generatedAt: '', lastUpdated: '', status: 'draft', runners: ['claude-code'],
} });
const dockOpen = () => !document.querySelector('.plan-dock-body')!.hasAttribute('hidden');
const say = (text: string) => {
  const input = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
};
const savedInbox = () => {
  const calls = api.setState.mock.calls;
  return (calls[calls.length - 1]?.[0] as { inbox?: unknown } | undefined)?.inbox;
};

describe('the inbox control on the usage line', () => {
  beforeEach(() => {
    api.getState.mockReset();
    api.setState.mockReset();
    api.postMessage.mockClear();
  });

  it('starts closed, saying how many wait, inside the usage line', () => {
    render(<App />);
    show(failed, gate);

    expect(bar().textContent).toBe('2 waiting');
    expect(bar().getAttribute('aria-expanded')).toBe('false');
    expect(bodyHidden()).toBe(true);
    expect(region()!.closest('.usage-line')).toBeTruthy();
  });

  it('draws the line with the control alone when there is no usage, and no line when nothing waits', () => {
    render(<App />);
    expect(document.querySelector('.usage-line')).toBeNull();

    show(gate);
    expect([...document.querySelector('.usage-line')!.children].map((c) => c.className)).toEqual(['escalation-inbox']);

    show();
    expect(document.querySelector('.usage-line')).toBeNull();
  });

  it('remembers open or closed across a reload', () => {
    const first = render(<App />);
    show(failed);
    fireEvent.click(bar());
    expect(savedInbox()).toMatchObject({ open: true });
    first.unmount();

    api.getState.mockReturnValue({ inbox: savedInbox() });
    render(<App />);
    show(failed);
    expect(bar().getAttribute('aria-expanded')).toBe('true');
    expect(bodyHidden()).toBe(false);
  });

  it('closes on Esc, and an Esc that closes a question leaves the list open', () => {
    render(<App />);
    show(failed);
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole('button', { name: 'Reply: #1 Add rate limiting' }));

    fireEvent.keyDown(screen.getByLabelText('Note (required)'), { key: 'Escape' });
    expect(screen.queryByLabelText('Note (required)')).toBeNull();
    expect(bodyHidden()).toBe(false);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(bodyHidden()).toBe(true);
    expect(document.activeElement).toBe(bar());
  });

  it('does not touch the plan dock, and keeps an answer being written when the list closes and opens again', () => {
    render(<App />);
    plan();
    show(failed);
    expect(dockOpen()).toBe(true);
    fireEvent.click(bar());
    expect(dockOpen()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Reply: #1 Add rate limiting' }));
    fireEvent.change(screen.getByLabelText('Note (required)'), { target: { value: 'use the staging key' } });
    fireEvent.click(bar());
    expect(bodyHidden()).toBe(true);
    fireEvent.click(bar());

    expect((screen.getByLabelText('Note (required)') as HTMLTextAreaElement).value).toBe('use the staging key');
  });

  it('keeps the control after the last entry leaves while a refusal is still to be read', () => {
    render(<App />);
    show(failed);
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole('button', { name: 'Retry: #1 Add rate limiting' }));
    const sent = api.postMessage.mock.calls.map(([m]) => m).find((m) => m.type === 'answerEscalation');

    show();
    post({ type: 'escalationAnswered', requestId: sent.requestId, id: sent.id, ok: false, message: 'No longer waiting.' });

    expect(bar().textContent).toBe('1 not done');
    expect(screen.getByRole('alert').textContent).toContain('No longer waiting.');
  });
});

describe('/inbox', () => {
  beforeEach(() => {
    api.getState.mockReset();
    api.setState.mockReset();
    api.postMessage.mockClear();
  });

  it('is on by default, from the one constant', () => {
    expect(INBOX_VIEW_DEFAULT).toBe(true);
    render(<App />);
    show(failed);
    expect(region()).toBeTruthy();
  });

  it('turns the view off without drawing it, and tells the chat once how to bring it back', () => {
    render(<App />);
    show(failed);

    say('/inbox');

    expect(region()).toBeNull();
    const notes = api.postMessage.mock.calls.map(([m]) => m).filter((m) => m.type === 'addNote');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('/inbox');
    expect(api.postMessage.mock.calls.some(([m]) => m.type === 'sendMessage')).toBe(false);

    show(failed, gate);
    expect(region()).toBeNull();
    expect(api.postMessage.mock.calls.filter(([m]) => m.type === 'addNote')).toHaveLength(1);
  });

  it('turns it back on with what waits now, and remembers either across a reload', () => {
    const first = render(<App />);
    show(failed);
    say('/inbox');
    expect(savedInbox()).toMatchObject({ enabled: false });
    first.unmount();

    api.getState.mockReturnValue({ inbox: savedInbox() });
    render(<App />);
    show(failed);
    expect(region()).toBeNull();

    show(failed, gate);
    say('/inbox');
    expect(bar().textContent).toBe('2 waiting');
    expect(savedInbox()).toMatchObject({ enabled: true });
  });

  it('leaves the task rows and the run view alone while it is off', () => {
    render(<App />);
    plan();
    say('/inbox');
    show(failed);

    expect(region()).toBeNull();
    expect(document.querySelector('.plan-dock')).toBeTruthy();
  });

  it('is listed with the other commands', () => {
    expect(ALL_SLASH_COMMANDS.map((c) => c.label)).toContain('/inbox');
    expect(slashHelp()).toContain('/inbox');
  });
});
