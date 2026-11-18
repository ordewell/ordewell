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

/**
 * The whole plan, history included, is megabytes in a long session: it goes to
 * the webview when the plan changed, and a status tick reaches it as the run
 * view the webview folds.
 */
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
  const send = (msg: SessionMessage) => { posted.length = 0; handleSessionMessage(msg, d); return posted.map((m) => m.type); };
  return { send, session, posted, setPlan: (next: LegacyPlanState) => { plan = next; session.planState = next; } };
}

const tick: SessionMessage = { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }] };

describe('a status update in the extension host', () => {
  it('reaches the webview as the run view, without the plan', () => {
    const { send } = setup();
    send({ type: 'plan_generated', plan: { tasks: [planned('t1', 1)], runners: ['claude-code'], generatedAt: 'x' }, goal: 'g', runners: ['claude-code'] } as unknown as SessionMessage);

    const types = send(tick);

    expect(types).toContain('runView');
    expect(types).not.toContain('planUpdated');
  });

  it('sends the plan again when the run starts, so the dock says it is running', () => {
    const { send, session, posted } = setup();
    send({ type: 'plan_generated', plan: { tasks: [planned('t1', 1)], runners: ['claude-code'], generatedAt: 'x' }, goal: 'g', runners: ['claude-code'] } as unknown as SessionMessage);

    session.isExecuting = true;
    session.status = 'running';
    const types = send(tick);

    expect(types).toContain('planUpdated');
    expect(posted.find((m) => m.type === 'planUpdated')).toMatchObject({ plan: { status: 'running' } });
    expect(send(tick)).not.toContain('planUpdated');
  });

  it('still sends the whole plan for a generated plan, a new task and the end of a run', () => {
    const { send, session, setPlan } = setup();
    const generated = { type: 'plan_generated', plan: { tasks: [planned('t1', 1)], runners: ['claude-code'], generatedAt: 'x' }, goal: 'g', runners: ['claude-code'] } as unknown as SessionMessage;
    expect(send(generated)).toContain('planUpdated');

    setPlan({ ...createEmptyPlan(), status: 'draft', tasks: [createTask({ id: 't1' }), createTask({ id: 't2', order: 2 })] });
    expect(send(generated)).toContain('planUpdated');
    expect(send({ type: 'review_needed', tasks: [planned('t1', 1)] })).toContain('planUpdated');

    session.status = 'completed';
    expect(send({ type: 'execution_complete', summary: { completed: 1, failed: 0, skipped: 0, total: 1 } } as unknown as SessionMessage)).toContain('planUpdated');
  });

  it('sends the plan a regenerate turn swapped in, even on a status tick', () => {
    const { send, session, setPlan, posted } = setup();
    send(tick);
    setPlan({ ...createEmptyPlan(), status: 'draft', tasks: [createTask({ id: 't9' })] });
    session.status = 'approved';

    const types = send(tick);

    expect(types).toContain('planUpdated');
    expect(posted.find((m) => m.type === 'planUpdated')).toMatchObject({ plan: { tasks: [{ id: 't9' }] } });
  });
});
