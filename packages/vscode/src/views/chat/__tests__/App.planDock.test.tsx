import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, fireEvent, screen } from '@testing-library/react';
import type { ConversationMessage, SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, post as send, rowKinds } from './hostBridge';

const t1 = {
  id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
  status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
  taskMode: 'build',
};
const t2 = { ...t1, id: 't2', order: 2, title: 'Return 429s' };

const marker = (content: string, timestamp: string): ConversationMessage => ({ role: 'assistant', content, timestamp, kind: 'plan_generated' });

/** How the session announces a plan: the transcript it carries gains a marker. */
const planGenerated = (...history: ConversationMessage[]): SessionMessage =>
  ({ type: 'plan_generated', plan: { conversationHistory: history }, goal: '', runners: [] }) as unknown as SessionMessage;

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
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  const first = marker('Plan generated with 1 task.', '2026-01-01T00:00:01Z');
  const second = marker('Plan updated — now 2 tasks.', '2026-01-01T00:00:03Z');

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
    host.session(planGenerated(first));
    send({ type: 'planUpdated', plan });
    host.session(planGenerated(first, second));
    send({ type: 'planUpdated', plan: { ...plan, tasks: [t1, t2] } });

    const chips = [...document.querySelectorAll('.plan-revision-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Plan generated · 1 task', 'Plan updated · 2 tasks']);
  });

  it('puts the revision chip after the message that caused it', () => {
    host.session({ type: 'planner_turn_started', turnId: 't', prompt: 'drop the last task' }, planGenerated(first));
    send({ type: 'planUpdated', plan });

    expect(rowKinds()).toEqual(['chat-msg', 'plan-revision-chip-row']);
  });

  it('does not chip or reopen for a status tick during execution', () => {
    host.session(planGenerated(first));
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
    host.session(planGenerated(first));
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

  it('dismisses the checkpoint panel and posts a reject action when rejected', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'checkpoint', taskId: 't1', taskTitle: 'Add rate limiting', summary: 'ready for review' });
    api.postMessage.mockClear();

    fireEvent.click(document.querySelector('.checkpoint-reject-btn')!);
    fireEvent.change(screen.getByPlaceholderText('Why are you rejecting this checkpoint?'), {
      target: { value: 'not the right approach' },
    });
    fireEvent.click(screen.getByText('Send Rejection'));

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'answerCheckpoint',
      taskId: 't1',
      approved: false,
      reason: 'not the right approach',
    }));
    // The whole point of rejecting is deciding; the box must not linger.
    expect(document.querySelector('.checkpoint-panel')).toBeNull();
  });

  it('replays one chip per persisted revision marker, in order', () => {
    host.provider.restoreChat({
      conversationHistory: [
        { role: 'user', content: 'add rate limiting', timestamp: '2026-01-01T00:00:00Z' },
        first,
        { role: 'user', content: 'split the last one', timestamp: '2026-01-01T00:00:02Z' },
        second,
      ],
    });

    expect(rowKinds()).toEqual(['chat-msg', 'plan-revision-chip-row', 'chat-msg', 'plan-revision-chip-row']);
    expect([...document.querySelectorAll('.plan-revision-chip')].map((c) => c.textContent)).toEqual(['Plan generated · 1 task', 'Plan updated · 2 tasks']);
  });

  it('takes the dock and the chips away with the session', () => {
    host.session(planGenerated(first));
    send({ type: 'planUpdated', plan });
    // What the host does for a new session.
    send({ type: 'setState', state: 'empty' });
    host.provider.conversation.reset();

    expect(document.querySelector('.plan-dock')).toBeNull();
    expect(document.querySelector('.plan-revision-chip')).toBeNull();
  });

  describe('resizing', () => {
    function sized(el: Element, box: { offset: number; client?: number; scroll?: number }): void {
      Object.defineProperty(el, 'offsetHeight', { configurable: true, value: box.offset });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.client ?? box.offset });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: box.scroll ?? box.offset });
    }
    // jsdom has no PointerEvent, and fireEvent's fallback drops clientY.
    function pointer(target: EventTarget, type: string, clientY = 0): void {
      act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientY })); });
    }
    const body = () => document.querySelector('.plan-dock-body') as HTMLElement;
    const handle = () => document.querySelector('.plan-dock-resize')!;

    beforeEach(() => {
      api.postMessage.mockClear();
      send({ type: 'planUpdated', plan });
      sized(body(), { offset: 200, scroll: 700 });
      const list = document.querySelector('.message-list') as HTMLElement;
      sized(list, { offset: 400 });
      // jsdom loads no stylesheet; this stands in for the list's CSS floor.
      list.style.minHeight = '56px';
    });

    it('drags the top edge up into the conversation and saves the height on release', () => {
      pointer(handle(), 'pointerdown', 500);
      pointer(document, 'pointermove', 350);
      expect(body().style.maxHeight).toBe('350px');
      expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanDockHeight' }));

      pointer(document, 'pointerup');
      expect(api.postMessage).toHaveBeenCalledWith({ type: 'setPlanDockHeight', height: 350 });
    });

    it('can cover nearly the whole conversation, keeping its floor', () => {
      pointer(handle(), 'pointerdown', 500);
      pointer(document, 'pointermove', -2000);
      pointer(document, 'pointerup');

      expect(api.postMessage).toHaveBeenCalledWith({ type: 'setPlanDockHeight', height: 200 + 400 - 56 });
    });

    it('does not save anything for a click that never moved', () => {
      pointer(handle(), 'pointerdown', 500);
      pointer(document, 'pointerup');

      expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanDockHeight' }));
    });

    it('opens at the height the host remembered', () => {
      send({ type: 'planDockHeight', height: 420 });
      expect(body().style.maxHeight).toBe('420px');
    });

    it('offers no handle while the dock is collapsed', () => {
      fireEvent.click(document.querySelector('.plan-dock-bar')!);
      expect(document.querySelector('.plan-dock-resize')).toBeNull();
    });
  });
});
