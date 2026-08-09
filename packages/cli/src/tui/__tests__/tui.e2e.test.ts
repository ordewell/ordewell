import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type App } from '../app';
import { openTerminal, type Terminal } from '../terminal';
import { ConversationQueue, runEffect, type OrdewellApi } from '../effects';
import { stripAnsi } from '../ansi';

/**
 * End-to-end: raw stdin bytes → terminal key decoding → reducer → real
 * effects against a fake daemon → actions back → frames painted to stdout.
 * Everything is the production code path except the two process boundaries:
 * the tty streams and the HTTP/WS client.
 */

class FakeInput extends EventEmitter {
  isTTY = true;
  setRawMode = vi.fn();
  resume = vi.fn();
  pause = vi.fn();
  setEncoding = vi.fn();
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  rows = 24;
  columns = 80;
  writes: string[] = [];
  write = vi.fn((text: string) => {
    this.writes.push(text);
    return true;
  });
}

const PLAN_TASKS = [
  { id: 't1', order: 1, title: 'Add the login route', type: 'ai', status: 'pending', dependencies: [] },
  { id: 't2', order: 2, title: 'Write the tests', type: 'ai', status: 'pending', dependencies: ['t1'] },
];

function planPayload(tasks = PLAN_TASKS, question = 'Plan drafted — anything to change?') {
  return {
    conversationHistory: [
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: question },
    ],
    pendingTasks: tasks,
  };
}

/** An in-memory daemon honouring the call protocol the real one has. */
function fakeDaemon() {
  const log: string[] = [];
  let planningListener: ((event: unknown) => void) | null = null;
  let executionListener: ((event: unknown) => void) | null = null;

  const api = {
    startConversation: vi.fn(async (_id: string, _goal: string) => {
      log.push('startConversation');
      planningListener?.({ type: 'research_step', tool: 'read_file', args: '{"path":"src/LoginRoute.ts"}' });
      await Promise.resolve();
      return planPayload();
    }),
    sendConversationMessage: vi.fn(async () => {
      log.push('sendMessage');
      return planPayload();
    }),
    executePlan: vi.fn(async (_id: string) => {
      log.push('executePlan');
      executionListener?.({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress' }] });
      executionListener?.({ type: 'status_update', tasks: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'completed' }] });
      executionListener?.({ type: 'execution_complete', summary: { total: 2, completed: 2, failed: 0 } });
      settleExecution();
      return { status: 'started' };
    }),
    stopExecution: vi.fn(async () => ({ status: 'stopped' })),
    taskControl: vi.fn(async () => ({ ok: true })),
    markTaskComplete: vi.fn(async () => ({ ok: true })),
    markTaskIncomplete: vi.fn(async () => ({ ok: true })),
    addTask: vi.fn(async () => ({ ok: true })),
    updateTask: vi.fn(async () => ({ ok: true })),
    removeTask: vi.fn(async () => ({ ok: true })),
    getSessions: vi.fn(async () => [
      { id: 'saved-1', goal: 'Earlier goal', taskCount: 2, status: 'completed', createdAt: '2026-07-01' },
    ]),
    getSession: vi.fn(async () => ({ meta: {}, plan: planPayload() })),
    adoptSession: vi.fn(async () => ({ plan: planPayload(), goal: 'Earlier goal' })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    closeSession: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({ orchestratorModel: 'deepseek/deepseek-v4-flash', aiProvider: 'openrouter' })),
    updateSettings: vi.fn(async (changes: Record<string, unknown>) => changes),
    sendCommand: vi.fn(async () => ({ ok: true })),
    getRunners: vi.fn(async () => ({
      runners: [{ id: 'opencode', name: 'OpenCode', enabled: true }],
      orchestratorModel: 'deepseek/deepseek-v4-flash',
    })),
    setRunnerEnabled: vi.fn(async () => ({ ok: true })),
    getModels: vi.fn(async () => ({
      models: [],
      modelsByRunner: {},
      providers: ['openrouter'],
      orchestratorModels: [{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'OpenRouter' }],
      providerErrors: {},
    })),
    streamPlanning: vi.fn((_id: string, onEvent: (event: unknown) => void) => {
      log.push('streamPlanning');
      planningListener = onEvent;
      return { close: () => { planningListener = null; } };
    }),
    streamExecution: vi.fn((_id: string, onEvent: (event: unknown) => void, onReady?: (error?: Error) => void) => {
      log.push('streamExecution');
      executionListener = onEvent;
      queueMicrotask(() => onReady?.());
      return new Promise<void>((resolve) => { settleExecution = resolve; });
    }),
  };
  let settleExecution: () => void = () => {};

  return {
    api: api as unknown as OrdewellApi,
    mocks: api,
    log,
    emitExecution: (event: unknown) => executionListener?.(event),
    endExecution: () => settleExecution(),
  };
}

