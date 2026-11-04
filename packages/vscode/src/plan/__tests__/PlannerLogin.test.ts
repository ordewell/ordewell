import { describe, it, expect, vi } from 'vitest';
import { delimiter } from 'node:path';
import { RunnerRegistry, type RunnerAuth } from '@ordewell/core';
import { commandLine, loginPlanner, type PlannerLoginDeps } from '../PlannerLogin';

interface FakeTerminal {
  options: { name?: string; cwd?: string; shellPath?: string; env?: Record<string, string> };
  sent: string[];
  shown: number;
  exitStatus: { code: number | undefined } | undefined;
  sendText(text: string): void;
  show(): void;
  dispose(): void;
}

interface HarnessOptions {
  aiProvider?: string;
  /** What probe `n` answers; probe 1 is the verdict read before the terminal opens. */
  verdict?: (probe: number) => RunnerAuth | undefined;
  /** Runs right after each probe answers, so a test can close the terminal mid-flow. */
  afterProbe?: (probe: number, close: () => void) => void;
  timeoutMs?: number;
  /** POSIX unless a case is about Windows, so the terminal options read the same on every host. */
  platform?: NodeJS.Platform;
}

const SIGNED_OUT_CLAUDE: RunnerAuth = { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] };

function harness(options: HarnessOptions = {}) {
  let probe = 0;
  let clock = 0;
  const closeListeners: Array<(terminal: FakeTerminal) => void> = [];
  const terminal: FakeTerminal = {
    options: {},
    sent: [],
    shown: 0,
    exitStatus: undefined,
    sendText(text: string) { terminal.sent.push(text); },
    show() { terminal.shown += 1; },
    dispose() { close(); },
  };
  const createTerminal = vi.fn((opts: FakeTerminal['options']) => {
    terminal.options = opts;
    return terminal;
  });
  const close = (): void => {
    terminal.exitStatus = { code: 0 };
    for (const cb of [...closeListeners]) cb(terminal);
  };

  const verdict = options.verdict ?? (() => SIGNED_OUT_CLAUDE);
  const deps = {
    runnerInstallation: {
      runnerUsability: vi.fn(async () => {
        probe += 1;
        options.afterProbe?.(probe, close);
        return { usable: true, auth: verdict(probe) };
      }),
      refresh: vi.fn(),
    },
    // The real registry: the ids and labels a webview can name are its own.
    runnerRegistry: new RunnerRegistry(),
    config: { aiProvider: options.aiProvider ?? 'claude-code' },
    workspaceRoot: () => '/ws',
    env: async () => ({ CLAUDE_CONFIG_DIR: '/accounts/other' }),
    sendState: vi.fn(async () => {}),
    post: vi.fn(),
    notifications: { info: vi.fn(), warn: vi.fn() },
    window: {
      createTerminal,
      onDidCloseTerminal: vi.fn((cb: (t: FakeTerminal) => void) => {
        closeListeners.push(cb);
        return { dispose: vi.fn() };
      }),
    },
    // Instant, and a clock that moves with it: no real seconds, no fake timers.
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    platform: options.platform ?? 'linux',
    log: vi.fn(),
  } as unknown as PlannerLoginDeps;

  return {
    deps,
    terminal,
    createTerminal,
    close,
    /** The last word the webview is told the login ended with. */
    ended: () => vi.mocked(deps.post).mock.calls.map(([msg]) => msg).filter((msg) => msg.type === 'plannerLoginEnded').at(-1),
  };
}

