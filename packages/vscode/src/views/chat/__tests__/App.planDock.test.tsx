import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import App from '../App';

function send(msg: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const t1 = {
  id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
  status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
  completionMarker: 'm1', taskMode: 'build',
};
const t2 = { ...t1, id: 't2', order: 2, title: 'Return 429s' };

const plan = {
  tasks: [t1],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

/**
 * The plan is a live, editable artifact, so it is mounted once in its own scroll
 * region rather than rendered as a chat message frozen at the point it was first
 * generated. The chat keeps a chip per revision pointing at it.
 */
describe('plan dock', () => {
  beforeEach(() => render(<App />));

  it('mounts the plan in the dock and never inside the scrolling message list', () => {
    send({ type: 'planUpdated', plan });

    expect(document.querySelector('.plan-dock .plan-card-group')).toBeTruthy();
    expect(document.querySelector('.message-list .plan-card-group')).toBeNull();
  });

  it('shows no dock at all before a plan exists', () => {
    expect(document.querySelector('.plan-dock')).toBeNull();
  });

  it('opens on the first plan and reports its size on the bar', () => {
    send({ type: 'planUpdated', plan });
    expect(document.querySelector('.plan-dock')!.classList.contains('expanded')).toBe(true);
    expect(document.querySelector('.plan-dock-summary')!.textContent).toBe('1 task');
  });

  it('drops a chip in the chat for the plan, and another for each revision', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'planUpdated', plan: { ...plan, tasks: [t1, t2] } });

    const chips = [...document.querySelectorAll('.plan-revision-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Plan generated · 1 task', 'Plan updated · 2 tasks']);
  });

  it('puts the revision chip after the message that caused it', () => {
    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'drop the last task' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    send({ type: 'planUpdated', plan });

    const rows = [...document.querySelectorAll('.message-list > *')];
    const userIdx = rows.findIndex((r) => r.classList.contains('chat-msg-user'));
    const chipIdx = rows.findIndex((r) => r.classList.contains('plan-revision-chip-row'));
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(chipIdx).toBeGreaterThan(userIdx);
  });

  it('does not chip or reopen for a status tick during execution', () => {
    send({ type: 'planUpdated', plan });
    fireEvent.click(document.querySelector('.plan-dock-bar')!);
    expect(document.querySelector('.plan-dock')!.classList.contains('collapsed')).toBe(true);

    // Execution ticks the same task through statuses — same shape, new status.
    send({ type: 'planUpdated', plan: { ...plan, status: 'running', tasks: [{ ...t1, status: 'in_progress' }] } });

    expect(document.querySelectorAll('.plan-revision-chip').length).toBe(1);
    expect(document.querySelector('.plan-dock')!.classList.contains('collapsed')).toBe(true);
  });

  it('hides the task cards behind the bar when collapsed, without unmounting them', () => {
    send({ type: 'planUpdated', plan });
    fireEvent.click(document.querySelector('.plan-dock-bar')!);

    expect(document.querySelector('.plan-dock-body')!.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.plan-dock-summary')!.textContent).toBe('1 task');
  });

  it('reopens the dock from a revision chip', () => {
    send({ type: 'planUpdated', plan });
    fireEvent.click(document.querySelector('.plan-dock-bar')!);
    expect(document.querySelector('.plan-dock')!.classList.contains('collapsed')).toBe(true);

    fireEvent.click(document.querySelector('.plan-revision-chip')!);
    expect(document.querySelector('.plan-dock')!.classList.contains('expanded')).toBe(true);
  });

  it('names a task blocked on the user even while the dock is collapsed', () => {
    send({ type: 'planUpdated', plan });
    fireEvent.click(document.querySelector('.plan-dock-bar')!);
    send({ type: 'checkpoint', taskId: 't1', taskTitle: 'Add rate limiting', summary: 'ready for review' });

    expect(document.querySelector('.plan-dock-approval')).toBeTruthy();
  });

  it('replays one chip per persisted revision marker, in order', () => {
    send({
      type: 'restoreChat',
      hasPlan: true,
      history: [
        { role: 'user', content: 'add rate limiting', timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
        { role: 'user', content: 'split the last one', timestamp: '2026-01-01T00:00:02Z' },
        { role: 'assistant', content: 'Plan updated — now 2 tasks.', timestamp: '2026-01-01T00:00:03Z', kind: 'plan_generated' },
      ],
    });

    // The trailing scroll sentinel is classless — it is not a timeline row.
    const kinds = [...document.querySelectorAll('.message-list > [class]')]
      .map((r) => (r.classList.contains('plan-revision-chip-row') ? 'chip' : 'msg'));
    expect(kinds).toEqual(['msg', 'chip', 'msg', 'chip']);
  });

  it('takes the dock and the chips away with the session', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'setState', state: 'empty' });

    expect(document.querySelector('.plan-dock')).toBeNull();
    expect(document.querySelector('.plan-revision-chip')).toBeNull();
  });
});