function harness() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const daemon = fakeDaemon();
  const queue = new ConversationQueue();
  const envWrites: Record<string, string> = {};
  const onExit = vi.fn();
  const clipboard: string[] = [];
  let sessionCounter = 0;

  // eslint-disable-next-line prefer-const
  let terminal: Terminal | undefined;
  const app: App = createApp({
    initial: { workspace: '/ws', autonomous: true },
    draw: (frame) => terminal?.draw(frame),
    perform: (effect) =>
      runEffect(effect, {
        api: daemon.api,
        workspace: '/ws',
        conversationQueue: queue,
        port: 3742,
        dispatch: (action) => app.dispatch(action),
        newSessionId: () => `session-${++sessionCounter}`,
        setEnvVar: (key, value) => { envWrites[key] = value; },
        openTerminal: async () => ({ ok: true, message: 'Opened terminal.' }),
        setMouseCapture: (enabled) => terminal?.setMouse(enabled),
        // A real `xclip` would put test fixtures on the developer's clipboard;
        // the probe and the pipe are the only two steps that have to be faked.
        hasBin: () => true,
        pipeToClipboard: (_command, text) => { clipboard.push(text); },
        writeTerminal: (data) => output.write(data),
        // The fake daemon never refuses a connection, so this is never reached.
        reviveDaemon: async () => true,
        exit: () => { onExit(); terminal?.close(); },
      }),
    onExit: () => { onExit(); terminal?.close(); },
  });

  terminal = openTerminal({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    onKey: (key) => app.dispatch({ type: 'key', key }),
    onResize: (rows, cols) => app.dispatch({ type: 'resize', rows, cols }),
  });
  app.dispatch({ type: 'resize', rows: output.rows, cols: output.columns });
  app.start();

  const type = (text: string) => input.emit('data', text);
  // A draw is now row-anchored (`terminal.ts`): each row is its own
  // `ESC[<row>;1H<content>ESC[K` rather than one HOME-and-join blit, so
  // reassembling "the screen" means picking each row's content out by its own
  // position code and re-joining in row order.
  // eslint-disable-next-line no-control-regex
  const ROW = /\x1b\[(\d+);1H([\s\S]*?)\x1b\[K/g;
  const frames = () =>
    output.writes
      .filter((w) => w.includes('\x1b[?7l'))
      .map((w) => {
        const rows = new Map<number, string>();
        for (const m of w.matchAll(ROW)) rows.set(Number(m[1]), stripAnsi(m[2]));
        const lastRow = Math.max(0, ...rows.keys());
        return Array.from({ length: lastRow }, (_, i) => rows.get(i + 1) ?? '').join('\n');
      });
  const screen = () => frames().at(-1) ?? '';
  // The transcript column only, unwrapped: everything left of the plan-pane
  // divider, with the pane's line wrapping collapsed back to single spaces.
  const transcript = () =>
    screen()
      .split('\n')
      .map((line) => (line.includes('│') ? line.slice(0, line.indexOf('│')) : line))
      .join(' ')
      .replace(/\s+/g, ' ');

  return { app, input, output, daemon, envWrites, onExit, clipboard, type, frames, screen, transcript };
}

const settle = () => vi.waitFor(() => expect(true).toBe(true));

beforeEach(() => {
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TUI end to end', () => {
  it('boots against the daemon and paints live runner and model data', async () => {
    const h = harness();
    await vi.waitFor(() => {
      expect(h.screen()).toContain('deepseek/deepseek-v4-flash');
      expect(h.screen()).toContain('OpenCode');
    });
    expect(h.daemon.mocks.getRunners).toHaveBeenCalled();
    expect(h.daemon.mocks.getSettings).toHaveBeenCalled();
    expect(h.daemon.mocks.getModels).toHaveBeenCalled();
  });

  it('plans a goal from raw keystrokes: research streams, plan renders, reply lands in the transcript', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');

    await vi.waitFor(() => {
      expect(h.screen()).toContain('Add the login route');
      expect(h.screen()).toContain('Plan drafted — anything to change?');
    });

    expect(h.daemon.mocks.startConversation).toHaveBeenCalledWith(
      'session-1', 'Build the login flow', undefined, '/ws',
    );
    // The research step painted while the REST call was in flight.
    expect(h.frames().some((f) => f.includes('LoginRoute.ts'))).toBe(true);
    // The planning stream was subscribed before the turn and closed after it.
    expect(h.daemon.log.indexOf('streamPlanning')).toBeLessThan(h.daemon.log.indexOf('startConversation'));
    expect(h.app.getState().sessionId).toBe('session-1');
  });

  it('a bracketed paste with a newline lands in the editor without submitting', async () => {
    const h = harness();
    h.type('\x1b[200~first line\nsecond line\x1b[201~');
    await settle();

    expect(h.daemon.mocks.startConversation).not.toHaveBeenCalled();
    expect(h.app.getState().editor.text).toBe('first line\nsecond line');
    expect(h.screen()).toContain('second line');
  });

  it('a follow-up typed while the first turn is in flight waits for the session to exist', async () => {
    const h = harness();
    let releaseFirstTurn: () => void = () => {};
    h.daemon.mocks.startConversation.mockImplementationOnce(async () => {
      h.daemon.log.push('startConversation');
      await new Promise<void>((resolve) => { releaseFirstTurn = resolve; });
      return planPayload();
    });

    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.app.getState().sessionId).toBe('session-1'));

    h.type('Use SQLite');
    h.type('\r');
    await settle();
    expect(h.daemon.mocks.sendConversationMessage).not.toHaveBeenCalled();

    releaseFirstTurn();
    await vi.waitFor(() => {
      expect(h.daemon.mocks.sendConversationMessage).toHaveBeenCalledWith('session-1', 'Use SQLite');
    });
    expect(h.daemon.log.indexOf('sendMessage')).toBeGreaterThan(h.daemon.log.indexOf('startConversation'));
  });

  it('/run subscribes to the execution stream before launching, then paints progress and the summary', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    h.type('/run');
    h.type('\r');

    await vi.waitFor(() => {
      expect(h.screen()).toContain('Execution finished — 2/2 tasks complete.');
    });
    expect(h.daemon.log.indexOf('streamExecution')).toBeLessThan(h.daemon.log.indexOf('executePlan'));
    expect(h.app.getState().tasks.map((t) => t.status)).toEqual(['completed', 'completed']);
  });

  it('E on the plan pane runs the whole plan, like /run', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    h.type('\t');
    h.type('E');

    await vi.waitFor(() => expect(h.screen()).toContain('Execution finished — 2/2 tasks complete.'));
    expect(h.daemon.mocks.executePlan).toHaveBeenCalledWith('session-1');
  });

  it('f starts one task and the pane animates it, then settles when it finishes', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    h.daemon.mocks.taskControl.mockImplementationOnce(async () => {
      h.daemon.log.push('taskControl');
      h.daemon.emitExecution({ type: 'status_update', tasks: [{ id: 't1', status: 'in_progress' }] });
      return { ok: true };
    });

    h.type('\t');
    h.type('f');

    // The RUN badge and a spinner frame, not a static pending dot.
    await vi.waitFor(() => {
      expect(h.app.getState().tasks.find((t) => t.id === 't1')?.status).toBe('in_progress');
      expect(h.screen()).toContain('RUN');
    });
    expect(h.daemon.mocks.taskControl).toHaveBeenCalledWith('session-1', 't1', 'force-start');
    // The stream was subscribed before the request, so the first update landed.
    expect(h.daemon.log.indexOf('streamExecution')).toBeLessThan(h.daemon.log.indexOf('taskControl'));

    const frame = h.app.getState().spinnerFrame;
    h.app.dispatch({ type: 'spinnerTick' });
    expect(h.app.getState().spinnerFrame).not.toBe(frame);

    h.daemon.emitExecution({ type: 'status_update', tasks: [{ id: 't1', status: 'completed' }] });
    h.daemon.emitExecution({ type: 'execution_complete', summary: { total: 2, completed: 1, failed: 0 } });
    h.daemon.endExecution();

    await vi.waitFor(() => expect(h.app.getState().status).toBe('idle'));
  });

  it('review mode round-trips: sign-off request paints, /approve re-launches execution', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    h.daemon.mocks.executePlan.mockImplementationOnce(async () => {
      h.daemon.log.push('executePlan');
      h.daemon.emitExecution({ type: 'task_started', taskId: 't1', title: 'Add the login route', runner: 'opencode' });
      h.daemon.emitExecution({ type: 'checkpoint', taskTitle: 'Add the login route', summary: 'Route added' });
      h.daemon.emitExecution({ type: 'review_needed' });
      // The daemon can rewrite the plan mid-run (queued task ops) and speak.
      h.daemon.emitExecution({
        type: 'plan_generated',
        plan: planPayload([...PLAN_TASKS, { id: 't3', order: 3, title: 'Harden the session check', type: 'ai', status: 'pending', dependencies: [] }]),
      });
      h.daemon.emitExecution({ type: 'planner_message', content: 'Added a hardening task.' });
      h.daemon.emitExecution({ type: 'review_approved' });
      h.daemon.emitExecution({ type: 'execution_stopped', summary: { total: 2, completed: 1, failed: 0 } });
      h.daemon.endExecution();
      return { status: 'started' };
    });

    h.type('/run');
    h.type('\r');
    await vi.waitFor(() => {
      expect(h.transcript()).toContain('Checkpoint — Add the login route: Route added');
      expect(h.transcript()).toContain('Plan needs your sign-off — /approve to continue.');
      expect(h.transcript()).toContain('Added a hardening task.');
      expect(h.transcript()).toContain('Plan approved.');
    });
    // The mid-run plan rewrite reached the task pane.
    expect(h.app.getState().tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);

    h.type('/approve');
    h.type('\r');
    await vi.waitFor(() => {
      expect(h.screen()).toContain('Execution finished — 2/2 tasks complete.');
    });
    expect(h.daemon.mocks.executePlan).toHaveBeenCalledTimes(2);
    expect(h.app.getState().planApproved).toBe(true);
  });

  it('task commands round-trip through the daemon and re-sync the plan', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    h.daemon.mocks.getSession.mockResolvedValueOnce({
      meta: {},
      plan: planPayload([
        { ...PLAN_TASKS[0], status: 'completed' },
        PLAN_TASKS[1],
      ]),
    });
    h.type('/complete t1');
    h.type('\r');

    await vi.waitFor(() => {
      expect(h.app.getState().tasks.find((t) => t.id === 't1')?.status).toBe('completed');
    });
    expect(h.daemon.mocks.markTaskComplete).toHaveBeenCalledWith('session-1', 't1');
    expect(h.daemon.mocks.getSession).toHaveBeenCalled();

    // Same key, other direction: `m` on the now-completed task un-marks it.
    h.type('\t');
    h.type('m');
    await vi.waitFor(() => {
      expect(h.daemon.mocks.markTaskIncomplete).toHaveBeenCalledWith('session-1', 't1');
    });
    expect(h.daemon.mocks.markTaskComplete).toHaveBeenCalledTimes(1);
  });

  it('/model set persists to the env, the daemon, and the header', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.screen()).toContain('deepseek/deepseek-v4-flash'));

    h.type('/model set openrouter/newer-model');
    h.type('\r');

    await vi.waitFor(() => {
      expect(h.screen()).toContain('Orchestrator model set to openrouter/newer-model.');
    });
    expect(h.envWrites.ORCHESTRATOR_MODEL).toBe('openrouter/newer-model');
    expect(h.daemon.mocks.updateSettings).toHaveBeenCalledWith({ orchestratorModel: 'openrouter/newer-model' });
    expect(h.screen()).toContain('openrouter/newer-model');
  });

  it('a failed planner turn reports in the transcript, clears the session, and the TUI keeps working', async () => {
    const h = harness();
    h.daemon.mocks.startConversation.mockRejectedValueOnce(new Error('planner exploded'));

    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('planner exploded'));
    expect(h.app.getState().sessionId).toBeNull();

    // The next goal starts a brand-new session rather than reusing the dead id.
    h.type('Try again');
    h.type('\r');
    await vi.waitFor(() => {
      expect(h.daemon.mocks.startConversation).toHaveBeenLastCalledWith('session-2', 'Try again', undefined, '/ws');
    });
  });

  it('/sessions lists the daemon\'s saved sessions and enter adopts the selection', async () => {
    const h = harness();
    h.type('/sessions');
    h.type('\r');

    await vi.waitFor(() => expect(h.screen()).toContain('Earlier goal'));
    expect(h.daemon.mocks.getSessions).toHaveBeenCalledWith('/ws');

    h.type('\r');
    await vi.waitFor(() => expect(h.daemon.mocks.adoptSession).toHaveBeenCalledWith('saved-1', '/ws'));
    expect(h.app.getState().sessionId).toBe('saved-1');
  });

  it('/new closes the old session server-side and a close failure stays silent', async () => {
    const h = harness();
    h.daemon.mocks.closeSession.mockRejectedValueOnce(new Error('daemon gone'));
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.app.getState().sessionId).toBe('session-1'));

    h.type('/new');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Start a new session?'));
    h.type('\r');

    await vi.waitFor(() => expect(h.daemon.mocks.closeSession).toHaveBeenCalledWith('session-1'));
    expect(h.app.getState().sessionId).toBeNull();
    expect(h.app.getState().tasks).toEqual([]);
    // The rejected close must not surface in the fresh session's transcript.
    await settle();
    expect(h.app.getState().messages.some((m) => m.role === 'error')).toBe(false);

    h.type('Fresh goal');
    h.type('\r');
    await vi.waitFor(() => {
      expect(h.daemon.mocks.startConversation).toHaveBeenLastCalledWith('session-2', 'Fresh goal', undefined, '/ws');
    });
  });

  it('/save confirms persistence without a daemon round-trip', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.app.getState().sessionId).toBe('session-1'));

    h.type('/save');
    h.type('\r');
    await vi.waitFor(() => expect(h.transcript()).toContain('Session session-1 saved.'));
  });

  it('adopting a saved session loads its plan and makes it live', async () => {
    const h = harness();
    h.type('/load saved-1');
    h.type('\r');

    await vi.waitFor(() => {
      expect(h.screen()).toContain('Loaded "Earlier goal".');
      expect(h.screen()).toContain('Add the login route');
    });
    // Adopt (registers with the pool), not just a file read.
    expect(h.daemon.mocks.adoptSession).toHaveBeenCalledWith('saved-1', '/ws');
    expect(h.app.getState().sessionId).toBe('saved-1');
    // The prior dialogue is restored into the transcript, not just the plan.
    expect(h.screen()).toContain('goal');
    expect(h.screen()).toContain('Plan drafted — anything to change?');
  });

  it('a terminal resize clears the screen and repaints at the new geometry', async () => {
    const h = harness();
    await settle();
    const framesBefore = h.frames().length;

    h.output.rows = 30;
    h.output.columns = 100;
    h.output.emit('resize');

    await vi.waitFor(() => expect(h.frames().length).toBeGreaterThan(framesBefore));
    const lastFrame = h.frames().at(-1)!;
    expect(lastFrame.split('\n')).toHaveLength(30);
    // The shrink/grow is preceded by a full clear so stale glyphs cannot linger.
    expect(h.output.writes).toContain('\x1b[2J');
  });

  it('a wheel report split across two stdin chunks scrolls the transcript and types nothing', async () => {
    // The whole path from raw bytes to a moved viewport: a fast wheel is
    // exactly when stdin hands the report over in two pieces, and the tail used
    // to arrive as `;5M` in the input line.
    const h = harness();
    await settle();
    for (let i = 0; i < 40; i++) h.app.dispatch({ type: 'notice', message: `line ${i}` });
    await settle();
    expect(h.app.getState().scroll).toBe(0);

    h.type('\x1b[<64;10');
    h.type(';5M');

    await vi.waitFor(() => expect(h.app.getState().scroll).toBe(3));
    expect(h.app.getState().editor.text).toBe('');
  });

  it('a Ctrl+wheel report in the X10 encoding scrolls just as well', async () => {
    const h = harness();
    await settle();
    for (let i = 0; i < 40; i++) h.app.dispatch({ type: 'notice', message: `line ${i}` });
    await settle();

    // Button 80: the wheel's 64 with ctrl's 16 on top, biased by 32 for X10.
    h.type(`\x1b[M${String.fromCharCode(80 + 32)}\x30\x25`);

    await vi.waitFor(() => expect(h.app.getState().scroll).toBe(3));
    expect(h.app.getState().editor.text).toBe('');
  });

  it('routes a raw wheel report by the pointer column, chat or plan, all the way to a repainted frame', async () => {
    // 80 cols: the plan pane lands at col 44 onward (geometry.ts), so col 10 is
    // over the chat and col 60 is over the plan — real bytes, real column math.
    const h = harness();
    // Wait out the startup refresh: its completion notice resets `scroll` via
    // `say()`, and racing it would flake the assertions below.
    await vi.waitFor(() => expect(h.screen()).toContain('deepseek/deepseek-v4-flash'));
    for (let i = 0; i < 40; i++) h.app.dispatch({ type: 'notice', message: `line ${i}` });
    h.app.dispatch({
      type: 'planUpdated',
      plan: {
        pendingTasks: Array.from({ length: 30 }, (_, i) => ({
          id: `t${i}`, order: i + 1, title: `Task ${i}`, type: 'ai', status: 'pending', dependencies: [],
        })),
      },
    });
    await settle();
    const before = h.screen();

    h.type('\x1b[<64;10;5M');
    await vi.waitFor(() => expect(h.app.getState().scroll).toBe(3));
    expect(h.app.getState().planScroll ?? 0).toBe(0);
    expect(h.screen()).not.toBe(before);

    const afterChat = h.screen();
    h.type('\x1b[<65;60;5M');
    await vi.waitFor(() => expect(h.app.getState().planScroll).toBe(3));
    expect(h.app.getState().scroll).toBe(3);
    expect(h.screen()).not.toBe(afterChat);
  });

  it('the wheel still reaches the pane behind an overlay, and stops reaching it once the overlay closes', async () => {
    const h = harness();
    // Wait out the startup refresh: its completion notice resets `scroll` via
    // `say()`, and racing it would flake the assertions below.
    await vi.waitFor(() => expect(h.screen()).toContain('deepseek/deepseek-v4-flash'));
    for (let i = 0; i < 40; i++) h.app.dispatch({ type: 'notice', message: `line ${i}` });
    await settle();

    h.app.dispatch({
      type: 'approvalRequested',
      request: { id: 'a1', kind: 'shell_command', subject: 'npm test', scope: 'once' },
    });
    await settle();
    expect(h.screen()).toContain('npm test');
    const withOverlay = h.screen();

    h.type('\x1b[<64;10;5M');
    await vi.waitFor(() => expect(h.app.getState().scroll).toBe(3));
    // The overlay is still up, and still the user's to answer.
    expect(h.app.getState().overlay).toMatchObject({ kind: 'approval' });
    expect(h.screen()).toContain('npm test');
    expect(h.screen()).not.toBe(withOverlay);

    h.app.dispatch({ type: 'approvalSettled', approvalId: 'a1' });
    await settle();
    expect(h.app.getState().overlay).toBeNull();
    const noOverlay = h.screen();

    h.type('\x1b[<64;10;5M');
    await vi.waitFor(() => expect(h.app.getState().scroll).toBe(6));
    expect(h.screen()).not.toBe(noOverlay);
  });

  it('drags a selection out of the chat pane and copies it, with no plan text spliced in', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    // Drag from the row the reply is actually painted on — the chat pane is
    // bottom-anchored, so which row that is depends on how much was said.
    const replyRow = h.screen().split('\n').findIndex((line) => line.includes('Plan drafted')) + 1;
    expect(replyRow).toBeGreaterThan(0);

    // SGR press, motion and release (button 0, motion sets bit 32, lowercase
    // `m` is the release) — the bytes a terminal actually sends for a drag.
    h.type(`\x1b[<0;3;${replyRow}M`);
    h.type(`\x1b[<32;30;${replyRow + 3}M`);
    h.type(`\x1b[<0;30;${replyRow + 3}m`);

    await vi.waitFor(() => expect(h.clipboard).toHaveLength(1));
    const copied = h.clipboard[0];

    expect(copied).toContain('Plan drafted');
    // The task titles live in the pane on the other side of the divider.
    expect(copied).not.toContain('Add the login route');
    expect(copied).not.toContain('│');
    // Four rows dragged over, four lines copied.
    expect(copied.split('\n')).toHaveLength(4);
    // The copy notice reflows the transcript, so the highlight is dropped rather
    // than left standing over text it no longer matches.
    expect(h.app.getState().selection).toBeNull();
  });

  it('drags a selection out of the plan pane and copies it, with no chat text spliced in', async () => {
    const h = harness();
    h.type('Build the login flow');
    h.type('\r');
    await vi.waitFor(() => expect(h.screen()).toContain('Add the login route'));

    // 80 cols: the plan pane owns columns 45-80 (geometry.ts). Drag from the
    // row the first task title is actually painted on.
    const taskRow = h.screen().split('\n').findIndex((line) => line.includes('Add the login route')) + 1;
    expect(taskRow).toBeGreaterThan(0);

    h.type(`\x1b[<0;50;${taskRow}M`);
    h.type(`\x1b[<32;70;${taskRow + 1}M`);
    h.type(`\x1b[<0;70;${taskRow + 1}m`);

    await vi.waitFor(() => expect(h.clipboard).toHaveLength(1));
    const copied = h.clipboard[0];

    expect(copied).toContain('Add the login route');
    // The chat transcript lives on the other side of the divider.
    expect(copied).not.toContain('Plan drafted');
    expect(copied).not.toContain('│');
    // Two rows dragged over, two lines copied.
    expect(copied.split('\n')).toHaveLength(2);
    // Same drop-on-copy rule applies regardless of which pane the drag started in.
    expect(h.app.getState().selection).toBeNull();
  });

  it('ctrl-c exits and restores the terminal', async () => {
    const h = harness();
    await settle();

    h.type('\x03');

    expect(h.onExit).toHaveBeenCalled();
    const restore = h.output.writes.join('');
    expect(restore).toContain('\x1b[?1049l');
    expect(restore).toContain('\x1b[?25h');
    expect(h.input.pause).toHaveBeenCalled();
    expect(h.input.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
