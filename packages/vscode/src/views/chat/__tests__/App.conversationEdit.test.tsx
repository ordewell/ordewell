import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from '../App';
import { hostBridge, post as send } from './hostBridge';

const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;

// Every first word SlashParser answers, written out rather than read from it.
const HOST_COMMANDS = [
  '/refresh', '/model', '/planner', '/planner-effort', '/key', '/sessions', '/allowlist', '/help', '/new', '/auto',
  '/fork', '/rewind', '/compact', '/parallel',
];

describe('App — a compaction redraws the transcript', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('replaces the transcript but keeps the plan and its task output', () => {
    host.provider.restoreChat({ conversationHistory: [
      { role: 'user', content: 'the goal', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'user', content: 'a message about to be condensed', timestamp: '2026-01-01T00:00:01Z' },
    ] });
    send({ type: 'planUpdated', plan });
    send({ type: 'taskOutput', taskId: 't1', text: 'still running output' });

    host.provider.replaceConversation({ conversationHistory: [
      { role: 'user', content: 'the goal', timestamp: '2026-01-01T00:00:00Z' },
    ] });

    expect(screen.queryByText('a message about to be condensed')).toBeNull();
    expect(screen.getByText('the goal')).toBeTruthy();
    expect(screen.getByText('Only task')).toBeTruthy();
    expect(document.body.textContent).toContain('still running output');
  });

  it('shows a compaction summary as a visible notice, not as something the planner just said', () => {
    host.provider.replaceConversation({ conversationHistory: [
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

  it('lists every command the host answers in /help, not a copy that drifted', () => {
    fireEvent.change(textarea(), { target: { value: '/help' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    const shown = document.querySelector('.slash-output')?.textContent ?? '';
    for (const command of HOST_COMMANDS) expect(shown).toContain(command);
  });
});
