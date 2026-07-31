import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from '../App';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

function makeTask(id: string, order: number, title: string, dependencies: string[] = []) {
  return {
    id, order, title, description: '', type: 'ai' as const, status: 'pending' as const,
    dependencies, subtasks: [], assignedRunner: 'claude-code', completionMarker: `m${order}`,
    taskMode: 'default',
    assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' },
  };
}

const plan = {
  tasks: [makeTask('t1', 1, 'Setup'), makeTask('t2', 2, 'Build', ['t1'])],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

function setup() {
  render(<App />);
  send({ type: 'setRunners', runners: [
    { id: 'claude-code', displayName: 'Claude Code', enabled: true },
    { id: 'codex', displayName: 'Codex', enabled: true },
  ] });
  send({ type: 'planUpdated', plan });
  api.postMessage.mockClear();
}

function depOption(title: string): HTMLElement | null {
  const label = [...document.querySelectorAll('.task-dep-option')].find((l) => l.textContent?.includes(title));
  return (label?.querySelector('input') as HTMLElement | undefined) ?? null;
}

describe('per-task removal', () => {
  beforeEach(setup);

  it('reaches the host, which owns the confirmation', () => {
    // The regression this covers: a webview `confirm()` is sandboxed away, so
    // the click used to post nothing at all.
    act(() => { fireEvent.click(screen.getAllByTitle('Remove task')[1]); });

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sendMessage',
      text: '',
      actionContext: { type: 'execute', taskId: 't2' },
    }));
  });

  it('keeps the card until the host confirms and echoes a new plan', () => {
    act(() => { fireEvent.click(screen.getAllByTitle('Remove task')[1]); });

    expect(screen.getByText('Build')).toBeTruthy();
  });
});

describe('per-task dependency editing', () => {
  beforeEach(setup);

  it('posts the new list for that task', () => {
    act(() => { fireEvent.click(screen.getByText('Build')); });
    act(() => { fireEvent.click(screen.getByTitle('Edit dependencies')); });
    act(() => { fireEvent.click(depOption('Setup')!); });

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sendMessage',
      text: JSON.stringify({ dependencies: [] }),
      actionContext: { type: 'execute', taskId: 't2' },
    }));
  });

  it('offers only the tasks that come before it', () => {
    act(() => { fireEvent.click(screen.getByText('Build')); });
    act(() => { fireEvent.click(screen.getByTitle('Edit dependencies')); });

    expect(depOption('Setup')).toBeTruthy();
    expect(depOption('Build')).toBeNull();
  });
});

describe('adding a task by hand', () => {
  beforeEach(setup);

  it('offers the button at the end of the plan', () => {
    expect(screen.getByText('+ Add task')).toBeTruthy();
  });

  it('posts the draft with the default runner and every existing task as a candidate dependency', () => {
    act(() => { fireEvent.click(screen.getByText('+ Add task')); });
    act(() => { fireEvent.change(screen.getByPlaceholderText('Task title'), { target: { value: 'Docs' } }); });
    act(() => { fireEvent.click(depOption('Build')!); });
    act(() => { fireEvent.click(screen.getByText('Add task')); });

    const posted = api.postMessage.mock.calls
      .map((c) => c[0] as { actionContext?: { type: string }; text?: string })
      .find((m) => m.actionContext?.type === 'addTask')!;

    expect(JSON.parse(posted.text!)).toMatchObject({
      title: 'Docs',
      prompt: 'Docs',
      assignedRunner: 'claude-code',
      dependencies: ['t2'],
    });
  });
});
