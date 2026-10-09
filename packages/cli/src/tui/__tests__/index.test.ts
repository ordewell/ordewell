import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { Key } from '../keys';

const daemon = vi.hoisted(() => ({
  ensureDaemonOwned: vi.fn(async () => ({ port: 4000, owned: true })),
  resolvePort: vi.fn(() => 4000),
  findFreePort: vi.fn(async () => 4000),
  stopDaemon: vi.fn(async () => {}),
}));

const apiClient = vi.hoisted(() => ({
  ApiClient: vi.fn(function stub() {
    return {
      getRunners: async () => ({ runners: [], orchestratorModel: '' }),
      getSettings: async () => ({}),
      getModels: async () => ({ models: [] }),
    };
  }),
}));

const fakeTerminal = vi.hoisted(() => {
  const state = {
    onKey: undefined as ((key: Key) => void) | undefined,
    mouse: undefined as boolean | undefined,
    draw: vi.fn(),
    close: vi.fn(),
    reset: vi.fn(),
  };
  return state;
});

vi.mock('../../daemon', () => daemon);
vi.mock('../../apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apiClient')>();
  return { ...actual, ApiClient: apiClient.ApiClient };
});
vi.mock('../../utils/env', () => ({ findEnvFile: vi.fn(() => '/ws/.env'), writeEnvVar: vi.fn() }));
vi.mock('../terminal', () => ({
  openTerminal: vi.fn((options: { onKey(key: Key): void; mouse?: boolean }) => {
    fakeTerminal.onKey = options.onKey;
    fakeTerminal.mouse = options.mouse;
    return {
      size: () => ({ rows: 24, cols: 80 }),
      draw: fakeTerminal.draw,
      close: fakeTerminal.close,
      reset: fakeTerminal.reset,
      setMouse: vi.fn(),
    };
  }),
}));

import { handleTui } from '../index';

type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGCONT' | 'uncaughtException';
const SIGNALS: SignalName[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGCONT', 'uncaughtException'];

// Signal names are widened to `never` at the call because `process.listeners`
// overloads on the built-in event union; take the listener type from the call
// itself rather than restating it, which is what forced a bare `Function` here.
const listenersFor = (signal: SignalName) => process.listeners(signal as never);

describe('handleTui', () => {
  let priorListeners: Map<SignalName, ReturnType<typeof listenersFor>>;
  let exitSpy: MockInstance<(code?: string | number | null) => never>;
  let isTtyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeTerminal.onKey = undefined;
    priorListeners = new Map(SIGNALS.map((s) => [s, listenersFor(s)]));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    // handleTui registers signal handlers it never removes (the process dies
    // with the TUI); a test process lives on, so strip what this run added.
    for (const signal of SIGNALS) {
      const before = priorListeners.get(signal) ?? [];
      for (const listener of listenersFor(signal)) {
        if (!before.includes(listener)) process.removeListener(signal as never, listener as never);
      }
    }
    exitSpy.mockRestore();
    if (isTtyDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTtyDescriptor);
  });

  it('refuses to start without an interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy.mockImplementation((() => { throw new Error('exit'); }) as never);

    await expect(handleTui([])).rejects.toThrow('exit');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('interactive terminal'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    error.mockRestore();
  });

  it('refuses to start for a workspace that does not exist, naming the path and both remedies', async () => {
    const missing = '/definitely/does/not/exist/ordewell-workspace';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy.mockImplementation((() => { throw new Error('exit'); }) as never);

    await expect(handleTui(['--workspace', missing])).rejects.toThrow('exit');

    expect(error).toHaveBeenCalledWith(expect.stringContaining(missing));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--workspace'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(daemon.ensureDaemonOwned).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('boots the daemon, opens the terminal, and paints the first frame', async () => {
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(daemon.ensureDaemonOwned).toHaveBeenCalledWith(4000, { detached: false });
    // With its workspace, so a session a restarted daemon dropped is re-adopted from there.
    expect(apiClient.ApiClient).toHaveBeenCalledWith(4000, process.cwd());
    const frame = fakeTerminal.draw.mock.calls[0][0] as string[];
    expect(frame).toHaveLength(24);
    expect(frame.join('\n')).toContain('Ordewell');
  });

  it('leaves the alternate screen before printing a fatal error, so the message survives', async () => {
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    fakeTerminal.close.mockImplementation(() => { order.push('close'); });
    error.mockImplementation(() => { order.push('print'); });

    const added = listenersFor('uncaughtException').filter((l) => !priorListeners.get('uncaughtException')!.includes(l));
    (added[0] as (err: Error) => void)(new Error('boom'));

    expect(order[0]).toBe('close');
    expect(order).toContain('print');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    error.mockRestore();
  });

  it('picks a private free port by default, so two unflagged sessions never share a daemon', async () => {
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(daemon.findFreePort).toHaveBeenCalled();
    expect(daemon.resolvePort).not.toHaveBeenCalled();
  });

  it('drives the well-known daemon instead when --port is passed explicitly', async () => {
    daemon.resolvePort.mockReturnValueOnce(3742);
    void handleTui(['--port', '3742']);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(daemon.resolvePort).toHaveBeenCalledWith(['--port', '3742']);
    expect(daemon.findFreePort).not.toHaveBeenCalled();
    expect(daemon.ensureDaemonOwned).toHaveBeenCalledWith(3742, { detached: false });
  });

  it('honours ORDEWELL_AUTONOMOUS_MODE=false from the environment', async () => {
    vi.stubEnv('ORDEWELL_AUTONOMOUS_MODE', 'false');
    vi.stubEnv('NO_COLOR', '1');
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    const frame = (fakeTerminal.draw.mock.calls.at(-1)![0] as string[]).join('\n');
    expect(frame).toContain('● Guarded');
    expect(frame).not.toContain('Full');
    vi.unstubAllEnvs();
  });

  it('captures the mouse by default, so the wheel works without anyone opting in', async () => {
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(fakeTerminal.mouse).toBe(true);
  });

  it.each(['false', '0'])('leaves the mouse alone when ORDEWELL_TUI_MOUSE=%s says so', async (value) => {
    vi.stubEnv('ORDEWELL_TUI_MOUSE', value);
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(fakeTerminal.mouse).toBe(false);
    vi.unstubAllEnvs();
  });

  it('rebuilds the terminal and repaints on SIGCONT, after a Ctrl-Z hands it back bare', async () => {
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());

    fakeTerminal.draw.mockClear();
    process.emit('SIGCONT');

    await vi.waitFor(() => expect(fakeTerminal.reset).toHaveBeenCalled());
    expect(fakeTerminal.draw).toHaveBeenCalled();
  });

  it('ctrl-c tears down: terminal restored, owned daemon stopped, process exits 0', async () => {
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());

    fakeTerminal.onKey!({ name: 'ctrl-c' });

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(fakeTerminal.close).toHaveBeenCalled();
    expect(daemon.stopDaemon).toHaveBeenCalledWith(4000);
  });

  it('leaves a daemon it did not spawn running on exit', async () => {
    daemon.ensureDaemonOwned.mockResolvedValueOnce({ port: 4000, owned: false });
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());

    fakeTerminal.onKey!({ name: 'ctrl-c' });

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(daemon.stopDaemon).not.toHaveBeenCalled();
  });
});
