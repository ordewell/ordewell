import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App, { type ChatLayout } from '../App';
import { ChatBridgeContext } from '../../bridge';
import type { HostToWebview, WebviewToHost } from '../../shared/protocol';
import { testBridge } from '../../test/hostApi';
import { api, post } from './webview';

const bridge = testBridge<WebviewToHost, HostToWebview>();

/** The desktop's plan panel keeps its open card in the host's selection, so the test holds it as the host would. */
function PlanPanel({ layout }: { layout: ChatLayout }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const selection = layout === 'plan' ? { taskId, onChange: setTaskId, onOpen: vi.fn() } : undefined;
  return <ChatBridgeContext.Provider value={bridge}><App layout={layout} selection={selection} /></ChatBridgeContext.Provider>;
}

const now = new Date().toISOString();
const handoff = { summary: '\nKept the token scoped.\nMore context.', findings: [], findingCount: 3 };
const tasks = [
  { id: 'a', order: 1, title: 'Scope the token', description: 'Scope it', type: 'ai', status: 'pending', dependencies: [], subtasks: [],
    assignedRunner: 'claude-code', taskMode: 'build', prompt: 'Read src/token.ts first.\nThen narrow its scope.' },
  { id: 'b', order: 2, title: 'Review the token', description: 'Review it', type: 'ai', status: 'completed', attempted: true, dependencies: ['a'],
    subtasks: [], assignedRunner: 'claude-code', taskMode: 'build', prompt: 'Review the scope.', handoff },
];

function show(layout: ChatLayout): void {
  render(<PlanPanel layout={layout} />);
  post({ type: 'planUpdated', plan: { tasks, generatedAt: now, lastUpdated: now, status: 'approved', runners: ['claude-code'] } });
  api.post.mockClear();
}

const heading = (title: string) => screen.getAllByRole('button').find((b) => b.classList.contains('task-heading') && b.textContent === title)!;
const card = (title: string) => heading(title).closest('.task-card') as HTMLElement;
const fold = (title: string, label: 'Prompt' | 'Handoff') => within(card(title)).getByRole('button', { name: new RegExp(`^${label}`) });

afterEach(() => { vi.restoreAllMocks(); });

describe.each<ChatLayout>(['chat', 'plan'])('a task card in the %s layout', (layout) => {
  beforeEach(() => show(layout));

  it('opens from its heading and closes when the heading is clicked again', () => {
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(heading('Scope the token'));
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'true');
    expect(card('Scope the token').querySelector('.task-card-body')).not.toBeNull();

    fireEvent.click(heading('Scope the token'));
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'false');
    expect(card('Scope the token').querySelector('.task-card-body')).toBeNull();
  });

  it('toggles from anywhere on its header, but not from a control in it or while text is selected', () => {
    const header = card('Scope the token').querySelector('.task-card-header') as HTMLElement;
    fireEvent.click(header);
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(header);
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'false');

    // Selecting a title to copy it is a drag that ends in a click; it leaves the card as it was.
    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent.click(header);
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a click inside the open body from closing the card', () => {
    fireEvent.click(heading('Scope the token'));
    const body = card('Scope the token').querySelector('.task-card-body') as HTMLElement;
    fireEvent.click(body);
    fireEvent.click(fold('Scope the token', 'Prompt'));
    fireEvent.click(within(body).getByRole('button', { name: /^Edit task prompt:/ }));
    fireEvent.click(within(body).getByRole('textbox'));
    expect(heading('Scope the token')).toHaveAttribute('aria-expanded', 'true');
  });

  it('starts its prompt and handoff folded to one line, each opening to the whole', () => {
    fireEvent.click(heading('Review the token'));
    const prompt = fold('Review the token', 'Prompt');
    const digest = fold('Review the token', 'Handoff');
    expect(prompt).toHaveAttribute('aria-expanded', 'false');
    expect(digest).toHaveAttribute('aria-expanded', 'false');
    expect(digest).toHaveTextContent('Kept the token scoped. · 3 findings');
    expect(card('Review the token').querySelector('.task-handoff')).toBeNull();
    expect(card('Review the token').querySelector('.task-prompt')).toBeNull();

    fireEvent.click(digest);
    expect(digest).toHaveAttribute('aria-expanded', 'true');
    expect(card('Review the token').querySelector('.task-handoff-summary')).toHaveTextContent('Kept the token scoped. More context.');
    expect(heading('Review the token')).toHaveAttribute('aria-expanded', 'true');

    // The handoff is the task's own report: it reads, and nothing in it edits.
    const opened = card('Review the token').querySelector('.task-fold-handoff .task-fold-body') as HTMLElement;
    expect(within(opened).queryByRole('textbox')).toBeNull();
    expect(opened.querySelector('[contenteditable="true"], input, select')).toBeNull();

    fireEvent.click(prompt);
    expect(prompt).toHaveAttribute('aria-expanded', 'true');
    expect(card('Review the token').querySelector('.task-fold-prompt .task-fold-body')).toHaveTextContent('Review the scope.');
  });

  it('folds them again each time the card opens', () => {
    fireEvent.click(heading('Review the token'));
    fireEvent.click(fold('Review the token', 'Handoff'));
    fireEvent.click(heading('Review the token'));
    fireEvent.click(heading('Review the token'));
    expect(fold('Review the token', 'Handoff')).toHaveAttribute('aria-expanded', 'false');
  });

  it('edits the prompt once it is unfolded, previewing its first line until then', () => {
    fireEvent.click(heading('Scope the token'));
    const prompt = fold('Scope the token', 'Prompt');
    expect(prompt).toHaveTextContent('Read src/token.ts first.');
    expect(prompt).not.toHaveTextContent('Then narrow its scope.');
    expect(within(card('Scope the token')).queryByRole('button', { name: /^Edit task prompt:/ })).toBeNull();

    fireEvent.click(prompt);
    fireEvent.click(within(card('Scope the token')).getByRole('button', { name: /^Edit task prompt:/ }));
    const editor = within(card('Scope the token')).getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'Narrow the scope.' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(api.post).toHaveBeenCalledWith({ type: 'editTask', taskId: 'a', edit: { kind: 'prompt', prompt: 'Narrow the scope.' } });
  });
});
