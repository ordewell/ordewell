import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DisplayBlock } from '@ordewell/core';
import App from '../../test/ChatApp';
import { api, post } from './webview';

const GOAL = 'Add greeting and farewell modules';
const FAILURE = '400 review: the planner refused this turn on purpose';

const sent = () => api.post.mock.calls.map(([message]) => message as { type: string; text?: string; typed?: boolean });

/** The first turn as the conversation keeps it: the goal, then the failure the turn ended on. */
function failedFirstTurn(): void {
  const blocks: DisplayBlock[] = [
    { type: 'message', id: 'm1', role: 'user', text: GOAL, streaming: false },
    { type: 'message', id: 'm2', role: 'error', text: FAILURE, streaming: false },
  ];
  post({ type: 'conversationPatch', order: blocks.map((b) => b.id), changed: blocks });
}

/** First-run review F10, F13: a first turn that failed, as the desktop draws it. */
describe('a planner turn that failed', () => {
  beforeEach(() => {
    api.post.mockClear();
    render(<App />);
  });

  it('shows its error once, after the message it belongs to', () => {
    failedFirstTurn();
    post({ type: 'showError', error: FAILURE, resend: GOAL });

    const shown = screen.getAllByText(FAILURE);
    expect(shown).toHaveLength(1);
    const goal = screen.getByText(GOAL);
    expect(goal.compareDocumentPosition(shown[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(goal.compareDocumentPosition(screen.getByRole('button', { name: 'Try Again' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends the failed message again on Try Again', () => {
    failedFirstTurn();
    post({ type: 'showError', error: FAILURE, resend: GOAL });

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

    expect(sent()).toContainEqual(expect.objectContaining({ type: 'sendMessage', text: GOAL, typed: true }));
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
  });
});
