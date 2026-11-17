import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSING_TURN_BOUND_MS, type SupervisorLevel } from '@ordewell/core';
import { ApiClient } from '../../apiClient';
import { handleRun, RUN_FAILED_EXIT } from '../run';

/**
 * `ordewell run` with nobody attached (ADR-0029): it follows the run until
 * the daemon says its end stands, at Act after the supervisor's closing turn,
 * says who can answer a wait, and exits by the tasks' verdicts.
 */

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

// The daemon's pace is real time: a test that fakes the follower's clock does not stop the daemon.
const realSetTimeout = globalThis.setTimeout;
const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

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
  const push = (event: Event) => {
    for (const ws of sockets) ws.send(JSON.stringify(event));
    sent.push(event.type);
  };
  const api = new ApiClient((wss.address() as { port: number }).port, '/w');
  Object.assign(api, {
    getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }),
    getSettings: vi.fn().mockResolvedValue({ run: { supervisorLevel: level } }),
    executePlan: vi.fn(async () => {
      void (async () => {
        for (const event of script) {
          await new Promise((resolve) => realSetTimeout(resolve, 5));
          push(event);
        }
      })();
      return { status: 'running' };
    }),
  });
  return { api, sent, push, drop: () => { for (const ws of sockets) ws.close(1001); }, close: () => wss.close() };
}

/** What a test does while `ordewell run` follows: the daemon's hands, and what the follower wrote so far. */
type During = (hands: Awaited<ReturnType<typeof daemon>> & { out: () => string; returned: () => boolean }) => Promise<void>;

/** Runs `ordewell run` to its return: what it wrote, and what the daemon had sent by then. */
async function run(level: SupervisorLevel, script: Event[], during?: During) {
  const hands = await daemon(level, script);
  const { api, sent, close } = hands;
  const written: string[] = [];
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { written.push(`${args.join(' ')}\n`); });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { written.push(`${args.join(' ')}\n`); });
  try {
    let returned = false;
    const following = handleRun(['--session-id', 's1'], api).finally(() => { returned = true; });
    await during?.({ ...hands, out: () => written.join(''), returned: () => returned });
    await following;
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

describe('ordewell run at a planner paused on its context', () => {
  it('says, once, that the closing turn waits for someone to retry compaction', async () => {
    const paused = {
      type: 'plan_generated',
      plan: {
        tasks: [t1, t2],
        runSettings: { supervisorLevel: 'act' },
        plannerContextPause: { at: AT, model: 'm', reason: 'The planner ran out of context. The planner is paused: Retry compaction tries to condense its context and continue the turn, or stop it to drop the turn.', inputs: ['w'] },
      },
      goal: 'g',
      runners: [],
    } as unknown as Event;
    const { out } = await run('act', [
      snapshot('act'),
      complete(1, 1),
      { type: 'planner_turn_started', turnId: 'w1', supervisor: true },
      paused,
      paused,
      concluded(1, 1),
    ]);

    expect(out.split('· The planner is paused on its context, and its turn waits: `ordewell compact retry` carries it on. Nobody does that unattended: it waits until someone does.\n')).toHaveLength(2);
  });
});

describe('ordewell run when the run is stopped', () => {
  it('returns at the stop and keeps the status it had', async () => {
    const { sentAtReturn, exitCode } = await run('act', [snapshot('act'), { type: 'execution_stopped' }]);

    expect(sentAtReturn).toEqual(['run_snapshot', 'execution_stopped']);
    expect(exitCode ?? 0).toBe(0);
  });
});

/** Turns of the real event loop until the follower has written `line`. */
async function heard(out: () => string, line: string, times = 1): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (out().split(line).length <= times && performance.now() < deadline) await new Promise((resolve) => realSetTimeout(resolve, 1));
  expect(out().split(line)).toHaveLength(times + 1);
}

const WAITING = "· The run ended: waiting for the supervisor's closing turn, which may continue it.\n";
const OVERDUE = "· The supervisor's closing turn did not conclude in time: the run is no longer followed, and its tasks' outcomes stand as they ended. `ordewell status` shows where it stands.\n";

describe('ordewell run when the closing turn never concludes', () => {
  afterEach(() => vi.useRealTimers());

  it('waits the supervisor\'s own bound, then says so once and exits by the tasks\' outcomes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { out, exitCode } = await run('act', [snapshot('act'), complete(1, 1)], async ({ out, returned }) => {
      await heard(out, WAITING);
      await vi.advanceTimersByTimeAsync(CLOSING_TURN_BOUND_MS - 1);
      for (let i = 0; i < 20; i++) await realTurn();
      expect(returned()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(out.split(OVERDUE)).toHaveLength(2);
    expect(exitCode).toBe(RUN_FAILED_EXIT);
  });

  it('starts the bound afresh when the closing turn continues the run and it ends again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { out, exitCode } = await run('act', [snapshot('act'), complete(1, 1)], async ({ out, push, returned }) => {
      await heard(out, WAITING);
      await vi.advanceTimersByTimeAsync(CLOSING_TURN_BOUND_MS - 1_000);
      push({ type: 'task_started', taskId: t1.id, order: 1, title: t1.title, runner: 'claude-code' } as Event);
      push(complete(2, 0));
      await heard(out, WAITING, 2);

      await vi.advanceTimersByTimeAsync(CLOSING_TURN_BOUND_MS - 1);
      for (let i = 0; i < 20; i++) await realTurn();
      expect(returned()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(out.split(OVERDUE)).toHaveLength(2);
    expect(exitCode ?? 0).toBe(0);
  });

  it('does not run the bound while a continued run is under way', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { out } = await run('act', [snapshot('act'), complete(1, 1)], async ({ out, push, returned }) => {
      await heard(out, WAITING);
      push({ type: 'task_started', taskId: t1.id, order: 1, title: t1.title, runner: 'claude-code' } as Event);
      await heard(out, 'Fix the import');
      await vi.advanceTimersByTimeAsync(2 * CLOSING_TURN_BOUND_MS);
      for (let i = 0; i < 20; i++) await realTurn();
      expect(returned()).toBe(false);
      push(complete(2, 0));
      push(concluded(2, 0));
    });

    expect(out).not.toContain(OVERDUE);
  });

  it('is not needed when the daemon concludes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { out } = await run('act', [snapshot('act'), complete(1, 1), concluded(1, 1)]);
    await vi.advanceTimersByTimeAsync(2 * CLOSING_TURN_BOUND_MS);

    expect(out).not.toContain(OVERDUE);
  });
});

describe('ordewell run when the supervisor could not take its closing turn', () => {
  it('says why, and exits by the tasks\' outcomes', async () => {
    const { out, exitCode } = await run('act', [
      snapshot('act'),
      complete(1, 1),
      { type: 'run_concluded', summary: summary(1, 1), supervisorHeld: 'the planner hit its usage limit, and its turn goes again once the limit resets' },
    ]);

    expect(out).toContain('· The supervisor could not take its closing turn: the planner hit its usage limit, and its turn goes again once the limit resets.\n');
    expect(exitCode).toBe(RUN_FAILED_EXIT);
  });
});

describe('ordewell run when the daemon goes away during the closing turn', () => {
  it('reports the lost connection rather than waiting on', async () => {
    let said = () => '';
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    try {
      await expect(run('act', [snapshot('act'), complete(1, 1)], async ({ out, drop }) => {
        said = out;
        await heard(out, WAITING);
        drop();
      })).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
    }

    expect(said()).toContain('Lost the connection to the daemon');
  });
});
