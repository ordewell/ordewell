import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { createEmptyPlan, createTask, type LegacyPlanState, type SerializedTask, type SessionMessage } from '@ordewell/core';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import { handleSessionMessage, type PlanManagerDeps } from '../PlanManager';

vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners: ((e: unknown) => void)[] = [];
    event = (fn: (e: unknown) => void) => { this.listeners.push(fn); return { dispose() {} }; };
    fire(e: unknown) { for (const fn of this.listeners) fn(e); }
  },
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  commands: { executeCommand: vi.fn() },
}));

function planned(id: string, order: number): SerializedTask {
  return {
    id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
  };
}

function setup() {
  const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  const posted: Array<{ type: string; [key: string]: unknown }> = [];
  provider.resolveWebviewView({
    show: vi.fn(), onDidDispose: () => ({ dispose() {} }),
    webview: { options: {}, html: '', cspSource: '', asWebviewUri: (u: unknown) => u, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: (msg: { type: string }) => { posted.push(msg); return Promise.resolve(true); } },
  } as unknown as vscode.WebviewView, {} as never, {} as never);
  let plan: LegacyPlanState = { ...createEmptyPlan(), status: 'draft', tasks: [createTask({ id: 't1' })] };
  const session = { isExecuting: false, status: 'approved' as 'approved' | 'running' | 'completed', planState: undefined as LegacyPlanState | undefined, activity: undefined };
  const d = {
    session,
    chatProvider: provider,
    getCurrentPlan: () => plan,
    setCurrentPlan: (next: LegacyPlanState) => { plan = next; },
    persistState: vi.fn(),
    isGeneratingPlan: () => false,
  } as unknown as PlanManagerDeps;
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  const send = (msg: SessionMessage) => { posted.length = 0; handleSessionMessage(msg, d); sent.push(...posted); };
  return { send, session, sent };
}

/**
 * A status tick posts the plan only when the dock's status moved, and the
 * Session patches a task's fields on the plan object it already holds, so the
 * webview learns of the patch from `task_updated` alone.
 */
describe('a task field the session patches in place', () => {
  it('reaches the webview after a model follow (task_updated, then a status tick)', () => {
    const { send, session, sent } = setup();
    const plan = { ...createEmptyPlan(), status: 'approved' as const, tasks: [createTask({ id: 't1', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet' } })] };
    session.planState = plan;
    send({ type: 'plan_generated', plan: { tasks: [planned('t1', 1)], runners: ['claude-code'], generatedAt: 'x' }, goal: 'g', runners: ['claude-code'] } as unknown as SessionMessage);
    session.isExecuting = true; session.status = 'running';
    send({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] });
    sent.length = 0;
    // The Session writes the followed model into its own plan object (plan.tasks = store.snapshot()).
    plan.tasks = [{ ...plan.tasks[0], assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } }];
    send({ type: 'task_updated', taskId: 't1', changes: { assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } } });
    send({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null, idleSince: '2026-01-01' }] } as unknown as SessionMessage);
    const shown = sent.filter((m) => m.type === 'planUpdated').at(-1) as { plan: { tasks: Array<{ assignedModel?: { modelId: string } }> } } | undefined;
    expect(shown?.plan.tasks[0].assignedModel?.modelId).toBe('claude-haiku-4-5');
  });
});
