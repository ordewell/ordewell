import { describe, it, expect, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { Task } from '@ordewell/core';
import { createFakeWebviewPanel } from '../../test/vscode.mock';
import { TaskLogPanel, type TaskLogSession } from '../TaskLogPanel';
import type { HostToTaskLog } from '../../shared/taskLogProtocol';

// The plan stores a runner for every task it holds, whatever its type.
const task = (over: Partial<Task>): Task => ({
  id: 't1', order: 1, title: 'Ship it', description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'opencode', ...over,
});

function openedStatus(t: Task) {
  const panel = createFakeWebviewPanel('ordewell.taskLog', 'Task log');
  const session = {
    taskLogAttempts: () => [], taskLog: () => [], outstandingApprovals: () => [], execute: vi.fn(), invokeTaskCommand: vi.fn(),
  } as unknown as TaskLogSession;
  new TaskLogPanel(panel as unknown as vscode.WebviewPanel, t.id, { session, getTask: () => t, openFile: () => undefined, log: () => undefined }, { toString: () => 'file:///ext' } as unknown as vscode.Uri, () => undefined);
  panel.__receive({ type: 'ready' });
  const init = panel.webview.postMessage.mock.calls.map(([m]) => m as HostToTaskLog).find((m) => m.type === 'init');
  if (init?.type !== 'init') throw new Error('the panel posted no init');
  return init.status;
}

describe('the task log tab names the runner of an AI task only', () => {
  it('names it on an AI task', () => {
    expect(openedStatus(task({})).runner).toBe('opencode');
  });

  it.each([
    ['script', { type: 'script' as const, commands: [['git', 'push']] }],
    ['manual', { type: 'user' as const }],
  ])('names none on a %s task', (_kind, over) => {
    expect(openedStatus(task(over)).runner).toBe('');
  });
});

describe('the task log tab tells the webview what its activity line needs', () => {
  it('sends the plan task\'s status, and that the runner is not quiet', () => {
    const status = openedStatus(task({ status: 'in_progress' }));
    expect(status.taskStatus).toBe('in_progress');
    expect(status.idleSince).toBeNull();
  });
});
