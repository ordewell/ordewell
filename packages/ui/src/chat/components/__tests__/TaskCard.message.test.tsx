import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import { ChatBridgeContext, type ChatBridge } from '../../../bridge';
import { testBridge } from '../../../test/hostApi';
import TaskCard from '../TaskCard';
import type { Task } from '@ordewell/core';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'in_progress',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

/** A chat whose posts land in `post`, so the card's own requests can be read. */
const chatPosting = (post: ChatBridge['post']): ChatBridge => ({ ...testBridge(), post });

function renderCard(task: Task, handlers: { onSendMessage?: (id: string, text: string) => void; onSendMessageNow?: (id: string, text: string) => void } = {}) {
  return render(
    <TaskCard
      task={task}
      models={[]}
      isExecuting
      expanded
      onExpandedChange={() => {}}
      onSendMessage={handlers.onSendMessage}
      onSendMessageNow={handlers.onSendMessageNow}
    />,
  );
}

const box = () => document.querySelector('.task-message-box');
const input = () => document.querySelector('.task-message-input') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });

describe('messaging a running or waiting task from its card', () => {
  it('requests the task runner catalog and invokes its skill from the card', () => {
    const post = vi.fn();
    render(<ChatBridgeContext.Provider value={chatPosting(post)}>
      <TaskCard task={makeTask()} models={[]} isExecuting expanded onSendMessage={vi.fn()} onSendMessageNow={vi.fn()} />
    </ChatBridgeContext.Provider>);
    expect(post).toHaveBeenCalledWith({ type: 'getTaskCommands', taskId: 't1' });
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'taskCommands', taskId: 't1', commands: [{ name: 'review', kind: 'skill', description: 'Native review', argumentHint: '<files>' }],
    } })); });
    type('/');
    expect(screen.getByRole('listbox')).toHaveTextContent('Native review');
    fireEvent.click(screen.getByRole('option'));
    type('/review src');
    fireEvent.click(document.querySelector('.task-message-send')!);
    expect(post).toHaveBeenCalledWith({ type: 'invokeTaskCommand', taskId: 't1', name: 'review', args: 'src' });
  });

  it('resumes a task paused on a usage limit with the native slash text', () => {
    const post = vi.fn();
    const onSendMessage = vi.fn();
    render(<ChatBridgeContext.Provider value={chatPosting(post)}>
      <TaskCard task={makeTask({ status: 'awaiting_user', awaitingReason: 'usage-limit', runnerSessionId: 'session-1' })} run={{ continuable: true }} models={[]} isExecuting expanded onSendMessage={onSendMessage} onSendMessageNow={vi.fn()} />
    </ChatBridgeContext.Provider>);
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'taskCommands', taskId: 't1', commands: [{ name: 'compact', kind: 'builtin', description: 'Compact context' }],
    } })); });
    type('/compact keep tests');
    fireEvent.click(document.querySelector('.task-message-send')!);
    expect(onSendMessage).toHaveBeenCalledWith('t1', '/compact keep tests');
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'invokeTaskCommand' }));
  });

  it.each(['in_progress', 'awaiting_user'] as const)('offers a message box on a %s task', (status) => {
    renderCard(makeTask({ status, awaitingReason: status === 'awaiting_user' ? 'input' : undefined }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(box()).not.toBeNull();
  });

  it('hides the box on a task that is neither running nor waiting', () => {
    renderCard(makeTask({ status: 'pending' }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(box()).toBeNull();
  });

  it('hides the box on a manual task, which has no runner turn', () => {
    renderCard(makeTask({ type: 'user', status: 'in_progress' }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(box()).toBeNull();
  });

  it('sends a plain message through the task-log path on Send', () => {
    const onSendMessage = vi.fn();
    const onSendMessageNow = vi.fn();
    renderCard(makeTask(), { onSendMessage, onSendMessageNow });

    type('use Postgres');
    fireEvent.click(document.querySelector('.task-message-send')!);

    expect(onSendMessage).toHaveBeenCalledWith('t1', 'use Postgres');
    expect(onSendMessageNow).not.toHaveBeenCalled();
    expect(input().value).toBe('');
  });

  it('sends now on Ctrl+Enter or Cmd+Enter, with one Send button and no second one', () => {
    const onSendMessage = vi.fn();
    const onSendMessageNow = vi.fn();
    renderCard(makeTask(), { onSendMessage, onSendMessageNow });

    expect(screen.getAllByRole('button', { name: /send/i })).toHaveLength(1);
    type('stop now');
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true });
    type('and this too');
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });

    expect(onSendMessageNow.mock.calls).toEqual([['t1', 'stop now'], ['t1', 'and this too']]);
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('names both keys while a turn runs and something is typed, in a hint and on Send', () => {
    renderCard(makeTask(), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(document.querySelector('.send-key-hint')).toBeNull();

    type('use Postgres');

    expect(document.querySelector('.send-key-hint')?.textContent).toBe('Enter queue · Ctrl+Enter send all now');
    expect(document.querySelector('.task-message-send')?.getAttribute('title')).toBe('Queue (Enter) · Send all now (Ctrl+Enter)');
  });

  it('has no key hint on a task waiting for input, which has no turn to interrupt', () => {
    renderCard(makeTask({ status: 'awaiting_user', awaitingReason: 'input' }), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    type('use Postgres');
    expect(document.querySelector('.send-key-hint')).toBeNull();
    expect(document.querySelector('.task-message-send')?.getAttribute('title')).toBe('Send (Enter)');
  });

  it('sends a plain message on Enter', () => {
    const onSendMessage = vi.fn();
    const onSendMessageNow = vi.fn();
    renderCard(makeTask(), { onSendMessage, onSendMessageNow });

    type('a note');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onSendMessage).toHaveBeenCalledWith('t1', 'a note');
    expect(onSendMessageNow).not.toHaveBeenCalled();
  });

  it('disables Send with nothing typed', () => {
    renderCard(makeTask(), { onSendMessage: vi.fn(), onSendMessageNow: vi.fn() });
    expect(document.querySelector('.task-message-send')).toBeDisabled();
  });
});
