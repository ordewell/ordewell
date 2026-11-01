import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge } from './hostBridge';

const TURN = 'turn-1';
const turnStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN, prompt: 'plan it' };
const turnEnded: SessionMessage = { type: 'planner_turn_ended', turnId: TURN, outcome: 'plan' };

const placeholder = () => (document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement).placeholder;

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
});
