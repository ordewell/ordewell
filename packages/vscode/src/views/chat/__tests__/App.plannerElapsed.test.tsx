import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge, post } from './hostBridge';

/** The planner's working row ends with how long its turn has run (#81). */
const startedAt = '2026-10-30T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000);
const started: SessionMessage = { type: 'planner_turn_started', turnId: 't-1', prompt: 'add a parser', startedAt };
const ended: SessionMessage = { type: 'planner_turn_ended', turnId: 't-1', outcome: 'message' };
const time = () => document.querySelector('.chat-msg-working .chat-msg-working-time')?.textContent ?? undefined;
const row = () => document.querySelector('.chat-msg-working')?.textContent ?? '';

describe('the planner row\'s elapsed time', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(42));
    render(<App />);
    host = hostBridge();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('counts from when the host says the turn began', () => {
    host.session(started);
    expect(time()).toBe('42s');

    act(() => { vi.advanceTimersByTime(3000); });
    expect(time()).toBe('45s');
  });

  it('is gone with the turn', () => {
    host.session(started, ended);
    expect(document.querySelector('.chat-msg-working')).toBeNull();
    expect(time()).toBeUndefined();
  });

  it('says what a turn waits for before any planner has heard of it, with no time to count', () => {
    post({ type: 'plannerTurn', active: true });
    host.session({ type: 'planner_detection', waiting: true });

    expect(row()).toContain('Detecting coding agents…');
    expect(row()).not.toContain('Working');
    expect(time()).toBeUndefined();

    host.session({ type: 'planner_detection', waiting: false });
    expect(row()).toContain('Working');
  });

  it('shows the wait in a webview that opened after it began, once the turn is out', () => {
    host.session({ type: 'planner_detection', waiting: true });
    host.provider.conversation.resync();
    const input = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    act(() => { fireEvent.change(input, { target: { value: 'add a parser' } }); });
    act(() => { fireEvent.click(document.querySelector('.send-btn') as Element); });

    expect(row()).toContain('Detecting coding agents…');
  });

  it('goes back to work once a turn opens, whatever of the answer was lost', () => {
    post({ type: 'plannerTurn', active: true });
    host.session({ type: 'planner_detection', waiting: true }, started);

    expect(row()).toContain('Working');
  });

  it('shows the working row without a time for a turn the host did not date', () => {
    host.session({ ...started, startedAt: undefined });
    expect(document.querySelector('.chat-msg-working')).not.toBeNull();
    expect(time()).toBeUndefined();
  });
});
