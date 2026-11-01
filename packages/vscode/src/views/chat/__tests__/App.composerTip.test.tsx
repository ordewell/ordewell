import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge, post as send } from './hostBridge';

const TURN = 'turn-1';
const turnStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN, prompt: 'plan it' };
const turnEnded: SessionMessage = { type: 'planner_turn_ended', turnId: TURN, outcome: 'ask' };
const askedAQuestion: SessionMessage = { type: 'planner_message', content: 'Which database should I use?', timestamp: '2026-11-01T00:00:00.000Z', turnId: TURN };
const usage: SessionMessage = {
  type: 'planner_usage', turnId: TURN, totals: { inputTokens: 1_234, outputTokens: 56 },
  contextFill: { usedTokens: 700, windowTokens: 10_000 },
};
const planWithTask = {
  tasks: [{
    id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
    status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
    taskMode: 'build',
  }],
  generatedAt: '2026-11-01T00:00:00.000Z',
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: '2026-11-01T00:00:00.000Z',
};

const placeholder = () => (document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement).placeholder;
const replyHint = () => document.querySelector('.chat-input-hint')?.textContent ?? null;

// An idle planner chat shows a command tip where it used to show a generic
// prompt (#137); a placeholder that says what is happening now stays.
describe('the planner chat composer tip', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('shows a tip in a new, empty planner chat', () => {
    expect(placeholder()).toBe('Tip: Use /allowlist to limit which models the planner assigns per runner.');
  });

  it('keeps the queue instruction while a planner turn runs, and shows a tip again once it ends', () => {
    host.session(turnStarted);
    expect(placeholder()).toBe('Queue a message for when the planner is done...');
    host.session(turnEnded);
    expect(placeholder()).toMatch(/^Tip: Use \//);
  });

  it('keeps the reply cue when the planner has just spoken, without taking the tip away', () => {
    expect(replyHint()).toBeNull();
    host.session(turnStarted, askedAQuestion, turnEnded);
    expect(placeholder()).toMatch(/^Tip: Use \//);
    expect(replyHint()).toBe('Reply to the planner');
    // It is part of the accessible description as well as drawn (#137).
    expect(document.querySelector('.chat-input-row textarea')).toHaveAccessibleDescription(/Reply to the planner$/);
  });

  it('keeps the reply cue when the turn reports usage last, as a real turn does', () => {
    host.session(turnStarted, askedAQuestion, usage, turnEnded);
    expect(placeholder()).toMatch(/^Tip: Use \//);
    expect(replyHint()).toBe('Reply to the planner');
    expect(document.querySelector('.chat-input-row textarea')).toHaveAccessibleDescription(/Reply to the planner$/);
  });

  it('drops the reply cue as soon as the user starts typing', () => {
    host.session(turnStarted, askedAQuestion, turnEnded);
    const field = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Postgres' } });
    // The tip and the cue belong to an empty composer only.
    expect(replyHint()).toBeNull();
    expect(field).toHaveAccessibleDescription('');
  });

  it('shows no reply cue during the next turn or after the user has spoken again', () => {
    host.session(turnStarted, askedAQuestion, usage, turnEnded);
    expect(replyHint()).toBe('Reply to the planner');
    host.session({ type: 'planner_turn_started', turnId: 'turn-2', prompt: 'Postgres' });
    expect(placeholder()).toBe('Queue a message for when the planner is done...');
    expect(replyHint()).toBeNull();
    host.session({ type: 'planner_turn_ended', turnId: 'turn-2', outcome: 'error' });
    expect(placeholder()).toMatch(/^Tip: Use \//);
    expect(replyHint()).toBeNull();
  });

  it('shows no reply cue once a plan exists', () => {
    host.session(turnStarted, askedAQuestion, usage, turnEnded);
    expect(replyHint()).toBe('Reply to the planner');
    send({ type: 'planUpdated', plan: planWithTask });
    expect(replyHint()).toBeNull();
    expect(placeholder()).toMatch(/^Tip: Use \//);
  });
});
