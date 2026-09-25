import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, screen, fireEvent } from '@testing-library/react';
import App from '../App';

function send(msg: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'build' }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;

describe('App — rewind and compact redraw the transcript', () => {
  beforeEach(() => render(<App />));

  it('replaces the transcript but keeps the plan and its task output', () => {
    send({ type: 'restoreChat', hasPlan: true, history: [
      { role: 'user', content: 'the goal', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'user', content: 'a message about to be rewound', timestamp: '2026-01-01T00:00:01Z' },
    ] });
    send({ type: 'planUpdated', plan });
    send({ type: 'taskOutput', taskId: 't1', text: 'still running output' });

    send({ type: 'conversationReplaced', hasPlan: true, history: [
      { role: 'user', content: 'the goal', timestamp: '2026-01-01T00:00:00Z' },
    ] });

    expect(screen.queryByText('a message about to be rewound')).toBeNull();
    expect(screen.getByText('the goal')).toBeTruthy();
    expect(screen.getByText('Only task')).toBeTruthy();
    expect(document.body.textContent).toContain('still running output');
  });

  it('shows a compaction summary as a visible notice, not as something the planner just said', () => {
    send({ type: 'conversationReplaced', hasPlan: false, history: [
      { role: 'assistant', content: 'Conversation condensed: …\n\nWe agreed on a REST API.', timestamp: '2026-01-01T00:00:00Z', kind: 'compaction' },
      { role: 'user', content: 'and auth?', timestamp: '2026-01-01T00:00:01Z' },
    ] });

    const notice = screen.getByText(/We agreed on a REST API/);
    expect(notice.closest('.chat-msg-system')).toBeTruthy();
  });

  it('locks the input while a compaction runs and frees it after', () => {
    send({ type: 'conversationBusy', busy: true });
    expect(textarea().disabled).toBe(true);

    send({ type: 'conversationBusy', busy: false });
    expect(textarea().disabled).toBe(false);
  });

  it('lists fork, rewind and compact in /help', () => {
    fireEvent.change(textarea(), { target: { value: '/help' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    const shown = document.body.textContent ?? '';
    for (const command of ['/fork', '/rewind', '/compact']) expect(shown).toContain(command);
  });
});
