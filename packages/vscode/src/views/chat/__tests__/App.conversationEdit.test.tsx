import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import type { ResearchLogEntry, SerializedConversationMessage, SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, openActivity, post as send } from './hostBridge';

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
  '/refresh', '/planner', '/key', '/sessions', '/allowlist', '/help', '/new',
  '/fork', '/rewind', '/compact', '/settings', '/inbox',
];

describe('App — a compaction folds into the conversation where it happened', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  const SUMMARY = 'Conversation condensed: the summary below stands in for the earlier messages.\n\nWe agreed on a REST API.';
  const history: SerializedConversationMessage[] = [
    { role: 'user', content: 'the goal', timestamp: '2026-01-01T00:00:00Z' },
    { role: 'assistant', content: 'Which framework?', timestamp: '2026-01-01T00:00:02Z' },
    { role: 'user', content: 'a message about to be condensed', timestamp: '2026-01-01T00:00:03Z' },
    { role: 'assistant', content: 'REST it is.', timestamp: '2026-01-01T00:00:05Z' },
  ];
  const research: ResearchLogEntry[] = [
    { id: 'rs-1', tool: 'read_file', args: '{"path":"api.ts"}', result: 'export {}', success: true, outcome: 'success', timestamp: '2026-01-01T00:00:01Z' },
  ];
  const at = '2026-01-01T00:01:00Z';
  const started: SessionMessage = { type: 'planner_compaction', compaction: { phase: 'started', id: 'c1', origin: 'ordewell', trigger: 'manual', at } };
  const ended = (outcome: 'condensed' | 'stopped'): SessionMessage => ({
    type: 'planner_compaction', compaction: { phase: 'ended', id: 'c1', origin: 'ordewell', trigger: 'manual', outcome, at: '2026-01-01T00:01:09Z' },
  });
  const committed: SessionMessage = {
    type: 'plan_generated', goal: 'the goal', runners: ['claude-code'],
    plan: { tasks: [], runners: ['claude-code'], generatedAt: at, conversationHistory: [
      ...history,
      { role: 'assistant', content: SUMMARY, timestamp: '2026-01-01T00:01:08Z', kind: 'compaction', checkpoint: { id: 'c1', keptFrom: 2, trigger: 'manual' } },
    ] },
  };
  const statusText = () => screen.getAllByRole('status').map((el) => el.textContent ?? '').join(' | ');
  const markers = () => document.querySelectorAll('.conversation > .compaction-row');

  it('says it is compacting, then leaves a quiet marker, keeping every message, the draft, the task output and what was open', () => {
    host.provider.restoreChat({ conversationHistory: history, researchLog: research });
    send({ type: 'planUpdated', plan });
    send({ type: 'taskOutput', taskId: 't1', text: 'still running output' });
    openActivity();
    fireEvent.change(textarea(), { target: { value: 'a draft in progress' } });

    host.session(started);
    expect(statusText()).toContain('Compacting context…');
    expect(markers()).toHaveLength(1);

    host.session(ended('condensed'), committed);
    expect(statusText()).not.toContain('Compacting context…');
    expect(markers()).toHaveLength(1);
    const marker = markers()[0] as HTMLElement;
    expect(marker.textContent).toContain('Context compacted');
    // Quiet: the summary is there to open, never shown whole.
    expect(screen.queryByText(/We agreed on a REST API/)).toBeNull();
    expect(screen.getByText('a message about to be condensed')).toBeTruthy();
    expect(screen.getByText('REST it is.')).toBeTruthy();
    expect(textarea().value).toBe('a draft in progress');
    expect(document.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Only task')).toBeTruthy();
    expect(document.body.textContent).toContain('still running output');

    fireEvent.click(within(marker).getByRole('button', { name: /Context compacted/ }));
    expect(within(marker).getByText(/We agreed on a REST API/)).toBeTruthy();
  });

  it('stops from the composer while it runs, and says it stopped with nothing changed', () => {
    host.provider.restoreChat({ conversationHistory: history });
    host.session(started);
    api.postMessage.mockClear();

    fireEvent.click(screen.getByTitle('Stop (Esc Esc)'));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopResearch' });

    host.session(ended('stopped'));
    expect(markers()[0].textContent).toContain('Compaction stopped · nothing changed');
    expect(screen.queryByTitle('Stop (Esc Esc)')).toBeNull();
  });

  it('queues a message sent while it runs, for once it is over', () => {
    host.provider.restoreChat({ conversationHistory: history });
    host.session(started);
    api.postMessage.mockClear();

    fireEvent.change(textarea(), { target: { value: 'and auth?' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'holdPrompt', text: 'and auth?' });
  });

  it('shows a compaction still running to a webview that reconnects, and folds its end into the same marker', () => {
    host.provider.restoreChat({ conversationHistory: history });
    host.session(started);
    cleanup();

    render(<App />);
    host.provider.conversation.resync();
    expect(statusText()).toContain('Compacting context…');
    expect(screen.getByTitle('Stop (Esc Esc)')).toBeTruthy();

    host.session(ended('condensed'), committed, started, ended('condensed'), committed);
    expect(markers()).toHaveLength(1);
    expect(markers()[0].textContent).toContain('Context compacted');
  });

  it('shows a harness planner\'s own compaction from its end alone, with only the sizes it reported', () => {
    host.provider.restoreChat({ conversationHistory: history });
    host.session(
      { type: 'planner_turn_started', turnId: 't1', prompt: 'keep going' },
      { type: 'planner_compaction', turnId: 't1', compaction: { phase: 'ended', id: 'n1', origin: 'native', trigger: 'auto', outcome: 'condensed', at, preTokens: 150_000, postTokens: 9_000 } },
    );

    expect(markers()).toHaveLength(1);
    expect(markers()[0].textContent).toBe('The planner compacted its context on its own · 150k → 9k tokens');
    expect(statusText()).not.toContain('Compacting context…');
    expect(within(markers()[0] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('reopens a session condensed by an older build on the same quiet marker', () => {
    host.provider.restoreChat({ conversationHistory: [
      { role: 'assistant', content: SUMMARY, timestamp: '2026-01-01T00:00:00Z', kind: 'compaction' },
      { role: 'user', content: 'and auth?', timestamp: '2026-01-01T00:00:01Z' },
    ] });

    expect(markers()).toHaveLength(1);
    expect(markers()[0].textContent).toContain('Context compacted');
    expect(screen.queryByText(/We agreed on a REST API/)).toBeNull();
    expect(screen.getByText('and auth?')).toBeTruthy();
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
