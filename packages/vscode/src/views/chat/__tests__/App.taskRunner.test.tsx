import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from '../App';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

const plan = {
  tasks: [{
    id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const,
    status: 'pending' as const, dependencies: [], subtasks: [],
    assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'default',
    assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' },
  }],
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
  act(() => { fireEvent.click(screen.getByText('Only task')); });
  api.postMessage.mockClear();
}

describe('per-task runner change', () => {
  beforeEach(setup);

  it('offers the installed runners on the task card', () => {
    const select = screen.getByLabelText('Runner') as HTMLSelectElement;

    expect([...select.options].map((o) => o.text)).toEqual(['Claude Code', 'Codex']);
  });

  it('posts the chosen runner to the host for that task', () => {
    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sendMessage',
      text: JSON.stringify({ runner: 'codex' }),
      actionContext: { type: 'execute', taskId: 't1' },
    }));
  });

  it('shows the new runner immediately without waiting for the host to echo back', () => {
    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });

    expect((screen.getByLabelText('Runner') as HTMLSelectElement).value).toBe('codex');
  });

  it('does not optimistically invent a model or mode for the new runner', () => {
    // Only the host knows the new runner's catalog. Guessing here would show a
    // model that cannot be spawned until the real plan arrives.
    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });

    expect(screen.getByText(/Claude Sonnet 4\.5/)).toBeTruthy();
  });
});
