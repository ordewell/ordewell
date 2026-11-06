import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Key } from '../keys';

const daemon = vi.hoisted(() => ({
  ensureDaemonOwned: vi.fn(async () => ({ port: 4000, owned: true })),
  resolvePort: vi.fn(() => 4000),
  findFreePort: vi.fn(async () => 4000),
  stopDaemon: vi.fn(async () => {}),
}));

const apiClient = vi.hoisted(() => ({
  // Swapped per test to hold or shape the daemon's settings reply.
  getSettings: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  // Swapped per test to shape the runner rows, auth included.
  getRunners: vi.fn(async (): Promise<Record<string, unknown>> => ({ runners: [], orchestratorModel: '' })),
  ApiClient: vi.fn(function stub() {
    return {
      getRunners: () => apiClient.getRunners(),
      getSettings: () => apiClient.getSettings(),
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
    suspend: vi.fn(),
    resume: vi.fn(),
  };
  return state;
});

vi.mock('../../daemon', () => daemon);
vi.mock('../../apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apiClient')>();
  return { ...actual, ApiClient: apiClient.ApiClient };
});
vi.mock('../../utils/env', () => ({ findEnvFile: vi.fn(() => '/ws/.env'), writeEnvVar: vi.fn(), shellEnvValue: vi.fn(() => undefined) }));
vi.mock('../terminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../terminal')>()),
  openTerminal: vi.fn((options: { onKey(key: Key): void; mouse?: boolean }) => {
    fakeTerminal.onKey = options.onKey;
    fakeTerminal.mouse = options.mouse;
    return {
      size: () => ({ rows: 24, cols: 80 }),
      draw: fakeTerminal.draw,
      close: fakeTerminal.close,
      reset: fakeTerminal.reset,
      suspend: fakeTerminal.suspend,
      resume: fakeTerminal.resume,
      setMouse: vi.fn(),
    };
  }),
}));

