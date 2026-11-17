import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SupervisorLevel } from '@ordewell/core';
import { ApiClient } from '../../apiClient';
import { handleRun, RUN_FAILED_EXIT } from '../run';

/**
 * `ordewell run` with nobody attached (ADR-0029): it follows the run until
 * the daemon says its end stands, at Act after the supervisor's closing turn,
 * says who can answer a wait, and exits by the tasks' verdicts.
 */

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

const AT = '2026-11-17T10:00:00.000Z';
const t1 = { id: 'task-0001', order: 1, title: 'Fix the import', status: 'pending' };
const t2 = { id: 'task-0002', order: 2, title: 'Migrate the schema', status: 'pending' };
const snapshot = (supervisorLevel: SupervisorLevel): Event => ({ type: 'run_snapshot', view: { tasks: [t1, t2], runSettings: { supervisorLevel } } } as unknown as Event);
const summary = (completed: number, failed: number) => ({ total: 2, completed, failed, blocked: 0, skipped: 0 });
const complete = (completed: number, failed: number): Event => ({ type: 'execution_complete', summary: summary(completed, failed) });
const concluded = (completed: number, failed: number): Event => ({ type: 'run_concluded', summary: summary(completed, failed) });
const retried: Event = {
  type: 'execution_action',
  record: { command: 'retry_task', actor: 'supervisor', level: 'act', task: { id: t1.id, ref: '#1', title: t1.title }, outcome: 'done', at: AT },
  text: 'Retried task #1 "Fix the import": by supervisor.',
} as Event;

/** A daemon whose session socket sends each event in turn once the run starts. */
async function daemon(level: SupervisorLevel, script: Event[]) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => { sockets.push(ws); });
  const sent: string[] = [];
  const api = new ApiClient((wss.address() as { port: number }).port, '/w');
  Object.assign(api, {
    getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }),
    getSettings: vi.fn().mockResolvedValue({ run: { supervisorLevel: level } }),
    executePlan: vi.fn(async () => {
      void (async () => {
        for (const event of script) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          for (const ws of sockets) ws.send(JSON.stringify(event));
          sent.push(event.type);
        }
      })();
      return { status: 'running' };
    }),
  });
  return { api, sent, close: () => wss.close() };
}

