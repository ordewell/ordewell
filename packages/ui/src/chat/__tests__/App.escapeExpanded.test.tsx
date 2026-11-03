import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import App from '../../test/ChatApp';
import { api, post } from './webview';

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const posted = () => api.post.mock.calls.map(([msg]) => msg as { type: string });
const expandedCards = () => document.querySelectorAll('.task-card.expanded').length;
const header = () => document.querySelector('.task-card-header') as HTMLElement;

const task = {
  id: 't1', order: 1, title: 'Setup', description: '', prompt: 'set it up', type: 'ai' as const,
  status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
  taskMode: 'default', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' },
};

describe('Esc with a task card expanded', () => {
  beforeEach(() => {
    render(<App />);
    post({
      type: 'planUpdated',
      plan: {
        tasks: [task], generatedAt: new Date().toISOString(), status: 'draft',
        runners: ['claude-code'], lastUpdated: new Date().toISOString(),
      },
    });
    fireEvent.click(header());
    api.post.mockClear();
  });

  it('collapses the card from the input and does nothing else, then arms the stop on the next Esc', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one'] });
    type('draft');
    expect(expandedCards()).toBe(1);

    fireEvent.keyDown(textarea(), { key: 'Escape' });

    expect(expandedCards()).toBe(0);
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted()).toEqual([]);
    expect(textarea().value).toBe('draft');

    fireEvent.keyDown(textarea(), { key: 'Escape' });

    expect(api.post).toHaveBeenCalledWith({ type: 'unsendPrompt' });
    expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
  });

  it('collapses the card from outside the input too, without arming a stop', () => {
    post({ type: 'plannerTurn', active: true });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(expandedCards()).toBe(0);
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('collapses from a card header outside a turn, keeping the input text', () => {
    type('draft');

    fireEvent.keyDown(header(), { key: 'Escape' });

    expect(expandedCards()).toBe(0);
    expect(textarea().value).toBe('draft');
  });

  it('leaves the card open when Esc cancels its prompt editor', () => {
    post({ type: 'plannerTurn', active: true });
    fireEvent.click(document.querySelector('.task-prompt-editable') as HTMLElement);
    const editor = document.querySelector('.task-prompt-textarea') as HTMLTextAreaElement;
    expect(editor).not.toBeNull();

    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(document.querySelector('.task-prompt-textarea')).toBeNull();
    expect(expandedCards()).toBe(1);
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('keeps the planner semantics once no card is expanded', () => {
    fireEvent.click(header());
    post({ type: 'plannerTurn', active: true });

    fireEvent.keyDown(textarea(), { key: 'Escape' });

    expect(document.querySelector('.stop-hint')).not.toBeNull();
  });
});
