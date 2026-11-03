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
    id: 't1', order: 1, title: 'Running task', description: '', type: 'ai' as const,
    status: 'in_progress' as const, dependencies: [], subtasks: [],
    assignedRunner: 'claude-code', taskMode: 'build',
  }],
  generatedAt: new Date().toISOString(),
  status: 'running' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

function setup() {
  render(<App />);
  send({ type: 'planUpdated', plan });
  act(() => { fireEvent.click(screen.getByText('Running task')); });
  api.post.mockClear();
}

const input = () => document.querySelector('.task-message-input') as HTMLTextAreaElement;

describe('messaging a running task from its plan card', () => {
  beforeEach(setup);

  it('sends a plain message, and a Ctrl+Enter one now, through the task-message routes', () => {
    fireEvent.change(input(), { target: { value: 'use Postgres' } });
    act(() => { fireEvent.click(document.querySelector('.task-message-send')!); });
    expect(api.post).toHaveBeenCalledWith({ type: 'sendTaskMessage', taskId: 't1', text: 'use Postgres' });

    fireEvent.change(input(), { target: { value: 'stop now' } });
    act(() => { fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true }); });
    expect(api.post).toHaveBeenCalledWith({ type: 'sendTaskMessageNow', taskId: 't1', text: 'stop now' });
  });
});
