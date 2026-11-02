import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import App from '../App';
import { api, post as send } from './hostBridge';

/*
 * A delegated task's question on the checkpoint card (ADR-0056 M5, M8): the
 * answer's words and a raise of its budget travel with the approval, as the
 * TUI and the daemon send them. Plain tasks, and delegation not offered, keep
 * the plain card (ADR-0055 D21).
 */

const offered = vi.hoisted(() => ({ value: true }));
vi.mock('@ordewell/core/plan-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core/plan-utils')>();
  return { ...real, get DELEGATION_OFFERED() { return offered.value; } };
});

const task = (over: Record<string, unknown> = {}) => ({
  id: 'd1', title: 'Import ledger', type: 'delegated', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Round half up or to even?', subtasks: [], ...over,
});
const view = (t: Record<string, unknown>) => ({ type: 'runView' as const, view: { tasks: [t], runMerge: null, handoff: null, mergeResult: null } });
const plan = { tasks: [{ id: 'd1', order: 1, title: 'Import ledger', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }], generatedAt: new Date().toISOString(), status: 'draft' as const, runners: ['claude-code'], lastUpdated: new Date().toISOString() };

describe('the checkpoint card of a delegated task', () => {
  beforeEach(() => {
    offered.value = true;
    render(<App />);
    send({ type: 'planUpdated', plan } as never);
  });

  it('posts the answer\'s words and a raise with the approval, and goes', () => {
    send(view(task()) as never);
    api.postMessage.mockClear();

    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up.' } });
    fireEvent.change(screen.getByLabelText('Raise its budget by (tokens)'), { target: { value: '700000' } });
    fireEvent.click(document.querySelector('.checkpoint-approve-btn')!);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerCheckpoint', taskId: 'd1', question: 'Round half up or to even?', approved: true, reason: 'Half up.', raiseTokens: 700_000 });
    expect(document.querySelector('.checkpoint-panel')).toBeNull();
  });

  it('posts a plain approval when nothing is typed', () => {
    send(view(task()) as never);
    api.postMessage.mockClear();
    fireEvent.click(document.querySelector('.checkpoint-approve-btn')!);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'answerCheckpoint', taskId: 'd1', question: 'Round half up or to even?', approved: true });
  });

  it('is the plain card for a task that is not delegated', () => {
    send(view(task({ type: 'ai' })) as never);
    expect(screen.queryByLabelText('Your answer')).toBeNull();
  });

  it('is the plain card where delegation is not offered', () => {
    offered.value = false;
    send(view(task()) as never);
    expect(document.querySelector('.checkpoint-panel')).not.toBeNull();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.queryByLabelText('Raise its budget by (tokens)')).toBeNull();
  });
});