describe('loginPlanner', () => {
  it('signs in the active planner when the message names no runner, in its own terminal', async () => {
    // Signed out while it opens the terminal, signed in on the second poll.
    const h = harness({ verdict: (probe) => (probe >= 3 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.runnerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.createTerminal).toHaveBeenCalledWith({
      name: 'Claude Code login',
      cwd: '/ws',
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/accounts/other' }),
    });
    expect(h.terminal.shown).toBe(1);
    // The manifest's own argv, typed into the terminal exactly once.
    expect(h.terminal.sent).toEqual(['claude auth login']);
    expect(h.deps.runnerInstallation.refresh).toHaveBeenCalled();
    expect(h.deps.sendState).toHaveBeenCalled();
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Signed in to Claude Code.');
    expect(h.deps.notifications.warn).not.toHaveBeenCalled();
  });

  it('opens the login terminal on the same augmented PATH the probe found the agent with', async () => {
    // A GUI-launched extension host inherits a minimal PATH; the terminal the
    // login runs in must see the directories the probe resolved, or the agent
    // it just found is ENOENT in its own login.
    const h = harness({ verdict: (probe) => (probe >= 3 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });

    await loginPlanner(h.deps);

    const env = h.terminal.options.env as Record<string, string>;
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    expect(env[pathKey]).toBeTruthy();
    // Augmented, not merely inherited: every inherited directory survives (the
    // resolver de-duplicates, so compare segments).
    const segments = env[pathKey].split(delimiter);
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) expect(segments).toContain(dir);
    // The workspace's own account still rides along (ADR-0016).
    expect(env.CLAUDE_CONFIG_DIR).toBe('/accounts/other');
  });

  it('runs the login in cmd.exe on Windows, whatever the default terminal is', async () => {
    // Windows PowerShell picks npm's codex.ps1 over codex.cmd and, under the
    // default Restricted policy, refuses to run it.
    const h = harness({
      platform: 'win32',
      verdict: (probe) => (probe >= 3
        ? { state: 'signed-in', loginCommand: ['codex', 'login'] }
        : { state: 'signed-out', loginCommand: ['codex', 'login'] }),
    });

    await loginPlanner(h.deps, 'codex');

    expect(h.terminal.options.shellPath).toMatch(/cmd\.exe$/i);
    expect(h.terminal.sent).toEqual(['codex login']);
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: true });
  });

  it('leaves the shell to the user default off Windows', async () => {
    const h = harness({ verdict: (probe) => (probe >= 3 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });

    await loginPlanner(h.deps);

    expect(h.terminal.options).not.toHaveProperty('shellPath');
  });

  it('signs in a named runner without making it the planner', async () => {
    const h = harness({
      aiProvider: 'claude-code',
      verdict: (probe) => (probe >= 3
        ? { state: 'signed-in', loginCommand: ['codex', 'login'] }
        : { state: 'signed-out', loginCommand: ['codex', 'login'] }),
    });

    await loginPlanner(h.deps, 'codex');

    expect(h.deps.runnerInstallation.runnerUsability).toHaveBeenCalledWith('codex');
    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'Codex login' }));
    expect(h.terminal.sent).toEqual(['codex login']);
    expect(h.deps.config.aiProvider).toBe('claude-code');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: true });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Signed in to Codex.');
  });

  it("runs a task-only agent's own login, though it cannot plan", async () => {
    // Copilot has a login but no status command, so the sign-in cannot be
    // confirmed by a probe; the terminal still gets the manifest's argv.
    const h = harness({ verdict: () => ({ state: 'unknown', loginCommand: ['copilot', 'login'] }), afterProbe: (probe, close) => { if (probe >= 2) close(); } });

    await loginPlanner(h.deps, 'copilot-cli');

    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'GitHub Copilot CLI login' }));
    expect(h.terminal.sent).toEqual(['copilot login']);
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'copilot-cli', ok: false, message: 'The terminal closed before sign-in finished.' });
  });

  it('says so instead of opening a terminal for an agent it has no login for', async () => {
    const h = harness({ verdict: () => ({ state: 'unknown' }) });

    await loginPlanner(h.deps, 'opencode');

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Ordewell has no login for OpenCode.');
    // Still answers the click, or the row's button would wait forever.
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'opencode', ok: false, message: 'Ordewell has no login for OpenCode.',
    });
  });

  it('tells a vendor planner there is no coding agent to sign in', async () => {
    const h = harness({ aiProvider: 'openrouter' });

    await loginPlanner(h.deps);

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.notifications.info).toHaveBeenCalledWith('The active planner is not a coding agent; there is no login to run.');
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', ok: false, message: 'The active planner is not a coding agent; there is no login to run.',
    });
  });

  it('names why an installed agent is not usable instead of saying it has no login', async () => {
    const h = harness();
    vi.mocked(h.deps.runnerInstallation.runnerUsability).mockResolvedValue({ usable: false, reason: 'claude is not directly spawnable' });

    await loginPlanner(h.deps, 'claude-code');

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.notifications.info).toHaveBeenCalledWith('claude is not directly spawnable');
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'claude is not directly spawnable',
    });
  });

  it('ends the pending state when the first status probe throws', async () => {
    const h = harness();
    vi.mocked(h.deps.runnerInstallation.runnerUsability).mockRejectedValueOnce(new Error('probe failed'));

    await loginPlanner(h.deps, 'claude-code');

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: "The sign-in could not be checked: the agent's status probe failed.",
    });
    expect(h.deps.notifications.warn).toHaveBeenCalledWith("Ordewell could not check the Claude Code login. The sign-in could not be checked: the agent's status probe failed.");
  });

  it('does not blame the terminal when a poll probe throws', async () => {
    const h = harness();
    vi.mocked(h.deps.runnerInstallation.runnerUsability)
      .mockResolvedValueOnce({ usable: true, auth: SIGNED_OUT_CLAUDE })
      .mockRejectedValueOnce(new Error('probe failed'));

    await loginPlanner(h.deps, 'claude-code');

    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: "The sign-in could not be checked: the agent's status probe failed.",
    });
    expect(h.terminal.exitStatus).toBeUndefined();
  });

  it('tells the user when no terminal can be opened at all, and closes the pending state', async () => {
    const h = harness();
    h.createTerminal.mockImplementation(() => { throw new Error('no terminals'); });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.runnerUsability).toHaveBeenCalledTimes(1);
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The login terminal could not be opened.',
    });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Could not open a terminal to sign in to Claude Code.');
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('no terminals'));
  });

  it('does nothing for an id no runner manifest owns', async () => {
    const h = harness();

    await loginPlanner(h.deps, 'not-a-runner');

    expect(h.deps.runnerInstallation.runnerUsability).not.toHaveBeenCalled();
    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.post).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('not-a-runner'));
  });

  it('ends as a failure the moment the user closes the terminal, and stops polling', async () => {
    const h = harness({ afterProbe: (probe, close) => { if (probe === 2) close(); } });

    await loginPlanner(h.deps);

    expect(vi.mocked(h.deps.runnerInstallation.runnerUsability).mock.calls.length).toBe(2);
    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The terminal closed before sign-in finished.',
    });
    expect(h.deps.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
  });

  it('ends as a failure after the time limit, with the reason inline', async () => {
    const h = harness({ timeoutMs: 60_000, verdict: () => SIGNED_OUT_CLAUDE });

    await loginPlanner(h.deps);

    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'Sign-in did not finish in time.',
    });
  });

  it('does not report a signed-in agent as failed when the state push rejects', async () => {
    const h = harness({ verdict: (probe) => (probe >= 2 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });
    vi.mocked(h.deps.sendState).mockRejectedValueOnce(new Error('probe failed'));

    await loginPlanner(h.deps);

    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('probe failed'));
  });

  // The webview clears its pending button only on `plannerLoginEnded`. A throw
  // after the terminal exists (a terminal disposed between create and send, say)
  // must still end the attempt, or the button stays disabled until a reload.
  it('ends the attempt as a failure when writing to the terminal throws', async () => {
    const h = harness();
    h.terminal.sendText = () => { throw new Error('terminal was disposed'); };

    await loginPlanner(h.deps);

    expect(h.ended()).toMatchObject({ type: 'plannerLoginEnded', runner: 'claude-code', ok: false });
    expect((h.ended() as { message?: string }).message).toBeTruthy();
  });
});

describe('commandLine', () => {
  it('quotes only what the shell would split', () => {
    expect(commandLine(['claude', 'auth', 'login'], 'linux')).toBe('claude auth login');
    expect(commandLine(['/opt/My Agent/bin', '--config', '/a b/c'], 'linux')).toBe(`'/opt/My Agent/bin' --config '/a b/c'`);
  });

  it("quotes for cmd.exe on Windows, the login terminal's shell there", () => {
    expect(commandLine(['codex', 'login'], 'win32')).toBe('codex login');
    expect(commandLine(['C:\\Program Files\\Agent\\agent.exe', 'auth', 'login'], 'win32'))
      .toBe('"C:\\Program Files\\Agent\\agent.exe" auth login');
  });
});