import { handleTui, type LoginSpawn } from '../index';
import { augmentedPath, clearAugmentedPathCache } from '@ordewell/core';

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
    fakeTerminal.draw.mockReset();
    apiClient.getSettings.mockImplementation(async () => ({}));
    apiClient.getRunners.mockImplementation(async () => ({ runners: [], orchestratorModel: '' }));
    daemon.ensureDaemonOwned.mockImplementation(async () => ({ port: 4000, owned: true }));
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
    // Resolved, as the workspace is, so Windows names it on the current drive.
    const missing = path.resolve('/definitely/does/not/exist/ordewell-workspace');
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
    expect(daemon.ensureDaemonOwned).toHaveBeenCalledWith(4000, { detached: false, cwd: process.cwd() });
    // With its workspace, so a session a restarted daemon dropped is re-adopted from there.
    expect(apiClient.ApiClient).toHaveBeenCalledWith(4000, process.cwd());
    const frame = fakeTerminal.draw.mock.calls[0][0] as string[];
    expect(frame).toHaveLength(24);
    // Painted before the daemon has answered whether any agent is installed.
    expect(frame.join('\n')).toContain('Detecting coding agents…');
    expect(frame.join('\n')).not.toMatch(/needs one coding agent|not set|none enabled/);
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

  it('starts its private daemon in the workspace, so the login probe asks that account', async () => {
    // The daemon judges a login from its own cwd's environment; started from
    // the shell's directory instead of `--workspace`, `/login` signs one
    // account in while the probe and the gate keep reporting the other out.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tui-workspace-'));
    try {
      void handleTui(['--workspace', workspace]);

      await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
      expect(daemon.ensureDaemonOwned).toHaveBeenCalledWith(4000, { detached: false, cwd: workspace });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('resolves a relative --workspace once, so its daemon is not handed <ws>/<ws>', async () => {
    // The daemon runs with the workspace as its cwd. A raw `sub` sent on each
    // request is then resolved again against the daemon's cwd, so the probe
    // reads a directory that does not exist and ignores the workspace's env.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tui-relative-'));
    const cwd = process.cwd();
    try {
      fs.mkdirSync(path.join(parent, 'sub'), { recursive: true });
      process.chdir(parent);
      void handleTui(['--workspace', 'sub']);

      await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
      const resolved = path.resolve('sub');
      expect(daemon.ensureDaemonOwned).toHaveBeenCalledWith(4000, { detached: false, cwd: resolved });
      expect(apiClient.ApiClient).toHaveBeenCalledWith(4000, resolved);
    } finally {
      process.chdir(cwd);
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('drives the well-known daemon instead when --port is passed explicitly', async () => {
    daemon.resolvePort.mockReturnValueOnce(3742);
    void handleTui(['--port', '3742']);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    expect(daemon.resolvePort).toHaveBeenCalledWith(['--port', '3742']);
    expect(daemon.findFreePort).not.toHaveBeenCalled();
    expect(daemon.ensureDaemonOwned).toHaveBeenCalledWith(3742, { detached: false, cwd: process.cwd() });
  });

  it('honours ORDEWELL_AUTONOMOUS_MODE=false from the environment', async () => {
    vi.stubEnv('ORDEWELL_AUTONOMOUS_MODE', 'false');
    vi.stubEnv('NO_COLOR', '1');
    void handleTui([]);

    await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
    const frame = (fakeTerminal.draw.mock.calls.at(-1)![0] as string[]).join('\n');
    // eslint-disable-next-line no-control-regex
    expect(frame.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/Autonomy\s+Guarded/);
    expect(frame).not.toContain('Full');
    vi.unstubAllEnvs();
  });

  describe('plan approval line on the first frame', () => {
    let home: string;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tui-home-'));
      fs.mkdirSync(path.join(home, '.ordewell'), { recursive: true });
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      // SettingsService prefers this over the home directory, so an ambient
      // override would make the fixture under HOME dead code.
      vi.stubEnv('ORDEWELL_SETTINGS_PATH', path.join(home, '.ordewell', 'settings.json'));
      vi.stubEnv('NO_COLOR', '1');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    });

    const firstFrame = (): string =>
      // eslint-disable-next-line no-control-regex
      (fakeTerminal.draw.mock.calls[0][0] as string[]).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    it('shows Guarded on the first frame of a fresh install', async () => {
      void handleTui([]);

      await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
      expect(firstFrame()).toMatch(/Autonomy\s+Guarded/);
      expect(firstFrame()).not.toMatch(/Autonomy\s+Full/);
    });

    it('warns, and does not promise approval, when the saved settings have autorun on', async () => {
      fs.writeFileSync(path.join(home, '.ordewell', 'settings.json'), JSON.stringify({ autorun: true }));
      void handleTui([]);

      await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
      expect(firstFrame()).toContain('Autorun is on');
      expect(firstFrame()).not.toContain('Nothing runs until');
    });

    it('promises approval when the saved settings have autorun off', async () => {
      fs.writeFileSync(path.join(home, '.ordewell', 'settings.json'), JSON.stringify({ autorun: false }));
      void handleTui([]);

      await vi.waitFor(() => expect(fakeTerminal.draw).toHaveBeenCalled());
      expect(firstFrame()).toContain('Nothing runs until you approve the plan.');
    });

    describe('attached to a daemon this TUI did not start', () => {
      const frameAt = (index: number): string =>
        // eslint-disable-next-line no-control-regex
        (fakeTerminal.draw.mock.calls[index][0] as string[]).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      const lastFrame = (): string => frameAt(fakeTerminal.draw.mock.calls.length - 1);

      it('says nothing about approval until the daemon reports its own autorun, then warns', async () => {
        // The daemon may read a different settings file than this process
        // does, so the local "off" must not be shown as the daemon's answer.
        fs.writeFileSync(path.join(home, '.ordewell', 'settings.json'), JSON.stringify({ autorun: false }));
        daemon.ensureDaemonOwned.mockImplementation(async () => ({ port: 4000, owned: false }));
        let reply!: (settings: Record<string, unknown>) => void;
        let settingsAsked!: () => void;
        const asked = new Promise<void>((resolve) => { settingsAsked = resolve; });
        apiClient.getSettings.mockImplementation(() => {
          settingsAsked();
          return new Promise((resolve) => { reply = resolve; });
        });
        let warned!: () => void;
        const warning = new Promise<void>((resolve) => { warned = resolve; });
        fakeTerminal.draw.mockImplementation(() => {
          if (lastFrame().includes('Autorun is on')) warned();
        });
        void handleTui(['--port', '4000']);

        await asked;
        expect(firstFrame()).not.toContain('Nothing runs until');
        expect(firstFrame()).not.toContain('Autorun is on');
        expect(lastFrame()).not.toContain('Nothing runs until');

        reply({ run: { autorun: true } });
        await warning;
        expect(lastFrame()).not.toContain('Nothing runs until');
      });

      it('promises approval once the daemon reports autorun off', async () => {
        daemon.ensureDaemonOwned.mockImplementation(async () => ({ port: 4000, owned: false }));
        let painted!: () => void;
        const approval = new Promise<void>((resolve) => { painted = resolve; });
        fakeTerminal.draw.mockImplementation(() => {
          if (lastFrame().includes('Nothing runs until you approve the plan.')) painted();
        });
        apiClient.getSettings.mockImplementation(async () => ({ run: { autorun: false } }));
        void handleTui(['--port', '4000']);

        await approval;
        expect(lastFrame()).toContain('Nothing runs until you approve the plan.');
      });
    });
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

  it('waits for the owned daemon\'s stop before exiting, so the stop is not abandoned', async () => {
    let stopped!: () => void;
    daemon.stopDaemon.mockImplementationOnce(() => new Promise<void>((resolve) => { stopped = resolve; }));
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());

    fakeTerminal.onKey!({ name: 'ctrl-c' });

    await vi.waitFor(() => expect(daemon.stopDaemon).toHaveBeenCalledWith(4000));
    expect(fakeTerminal.close).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    stopped();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it('exits after a bounded wait when the owned daemon\'s stop never settles', async () => {
    daemon.stopDaemon.mockImplementationOnce(() => new Promise<void>(() => {}));
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());
    vi.useFakeTimers();
    try {
      fakeTerminal.onKey!({ name: 'ctrl-c' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(exitSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a daemon it did not spawn running on exit', async () => {
    daemon.ensureDaemonOwned.mockResolvedValueOnce({ port: 4000, owned: false });
    void handleTui([]);
    await vi.waitFor(() => expect(fakeTerminal.onKey).toBeDefined());

    fakeTerminal.onKey!({ name: 'ctrl-c' });

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(daemon.stopDaemon).not.toHaveBeenCalled();
  });

  describe('/login', () => {
    const signedOut = {
      id: 'claude-code', name: 'Claude Code', enabled: true,
      auth: { state: 'signed-out', loginCommand: ['claude', 'login'] },
    };
    const signedIn = {
      ...signedOut,
      auth: { state: 'signed-in', loginCommand: ['claude', 'login'] },
    };

    const frame = (): string =>
      // eslint-disable-next-line no-control-regex
      (fakeTerminal.draw.mock.calls.at(-1)![0] as string[]).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    const type = (text: string): void => {
      for (const char of text) fakeTerminal.onKey!({ name: 'char', char });
      fakeTerminal.onKey!({ name: 'enter' });
    };

    /** A `/login` typed at a TUI whose active planner is a signed-out Claude Code. */
    async function signedOutTui(): Promise<{ child: EventEmitter; spawn: ReturnType<typeof vi.fn> }> {
      apiClient.getSettings.mockImplementation(async () => ({ aiProvider: 'claude-code' }));
      apiClient.getRunners.mockImplementation(async () => ({ runners: [signedOut], orchestratorModel: '' }));
      const child = new EventEmitter();
      const spawn = vi.fn(() => child);
      vi.stubEnv('NO_COLOR', '1');
      void handleTui([], { spawn: spawn as unknown as LoginSpawn });

      await vi.waitFor(() => expect(frame()).toContain('Claude Code is not signed in'));
      return { child, spawn };
    }

    it('hands the terminal to the command the runner declares, then takes it back and repaints sign-in', async () => {
      const { child, spawn } = await signedOutTui();

      type('/login');
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

      expect(fakeTerminal.suspend).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith('claude', ['login'], expect.objectContaining({
        stdio: 'inherit',
        cwd: process.cwd(),
      }));

      // The daemon's fresh probe finds the account signed in; the reload after
      // the child is what lets the red line clear without a /refresh.
      apiClient.getRunners.mockImplementation(async () => ({ runners: [signedIn], orchestratorModel: '' }));
      child.emit('exit', 0, null);

      await vi.waitFor(() => expect(fakeTerminal.resume).toHaveBeenCalled());
      await vi.waitFor(() => expect(frame()).toContain('Claude Code is signed in.'));
      expect(frame()).not.toContain('Claude Code is not signed in');
      vi.unstubAllEnvs();
    });

    it('runs the login with the same augmented PATH the probe and planner-spawn use', async () => {
      // A GUI-launched TUI inherits a minimal PATH; the probe and the planner
      // find an agent in ~/.local/bin, so its own login must start too.
      const { child, spawn } = await signedOutTui();
      const original = process.env.PATH;
      try {
        process.env.PATH = '/definitely-not-a-real-bin';
        clearAugmentedPathCache();
        type('/login');
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

        const env = vi.mocked(spawn).mock.calls[0][2]?.env as NodeJS.ProcessEnv;
        // The block is a plain object, and Windows spells the key its own way (`withPath`).
        const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
        expect(await augmentedPath()).toContain(path.join(os.homedir(), '.local', 'bin'));
        expect(env[pathKey]).toContain(path.join(os.homedir(), '.local', 'bin'));
        child.emit('exit', 1, null);
      } finally {
        process.env.PATH = original;
        clearAugmentedPathCache();
        vi.unstubAllEnvs();
      }
    });

    it('takes the terminal back and names the command when the login cannot start', async () => {
      const { child } = await signedOutTui();

      type('/login');
      await vi.waitFor(() => expect(fakeTerminal.suspend).toHaveBeenCalled());
      child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));

      await vi.waitFor(() => expect(fakeTerminal.resume).toHaveBeenCalled());
      await vi.waitFor(() => expect(frame()).toContain('Could not run claude'));
      vi.unstubAllEnvs();
    });

    it('lets the login keep its own Ctrl-C, so cancelling it does not take the TUI down', async () => {
      const { child } = await signedOutTui();

      type('/login');
      await vi.waitFor(() => expect(fakeTerminal.suspend).toHaveBeenCalled());
      // The tty delivers Ctrl-C to the whole foreground group, the child
      // included; the parent's handler must leave the login to it.
      process.emit('SIGINT');
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', 130, null);
      await vi.waitFor(() => expect(fakeTerminal.resume).toHaveBeenCalled());
      vi.unstubAllEnvs();
    });
  });
});
