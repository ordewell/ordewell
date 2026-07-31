import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { Key } from '../keys';

const daemonClient = vi.hoisted(() => ({
  ensureDaemonOwned: vi.fn(async () => ({ port: 4000, owned: true })),
  resolvePort: vi.fn(() => 4000),
  stopDaemon: vi.fn(async () => {}),
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
    draw: vi.fn(),
    close: vi.fn(),
  };
  return state;
});

vi.mock('../../daemonClient', () => daemonClient);
vi.mock('../../utils/env', () => ({ findEnvFile: vi.fn(() => '/ws/.env'), writeEnvVar: vi.fn() }));
vi.mock('../terminalLauncher', () => ({ openTaskTerminal: vi.fn() }));
vi.mock('../terminal', () => ({
  openTerminal: vi.fn((options: { onKey(key: Key): void }) => {
    fakeTerminal.onKey = options.onKey;
    return { size: () => ({ rows: 24, cols: 80 }), draw: fakeTerminal.draw, close: fakeTerminal.close };
  }),
}));

import { handleTui } from '../index';

type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'uncaughtException';
const SIGNALS: SignalName[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException'];

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

  it('boots the daemon, opens the terminal, and paints the first frame', async () => {
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(daemonClient.ensureDaemonOwned).toHaveBeenCalledWith(4000, { detached: false });
    expect(daemonClient.ApiClient).toHaveBeenCalledWith(4000);
    const frame = fakeTerminal.draw.mock.calls[0][0] as string[];
    expect(frame).toHaveLength(24);
    expect(frame.join('\n')).toContain('Ordewell');
  });

  it('honours ORDEWELL_AUTONOMOUS_MODE=false from the environment', async () => {
    vi.stubEnv('ORDEWELL_AUTONOMOUS_MODE', 'false');
    vi.stubEnv('NO_COLOR', '1');
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    const frame = (fakeTerminal.draw.mock.calls.at(-1)![0] as string[]).join('\n');
    expect(frame).toContain('○ auto');
    vi.unstubAllEnvs();
  });

  it('ctrl-c tears down: terminal restored, owned daemon stopped, process exits 0', async () => {
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());

    fakeTerminal.onKey!({ name: 'ctrl-c' });

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(fakeTerminal.close).toHaveBeenCalled();
    expect(daemonClient.stopDaemon).toHaveBeenCalledWith(4000);
  });

  it('leaves a daemon it did not spawn running on exit', async () => {
    daemonClient.ensureDaemonOwned.mockResolvedValueOnce({ port: 4000, owned: false });
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());

    fakeTerminal.onKey!({ name: 'ctrl-c' });

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(daemonClient.stopDaemon).not.toHaveBeenCalled();
  });
});
