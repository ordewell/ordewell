import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import type { DisplayBlock } from '@ordewell/core';
import App, { type ChatLayout, type TaskSelection } from '../App';
import { ChatBridgeContext } from '../../bridge';
import type { HostToWebview, WebviewToHost } from '../../shared/protocol';
import { testBridge } from '../../test/hostApi';
import { api, post } from './webview';

const bridge = testBridge<WebviewToHost, HostToWebview>();

function mount(layout: ChatLayout, extra: { selection?: TaskSelection; goal?: string } = {}) {
  return render(<ChatBridgeContext.Provider value={bridge}><App layout={layout} {...extra} /></ChatBridgeContext.Provider>);
}

const now = new Date().toISOString();
const task = (id: string, order: number, over: Record<string, unknown> = {}) => ({
  id, order, title: `Task ${order}`, description: `Do ${order}`, type: 'ai' as const, status: 'pending' as const,
  dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build', ...over,
});
const plan = (status: 'draft' | 'approved', tasks = [task('a', 1), task('b', 2, { dependencies: ['a'] })]) => ({
  tasks, generatedAt: now, status, runners: ['claude-code'], lastUpdated: now,
});

const said: DisplayBlock[] = [
  { type: 'message', id: 'm1', role: 'user', text: 'Add a greeting', streaming: false },
  { type: 'message', id: 'm2', role: 'assistant', text: 'Here is a plan.', streaming: false },
];
const converse = () => post({ type: 'conversationPatch', order: said.map((b) => b.id), changed: said });

describe('App — the desktop planner tab (docs/desktop/design.md, W2/W3)', () => {
  beforeEach(() => api.post.mockClear());

  it('names each speaker and closes the setup once there is a conversation', () => {
    mount('conversation');
    expect(screen.getByRole('button', { name: /Settings/ }).getAttribute('aria-expanded')).toBe('true');
    converse();
    expect(document.querySelector('.chat-msg-user .chat-msg-speaker')?.textContent).toBe('You');
    expect(document.querySelector('.chat-msg-planner .chat-msg-speaker')?.textContent).toBe('Planner');
    expect(screen.getByRole('button', { name: /Settings/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('starts the next session with its own setup and an empty composer', () => {
    mount('conversation');
    converse();
    const settings = () => screen.getByRole('button', { name: /Settings/ });
    fireEvent.click(settings());
    expect(settings().getAttribute('aria-expanded')).toBe('true');
    const composer = () => screen.getByRole('textbox', { name: 'Message the planner' }) as HTMLTextAreaElement;
    fireEvent.change(composer(), { target: { value: 'half-typed for the last session' } });

    post({ type: 'restoreChat' });
    post({ type: 'conversationPatch', order: [], changed: [] });
    expect(settings().getAttribute('aria-expanded')).toBe('true');
    expect(composer().value).toBe('');

    // The open setup was chosen in the last session: this one closes it once it converses.
    converse();
    expect(settings().getAttribute('aria-expanded')).toBe('false');
  });

  it('answers a draft at the foot of the conversation: approve starts it, ask for changes goes to the composer', () => {
    mount('conversation');
    converse();
    post({ type: 'planUpdated', plan: plan('draft') });
    const card = screen.getByRole('region', { name: 'Plan approval' });
    expect(within(card).getByRole('heading').textContent).toContain('2 tasks · 1 runner');

    fireEvent.click(within(card).getByRole('button', { name: 'Ask for changes' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message the planner' }));

    fireEvent.click(within(card).getByRole('button', { name: /Approve plan/ }));
    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendSystemCommand', command: 'executePlan' }));
  });

  it('offers no approval once the plan is approved', () => {
    mount('conversation');
    post({ type: 'planUpdated', plan: plan('approved') });
    expect(screen.queryByRole('region', { name: 'Plan approval' })).toBeNull();
  });

  it('keeps VS Code’s sidebar as it was: no speaker names and no approval card', () => {
    mount('chat');
    converse();
    post({ type: 'planUpdated', plan: plan('draft') });
    expect(document.querySelector('.chat-msg-speaker')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Plan approval' })).toBeNull();
  });
});

describe('App — the desktop plan panel (docs/desktop/design.md, W4)', () => {
  beforeEach(() => api.post.mockClear());

  it('says there is no plan yet in the design’s words', () => {
    mount('plan');
    expect(screen.getByText('No plan yet. Describe a goal to the planner.')).toBeTruthy();
  });

  it('heads the plan with its goal, draws compact rows, and selects a task from its row without opening a tab', () => {
    const onChange = vi.fn();
    const onOpen = vi.fn();
    mount('plan', { goal: 'Greet the user', selection: { taskId: null, onChange, onOpen } });
    post({ type: 'planUpdated', plan: plan('draft') });

    expect(screen.getByText('Greet the user')).toBeTruthy();
    const rows = document.querySelectorAll('.task-heading');
    expect(rows).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Execute Plan' })).toBeNull();

    fireEvent.click(rows[1]);
    expect(onChange).toHaveBeenCalledWith('b');
    expect(onOpen).not.toHaveBeenCalled();
  });
});
