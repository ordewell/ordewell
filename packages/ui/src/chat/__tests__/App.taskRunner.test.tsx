import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from '../../test/ChatApp';

import { hostApi as api } from '../../test/hostApi';

function send(msg: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
}

const plan = {
  tasks: [{
    id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const,
    status: 'pending' as const, dependencies: [], subtasks: [],
    assignedRunner: 'claude-code', taskMode: 'default',
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
  api.post.mockClear();
}

describe('per-task runner change', () => {
  beforeEach(setup);

  it('offers the installed runners on the task card', () => {
    const select = screen.getByLabelText('Runner') as HTMLSelectElement;

    expect([...select.options].map((o) => o.text)).toEqual(['Claude Code', 'Codex']);
  });

  it('posts the chosen runner to the host for that task', () => {
    act(() => { fireEvent.change(screen.getByLabelText('Runner'), { target: { value: 'codex' } }); });

    expect(api.post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'editTask',
      taskId: 't1',
      edit: { kind: 'runner', runner: 'codex' },
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

describe('a task runner choice that is blocked (ADR-0052)', () => {
  beforeEach(() => {
    render(<App />);
    send({ type: 'setRunners', runners: [
      { id: 'cursor-agent', displayName: 'Cursor', enabled: true, readiness: { kind: 'blocked', why: 'signed-out' } },
      { id: 'claude-code', displayName: 'Claude Code', enabled: true, readiness: { kind: 'ready' } },
      { id: 'codex', displayName: 'Codex', enabled: true, readiness: { kind: 'sign-in-unknown' } },
    ] });
  });

  it('lists ready runners first, names the blocker, and refuses moving a task onto it', () => {
    send({ type: 'planUpdated', plan });
    act(() => { fireEvent.click(screen.getByText('Only task')); });
    const select = screen.getByLabelText('Runner') as HTMLSelectElement;

    expect([...select.options].map((o) => [o.text, o.disabled])).toEqual([
      ['Claude Code', false], ['Codex', false], ['Cursor — Signed out', true],
    ]);
  });

  it("keeps a task's own blocked runner selected, flagged, and its card editable", () => {
    send({ type: 'planUpdated', plan: { ...plan, tasks: [{ ...plan.tasks[0], assignedRunner: 'cursor-agent' }] } });
    act(() => { fireEvent.click(screen.getByText('Only task')); });
    const select = screen.getByLabelText('Runner') as HTMLSelectElement;

    expect(select.value).toBe('cursor-agent');
    expect([...select.options].find((o) => o.value === 'cursor-agent')?.disabled).toBe(false);
    expect([...select.options].find((o) => o.value === 'cursor-agent')?.text).toBe('Cursor — Signed out');
  });
});
