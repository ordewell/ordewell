import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, fireEvent, screen } from '@testing-library/react';
import App from '../App';

const api = (globalThis as unknown as { __vscodeApi: { postMessage: ReturnType<typeof vi.fn> } }).__vscodeApi;

function send(msg: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const task = (over: Record<string, unknown>) => ({
  description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [],
  assignedRunner: 'claude-code', taskMode: 'build', ...over,
});

const plan = (tasks: unknown[]) => ({
  tasks,
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
});

const catalog = [
  { name: 'tdd', description: 'Test first' },
  { name: 'api-conventions', description: 'House API style' },
];

describe('App — task skill chips', () => {
  beforeEach(() => {
    api.postMessage.mockClear();
    render(<App />);
    send({ type: 'setTaskSkills', skills: catalog });
  });

  it('attaches a skill from the + skill select', () => {
    send({ type: 'planUpdated', plan: plan([task({ id: 't1', order: 1, title: 'Build it', skills: ['tdd'] })]) });
    fireEvent.click(screen.getByText('Build it'));

    const select = document.querySelector<HTMLSelectElement>('#task-skill-t1')!;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'api-conventions']);
    fireEvent.change(select, { target: { value: 'api-conventions' } });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'editTask', taskId: 't1', edit: { kind: 'skills', skills: ['tdd', 'api-conventions'] } });
  });

  it('detaches a skill with its ×', () => {
    send({ type: 'planUpdated', plan: plan([task({ id: 't1', order: 1, title: 'Build it', skills: ['tdd', 'api-conventions'] })]) });
    fireEvent.click(screen.getByText('Build it'));

    fireEvent.click(screen.getByLabelText('Remove skill tdd'));

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'editTask', taskId: 't1', edit: { kind: 'skills', skills: ['api-conventions'] } });
  });

  it('edits a subtask the same way', () => {
    const sub = task({ id: 's1', order: 1, title: 'Sub work', skills: ['tdd'] });
    send({ type: 'planUpdated', plan: plan([task({ id: 't1', order: 1, title: 'Parent', subtasks: [sub] })]) });
    fireEvent.click(screen.getByText('Parent'));
    fireEvent.click(screen.getByText('Sub work'));

    fireEvent.click(screen.getByLabelText('Remove skill tdd'));

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'editTask', taskId: 's1', edit: { kind: 'skills', skills: [] } });
  });

  it('shows chips read-only while the plan runs', () => {
    send({ type: 'planUpdated', plan: { ...plan([task({ id: 't1', order: 1, title: 'Build it', status: 'in_progress', skills: ['tdd'] })]), status: 'running' } });
    fireEvent.click(screen.getByText('Build it'));

    expect(screen.getByText('tdd')).toBeTruthy();
    expect(screen.queryByLabelText('Remove skill tdd')).toBeNull();
    expect(document.querySelector('#task-skill-t1')).toBeNull();
  });
});