/** Runs `ordewell run` to its return: what it wrote, and what the daemon had sent by then. */
async function run(level: SupervisorLevel, script: Event[]) {
  const { api, sent, close } = await daemon(level, script);
  const written: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { written.push(`${args.join(' ')}\n`); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await handleRun(['--session-id', 's1'], api);
    return { out: written.join(''), sentAtReturn: [...sent], exitCode: process.exitCode };
  } finally {
    stderr.mockRestore();
    log.mockRestore();
    error.mockRestore();
    close();
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('ordewell run at Act', () => {
  it('follows the closing turn that retried a failed task, and returns once, after the pass, with status 0', async () => {
    const { out, sentAtReturn, exitCode } = await run('act', [
      snapshot('act'),
      complete(1, 1),
      { type: 'planner_turn_started', turnId: 'w1', supervisor: true },
      retried,
      { type: 'planner_message', content: 'Retried task #1 with the import fixed.', timestamp: AT, turnId: 'w1', supervisor: true },
      { type: 'task_started', taskId: t1.id, order: 1, title: t1.title, runner: 'claude-code' },
      complete(2, 0),
      concluded(2, 0),
    ]);

    expect(sentAtReturn.at(-1)).toBe('run_concluded');
    expect(out.match(/\nDone\./g)).toHaveLength(2);
    expect(out).toContain("· The run ended: waiting for the supervisor's closing turn, which may continue it.\n");
    expect(out).toContain('· Retried task #1 "Fix the import": by supervisor.\n');
    expect(out).toContain('· Supervisor: Retried task #1 with the import fixed.\n');
    expect(exitCode ?? 0).toBe(0);
  });

  it('returns after a closing turn that changed nothing, with the failed status', async () => {
    const { out, sentAtReturn, exitCode } = await run('act', [
      snapshot('act'),
      complete(1, 1),
      { type: 'planner_turn_started', turnId: 'w1', supervisor: true },
      { type: 'planner_message', content: 'Task #1 needs you: the import is wrong.', timestamp: AT, turnId: 'w1', supervisor: true },
      concluded(1, 1),
    ]);

    expect(sentAtReturn).toEqual(['run_snapshot', 'execution_complete', 'planner_turn_started', 'planner_message', 'run_concluded']);
    expect(out).toContain('· Supervisor: Act.\n');
    expect(out).toContain('· Supervisor: Task #1 needs you: the import is wrong.\n');
    expect(exitCode).toBe(RUN_FAILED_EXIT);
  });

  it('says a plan the supervisor edited', async () => {
    const { out } = await run('act', [
      snapshot('act'),
      complete(1, 1),
      { type: 'planner_turn_started', turnId: 'w1', supervisor: true },
      { type: 'plan_generated', plan: { tasks: [t1, t2], runSettings: { supervisorLevel: 'act' } }, goal: 'g', runners: [], turnId: 'w1' } as unknown as Event,
      concluded(1, 1),
    ]);

    expect(out).toContain('· The supervisor edited the plan.\n');
  });
});

describe.each(['watch', 'off'] as const)('ordewell run at %s', (level) => {
  it('returns at the first end, and below Act says a wait on a person lasts until someone answers', async () => {
    const { out, sentAtReturn, exitCode } = await run(level, [snapshot(level), complete(2, 0), concluded(2, 0)]);

    expect(sentAtReturn).toEqual(['run_snapshot', 'execution_complete', 'run_concluded']);
    expect(out).toContain('· A task waiting on a person (a checkpoint, input or an approval) waits until someone answers it.\n');
    expect(out).not.toContain('closing turn');
    expect(exitCode ?? 0).toBe(0);
  });

  it('exits with the failed status when a task failed', async () => {
    const { exitCode } = await run(level, [snapshot(level), complete(1, 1), concluded(1, 1)]);

    expect(exitCode).toBe(RUN_FAILED_EXIT);
  });
});

describe('ordewell run at a wait on a person', () => {
  const NOBODY = ' Nobody answers it unattended: it waits until someone does. `ordewell supervisor act` lets the supervisor answer in new sessions.';
  const WOKEN = ' The supervisor has been woken to answer it.';

  it.each([
    ['off', NOBODY],
    ['watch', NOBODY],
    ['act', WOKEN],
  ] as const)('at %s names the checkpoint by its reference, the command, and who answers it', async (level, who) => {
    const { out } = await run(level, [
      snapshot(level),
      { type: 'checkpoint', taskId: t2.id, taskTitle: t2.title, summary: 'Drop the users table?' },
      complete(2, 0),
      concluded(2, 0),
    ]);

    expect(out).toContain(`· Checkpoint: #2 Migrate the schema: Drop the users table?: \`ordewell checkpoint 2 approve|reject [reason]\` answers it.${who}\n`);
  });

  it('names a wait for input and for an approval once each, with what answers them', async () => {
    const waits = {
      type: 'status_update',
      tasks: [],
      escalations: [
        { id: 'e1', kind: 'input', task: { id: t1.id, ref: '#1', title: t1.title }, reason: 'It asks which branch to use.', options: [] },
        { id: 'e2', kind: 'approval', task: { id: t2.id, ref: '#2', title: t2.title }, reason: 'Its runner asks: Run npm install', options: [] },
      ],
    } as unknown as Event;
    const { out } = await run('watch', [snapshot('watch'), waits, waits, complete(2, 0), concluded(2, 0)]);

    expect(out.split('· Waiting for input: #1 Fix the import: It asks which branch to use: `ordewell tui`, then `/open 1`, answers it.' + NOBODY + '\n')).toHaveLength(2);
    expect(out.split('· Waiting for approval: #2 Migrate the schema: Its runner asks: Run npm install: `ordewell tui`, then `/open 2`, answers it.' + NOBODY + '\n')).toHaveLength(2);
  });
});

describe('ordewell run when the run is stopped', () => {
  it('returns at the stop and keeps the status it had', async () => {
    const { sentAtReturn, exitCode } = await run('act', [snapshot('act'), { type: 'execution_stopped' }]);

    expect(sentAtReturn).toEqual(['run_snapshot', 'execution_stopped']);
    expect(exitCode ?? 0).toBe(0);
  });
});
