import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge } from './hostBridge';

const TURN = 'turn-1';
const turnStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN, prompt: 'plan it' };
const turnEnded: SessionMessage = { type: 'planner_turn_ended', turnId: TURN, outcome: 'plan' };

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const press = (key: string, ctrlKey = false) => fireEvent.keyDown(textarea(), { key, ctrlKey });
const working = () => document.querySelector('.chat-msg-working') !== null;
const posted = () => api.postMessage.mock.calls.map(([msg]) => msg as { type: string });

// Autorun and the planner's run tools start a run inside the turn that
// submitted the plan; a run or plan change is not that turn's end.
describe('a run started or stopped during a planner turn', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
    host.session(turnStarted);
    api.postMessage.mockClear();
  });

  it('keeps the planner busy when the run starts', () => {
    host.provider.planApproved();

    expect(working()).toBe(true);
    expect(textarea().placeholder).toBe('Queue a message for when the planner is done...');
  });

  it('still stops the turn on a double Esc after Stop Execution', () => {
    host.provider.planApproved();
    host.provider.setState('planDraft');

    expect(working()).toBe(true);
    press('Escape');
    press('Escape');

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopResearch' });
  });

  it('still queues and sends now after a plan update', () => {
    host.provider.planApproved();
    host.provider.showPlan({ status: 'running', tasks: [] });
    type('also cover caching');
    press('Enter');
    type('use Postgres');
    press('Enter', true);

    expect(working()).toBe(true);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'holdPrompt', text: 'also cover caching' });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendMessageNow', text: 'use Postgres' });
    expect(posted().some((m) => m.type === 'sendMessage')).toBe(false);
  });

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
  ])('sends the held prompts now on %s with the composer empty, while the run goes on', (_key, mods) => {
    host.provider.planApproved();
    host.provider.showPlan({ status: 'running', tasks: [] });
    host.provider.conversation.holdPrompt('also cover caching');
    host.provider.conversation.flush();

    fireEvent.keyDown(textarea(), { key: 'Enter', ...mods });

    expect(working()).toBe(true);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendMessageNow', text: '' });
  });

  it('frees the input when the turn ends, while the run goes on', () => {
    host.provider.planApproved();
    host.session(turnEnded);

    expect(working()).toBe(false);
    expect(textarea().placeholder).not.toBe('Queue a message for when the planner is done...');
  });
});

describe('a new session', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  // What the host's handleNewSession tells the webview, as the command palette's New Session.
  const newSessionFromHost = () => {
    host.provider.setState('empty');
    host.provider.conversation.reset();
    host.provider.run.reset();
  };

  it('ends the turn when started from the host mid-turn', () => {
    host.session(turnStarted);
    host.provider.planApproved();

    newSessionFromHost();

    expect(working()).toBe(false);
  });

  it('frees the input when started from the host before the sent prompt opened a turn', () => {
    type('plan it');
    press('Enter');
    expect(working()).toBe(true);

    newSessionFromHost();

    expect(working()).toBe(false);
  });

  // The host's reset stops a live run too, so the confirmation must not promise only the planner's turn.
  it('warns on /new during a run that the running tasks are stopped', () => {
    host.provider.planApproved();
    host.provider.showPlan({ status: 'running', tasks: [] });
    type('/new');
    press('Enter');

    expect(document.querySelector('.new-session-confirm-text')?.textContent).toContain('any running tasks are stopped');
    expect(posted().some((m) => m.type === 'newSession')).toBe(false);
  });

  it('ends the turn on /new in the chat', () => {
    host.session(turnStarted);
    host.provider.planApproved();
    type('/new');
    press('Enter');
    fireEvent.click(screen.getByText('New Session'));

    expect(working()).toBe(false);
  });
});
