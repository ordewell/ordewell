import { vi } from 'vitest';
import { Hono } from 'hono';
import {
  createSession, createTask, ModelResolver, RunnerRegistry,
  type ExecutionCommand, type IRunner, type LegacyPlanState, type Session, type SessionMessage, type Task,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem, FakeRunnerSession } from '@ordewell/core/testing';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { approvalsRoute } from '../approvals';
import { plansRoute } from '../plans';

export type ExecutionActionMessage = Extract<SessionMessage, { type: 'execution_action' }>;

export const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

/**
 * A real Session behind the daemon's own routes, with only the task runner
 * faked: what a surface sends over HTTP lands in the timeline exactly as a
 * button press does, and the route answers can be read against it.
 */
export function daemonHarness() {
  const messages: SessionMessage[] = [];
  const runners: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const spawned = new FakeRunnerSession(`s${runners.length + 1}`, opts.taskId);
      runners.push(spawned);
      return spawned;
    }),
    stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
  } satisfies IRunner;
  const registry = new RunnerRegistry();
  const config = fakeConfig({ autonomousMode: true });
  const session: Session = createSession({
    config, registry, runner,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    workspaceRoot: () => process.cwd(),
    fsAdapter: fakeFileSystem(),
    broadcast: (m) => messages.push(m),
    modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
    settings: () => ({}),
    saveSession: () => {},
    openTaskLog: () => ({ attempt: 1, append() {} }),
  });
  const pool = {
    session: () => session,
    live: () => session,
    hasSession: () => true,
  } as unknown as OrchestratorPool;
  const app = new Hono()
    .route('/api/plans', plansRoute(pool))
    .route('/api/approvals', approvalsRoute(pool));

  const load = (tasks: Task[], over: Partial<LegacyPlanState> = {}) => {
    const now = new Date().toISOString();
    session.loadPlan({ tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...over }, 'goal', process.cwd(), { persist: false });
  };
  // What was kept since the last `forgetTimeline`, so a test reads only the line its own request kept.
  let forgotten = 0;
  const timeline = () => messages.flatMap((m): ExecutionActionMessage[] => (m.type === 'execution_action' ? [m] : [])).slice(forgotten);
  const forgetTimeline = () => { forgotten += timeline().length; };
  const latest = (taskId: string) => runners.filter((r) => r.taskId === taskId).at(-1)!;
  const post = (path: string, body?: unknown) => app.request(`/api/plans/s1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // The one route every forwarded control takes: the body is the command itself.
  const command = (body: ExecutionCommand) => post('execute-command', body);

  return { app, session, messages, runners, runner, load, timeline, forgetTimeline, latest, post, command };
}
