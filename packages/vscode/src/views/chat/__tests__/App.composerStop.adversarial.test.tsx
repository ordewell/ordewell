import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, post } from './hostBridge';

/**
 * Adversarial sweep of the composer's single button against every combination
 * its two inputs can take: a planner turn live or not, a run executing or not,
 * text empty / typed / whitespace, a held prompt, a slash command, the planner
 * compacting. The button owns the planner and never the run.
 */
const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};
const running = { ...plan, status: 'running' as const, tasks: [{ ...plan.tasks[0], status: 'in_progress' as const }] };

const TURN = 'turn-1';
const turnStarted = (prompt = 'why is task 1 slow?'): SessionMessage => ({ type: 'planner_turn_started', turnId: TURN, prompt });
const turnEnded = (): SessionMessage => ({ type: 'planner_turn_ended', turnId: TURN, outcome: 'message' });

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const sendBtn = () => document.querySelector('.send-btn') as HTMLButtonElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const press = (key: string, ctrlKey = false) => fireEvent.keyDown(textarea(), { key, ctrlKey });
const posted = () => api.postMessage.mock.calls.map(([m]) => m as { type: string; command?: string; text?: string });
const stops = () => posted().filter((m) => m.type === 'stopResearch' || m.command === 'stopExecution');
const isStopSquare = () => sendBtn().classList.contains('processing');
const title = () => sendBtn().getAttribute('title');

describe('the composer button over every planner/run combination', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
    api.postMessage.mockClear();
  });

  it('is an inert arrow with an idle planner and an executing run', () => {
    post({ type: 'planUpdated', plan: running });

    expect(isStopSquare()).toBe(false);
    expect(sendBtn().disabled).toBe(true);
    expect(title()).toBe('Send (Enter)');

    fireEvent.click(sendBtn());
    press('Enter');

    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('shows the square and stops the turn when the turn is live with an executing run', () => {
    post({ type: 'planUpdated', plan: running });
    host.session(turnStarted());

    expect(isStopSquare()).toBe(true);
    expect(title()).toBe('Stop (Esc Esc)');

    fireEvent.click(sendBtn());

    expect(stops()).toEqual([expect.objectContaining({ type: 'stopResearch' })]);
  });

  it('does not stop the run on Enter with nothing typed and an idle planner', () => {
    post({ type: 'planUpdated', plan: running });
    api.postMessage.mockClear();

    press('Enter');

    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('keeps whitespace-only text as the turn\'s square, but never the run\'s', () => {
    host.session(turnStarted());
    type('   ');

    expect(isStopSquare()).toBe(true);
    fireEvent.click(sendBtn());
    expect(stops()).toEqual([expect.objectContaining({ type: 'stopResearch' })]);

    api.postMessage.mockClear();
    host.session(turnEnded());
    post({ type: 'planUpdated', plan: running });

    // Whitespace is not a message: the arrow stays inert and posts nothing.
    expect(isStopSquare()).toBe(false);
    expect(sendBtn().disabled).toBe(true);
    fireEvent.click(sendBtn());
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('sends (never stops) typed text while the run executes and the planner is idle', () => {
    post({ type: 'planUpdated', plan: running });
    type('how is it going?');

    expect(isStopSquare()).toBe(false);
    expect(sendBtn().disabled).toBe(false);
    fireEvent.click(sendBtn());

    expect(posted()).toEqual([expect.objectContaining({ type: 'sendMessage', text: 'how is it going?' })]);
    expect(stops()).toEqual([]);
  });

  it('queues with Enter and force sends with Ctrl+Enter during a live turn with a run', () => {
    post({ type: 'planUpdated', plan: running });
    host.session(turnStarted());

    type('also cover caching');
    press('Enter');
    type('use Postgres');
    press('Enter', true);

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'holdPrompt', text: 'also cover caching' }));
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendMessageNow', text: 'use Postgres' }));
    expect(stops()).toEqual([]);
  });

  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
  ])('sends the held prompts now on %s with an empty composer during a live turn with a run', (_key, mods) => {
    post({ type: 'planUpdated', plan: running });
    host.session(turnStarted());
    type('also cover caching');
    press('Enter');
    host.provider.conversation.holdPrompt('also cover caching');
    host.provider.conversation.flush();
    expect(textarea().value).toBe('');

    fireEvent.keyDown(textarea(), { key: 'Enter', ...mods });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendMessageNow', text: '' });
    expect(stops()).toEqual([]);
  });

  it('sends a typed slash command while the run executes and the planner is idle', () => {
    post({ type: 'planUpdated', plan: running });
    type('/refresh');
    expect(isStopSquare()).toBe(false);

    press('Enter');

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendMessage', text: '/refresh' }));
    expect(stops()).toEqual([]);
  });

  it('stops the planner compacting, never the run, and Esc Esc does too', () => {
    const compacting: SessionMessage = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'manual', at: '2026-01-01T00:00:00Z' } };
    post({ type: 'planUpdated', plan: running });
    host.session(compacting);

    expect(isStopSquare()).toBe(true);
    fireEvent.click(sendBtn());
    expect(stops()).toEqual([{ type: 'stopResearch' }]);

    api.postMessage.mockClear();
    host.session(compacting);
    press('Escape');
    press('Escape');
    expect(stops()).toEqual([{ type: 'stopResearch' }]);
  });

  it('leaves the second stop click a no-op: the square is gone at once', () => {
    host.session(turnStarted());

    fireEvent.click(sendBtn());
    expect(stops()).toHaveLength(1);
    expect(isStopSquare()).toBe(false);

    fireEvent.click(sendBtn());
    expect(stops()).toHaveLength(1);
  });

  it('never halts the run on Esc or Esc Esc, even with a live turn', () => {
    post({ type: 'planUpdated', plan: running });
    host.session(turnStarted());
    type('a draft that should survive');

    press('Escape');
    press('Escape');

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopResearch' });
    expect(stops().some((m) => m.command === 'stopExecution')).toBe(false);
    expect(textarea().value).toBe('a draft that should survive');
  });

  it('clears a draft on Esc with an idle planner and an executing run, posting nothing', () => {
    post({ type: 'planUpdated', plan: running });
    type('never mind');

    press('Escape');

    expect(textarea().value).toBe('');
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('keeps the plan pane\'s Stop the one that halts the run', () => {
    post({ type: 'planUpdated', plan: running });

    act(() => { fireEvent.click(screen.getByText('Stop')); });

    expect(stops()).toEqual([expect.objectContaining({ type: 'sendSystemCommand', command: 'stopExecution' })]);
  });

  it('stops the turn and never the run with a prompt queued behind it', () => {
    post({ type: 'planUpdated', plan: running });
    post({ type: 'heldPrompts', prompts: ['also cover caching'] });
    host.session(turnStarted());
    api.postMessage.mockClear();

    fireEvent.click(sendBtn());

    expect(stops()).toEqual([expect.objectContaining({ type: 'stopResearch' })]);
    expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'unsendPrompt' }));
  });

  it('becomes an inert arrow, unarmed, when the turn ends under it', () => {
    host.session(turnStarted());
    press('Escape');
    expect(document.querySelector('.stop-hint')).not.toBeNull();
    expect(isStopSquare()).toBe(true);

    host.session(turnEnded());

    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(isStopSquare()).toBe(false);
    expect(sendBtn().disabled).toBe(true);

    fireEvent.click(sendBtn());
    press('Enter');
    expect(api.postMessage.mock.calls.map(([m]) => (m as { type: string }).type)).not.toContain('stopResearch');
  });
});
