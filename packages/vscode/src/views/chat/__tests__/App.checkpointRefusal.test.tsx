import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import App from '../App';
import { post as send } from './hostBridge';

vi.mock('@ordewell/core/plan-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core/plan-utils')>();
  return { ...real, get DELEGATION_OFFERED() { return true; } };
});
const task = { id: 'd1', title: 'Import ledger', type: 'delegated', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Round half up or to even?', subtasks: [] };
const view = { type: 'runView' as const, view: { tasks: [task], runMerge: null, handoff: null, mergeResult: null } };
const plan = { tasks: [{ id: 'd1', order: 1, title: 'Import ledger', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build' }], generatedAt: new Date().toISOString(), status: 'draft' as const, runners: ['claude-code'], lastUpdated: new Date().toISOString() };

function asked() {
  render(<App />);
  send({ type: 'planUpdated', plan } as never);
  send(view as never);
}
const card = () => document.querySelector('.checkpoint-panel');
const refusal = (over: Record<string, string> = {}) => ({ type: 'checkpointRefused', taskId: 'd1', question: task.checkpoint, error: 'The budget is spent.', ...over });
const approve = () => fireEvent.click(document.querySelector('.checkpoint-approve-btn')!);

describe('a refused answer to the root checkpoint', () => {
  it('brings the card back with the words and the raise that were typed', () => {
    asked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up.' } });
    fireEvent.change(screen.getByLabelText(/Raise its budget/), { target: { value: '700000' } });
    approve();
    expect(card()).toBeNull();

    send(refusal() as never);

    expect(card()).not.toBeNull();
    expect(screen.getByLabelText('Your answer')).toHaveValue('Half up.');
    expect(screen.getByLabelText(/Raise its budget/)).toHaveValue('700000');
  });

  it('brings back an open rejection with its reason', () => {
    asked();
    fireEvent.click(document.querySelector('.checkpoint-reject-btn')!);
    fireEvent.change(screen.getByPlaceholderText(/Why are you rejecting/), { target: { value: 'Wrong rounding.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Rejection' }));
    expect(card()).toBeNull();

    send(refusal() as never);

    expect(screen.getByPlaceholderText(/Why are you rejecting/)).toHaveValue('Wrong rounding.');
  });

  it('stays shut when the run view still carries an answer the host took', () => {
    asked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up.' } });
    approve();
    send(view as never);
    expect(card()).toBeNull();
  });

  it('does not bring back a question that has gone, or one that was not the refused task', () => {
    asked();
    approve();
    send(refusal({ taskId: 'another' }) as never);
    expect(card()).toBeNull();
    send({ type: 'runView', view: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } as never);
    send(refusal() as never);
    expect(card()).toBeNull();
  });

  it('starts a question asked again blank, once the earlier one left', () => {
    asked();
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Half up.' } });
    approve();
    send({ type: 'runView', view: { tasks: [], runMerge: null, handoff: null, mergeResult: null } } as never);
    send(view as never);
    expect(screen.getByLabelText('Your answer')).toHaveValue('');
  });
});
