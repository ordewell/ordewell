import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { delimiter } from 'node:path';
import { ModelResolver, RunnerInstallation, RunnerRegistry, recordRunnerAuth, recordedRunnerAuth, resetRunnerAuth, runnerSignIn, signedOutAuth, type DiscoveredModel, type LaunchDeps, type PlannerBackendId, type RunnerAuth } from '@ordewell/core';
import { loginPlanner, type PlannerLoginDeps } from '../PlannerLogin';
import { wrappedCommand } from '../loginTerminal';

/** Every attempt's status dir must be gone once its login has ended. */
const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeTerminal {
  options: { name?: string; cwd?: string; shellPath?: string; shellArgs?: string[] | string; env?: Record<string, string>; isTransient?: boolean };
  sent: string[];
  shown: number;
  disposed: number;
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
  /** The login process exits with `code` once this many polls have slept; `undefined` is the user closing it. */
  exitAfter?: { polls: number; code: number | undefined };
  /**
   * The real POSIX/Windows wrapper writes `code` to its status file after this
   * many polls and stays alive (holding its failed output open), so VS Code sets
   * no exitStatus. The completion signal is then the status file alone.
   */
  statusAfter?: { polls: number; code: number };
  /** POSIX unless a case is about Windows, so the terminal options read the same on every host. */
  platform?: NodeJS.Platform;
  /** Where the agent's file is found; by default only the stand-ins in {@link FAKE_BIN}. */
  launch?: Omit<LaunchDeps, 'platform'>;
  /** The real installation and catalog, for a case about what a recheck records. */
  runnerInstallation?: PlannerLoginDeps['runnerInstallation'];
  modelResolver?: PlannerLoginDeps['modelResolver'];
}

/** A folder holding a stand-in for each agent these cases name, and nothing else: no agent installed on the host answers. */
const FAKE_BIN = '/fake/bin';
const STAND_INS = new Set(['claude', 'codex', 'copilot', 'cursor-agent', 'cline'].map((name) => `${FAKE_BIN}/${name}`));
const STAND_IN_LAUNCH = { resolvePath: async () => FAKE_BIN, exists: (file: string) => STAND_INS.has(file) };

const SIGNED_OUT_CLAUDE: RunnerAuth = { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] };

function harness(options: HarnessOptions = {}) {
  let probe = 0;
  let clock = 0;
  let polls = 0;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-planner-login-'));
  tempRoots.push(tempRoot);
  let batchText: string | undefined;
  const closeListeners: Array<(terminal: FakeTerminal) => void> = [];
  const terminal: FakeTerminal = {
    options: {},
    sent: [],
    shown: 0,
    disposed: 0,
    exitStatus: undefined,
    sendText(text: string) { terminal.sent.push(text); },
    show() { terminal.shown += 1; },
    dispose() { terminal.disposed += 1; if (!terminal.exitStatus) exit(undefined); },
  };
  const createTerminal = vi.fn((opts: FakeTerminal['options']) => {
    terminal.options = opts;
    // buildLoginTerminal wrote a Windows wrapper batch into the status dir just
    // before createTerminal; snapshot it before cleanup removes the dir.
    for (const dir of fs.readdirSync(tempRoot)) {
      for (const file of fs.readdirSync(path.join(tempRoot, dir))) {
        if (file.endsWith('.cmd')) batchText = fs.readFileSync(path.join(tempRoot, dir, file), 'utf8');
      }
    }
    return terminal;
  });
  // As VS Code does: the exit status is set, then the close event fires, once
  // the terminal's process ends or the user closes it. (A held-open wrapper
  // sets neither; those cases drive completion from the status file instead.)
  const exit = (code: number | undefined): void => {
    terminal.exitStatus = { code };
    for (const cb of [...closeListeners]) cb(terminal);
  };
  const close = (): void => exit(undefined);

  const verdict = options.verdict ?? (() => SIGNED_OUT_CLAUDE);
  const deps = {
    runnerInstallation: options.runnerInstallation ?? {
      runnerUsability: vi.fn(async () => {
        probe += 1;
        options.afterProbe?.(probe, close);
        return { usable: true, auth: verdict(probe) };
      }),
      refresh: vi.fn(),
      // Forgets what was recorded; the look after it is the next probe.
      recheck: vi.fn(async () => ({ usable: true })),
    },
    ...(options.modelResolver ? { modelResolver: options.modelResolver } : {}),
    launch: options.launch ?? STAND_IN_LAUNCH,
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
    loginTempRoot: () => tempRoot,
    // Instant, and a clock that moves with it: no real seconds, no fake timers.
    sleep: async (ms: number) => {
      clock += ms;
      polls += 1;
      // The real wrapper writes its status file and stays alive: no exitStatus.
      if (options.statusAfter && polls === options.statusAfter.polls) {
        const dir = fs.readdirSync(tempRoot).filter((n) => n.startsWith('ordewell-login-'))[0];
        if (dir) fs.writeFileSync(path.join(tempRoot, dir, 'status'), `${options.statusAfter.code}\n`);
      }
      if (options.exitAfter && polls === options.exitAfter.polls) exit(options.exitAfter.code);
    },
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
    exit,
    tempRoot,
    /** The Windows wrapper batch written for this attempt, if any. */
    batch: () => batchText,
    /** The agent command the wrapper will run, read back from the options. */
    command: () => wrappedCommand(terminal.options),
    /** The last word the webview is told the login ended with. */
    ended: () => vi.mocked(deps.post).mock.calls.map(([msg]) => msg).filter((msg) => msg.type === 'plannerLoginEnded').at(-1),
  };
}

describe('loginPlanner', () => {
  // #62 F1: typed into the user's own shell, the login's end was never seen:
  // the shell outlives it, so the spinner ran until the terminal was closed or
  // five minutes passed. The agent is the terminal's process now.
  it('logs safe launch and exit diagnostics without arguments or environment values', async () => {
    const h = harness({ aiProvider: 'cursor-agent', verdict: () => ({ state: 'signed-out', loginCommand: ['cursor-agent', 'secret-argument'] }), exitAfter: { polls: 1, code: 1 } });
    await loginPlanner(h.deps);
    expect(h.deps.log).toHaveBeenCalledWith('Login launch: runner=cursor-agent platform=linux');
    expect(h.deps.log).toHaveBeenCalledWith('Login exit: runner=cursor-agent code=1');
    expect(JSON.stringify(vi.mocked(h.deps.log!).mock.calls)).not.toMatch(/secret-argument|accounts\/other/);
  });

  // The wrapper writes the login's real exit code to a status file and, on a
  // failure, holds the shell (and its output) open. VS Code therefore sets no
  // exitStatus, so the status file is the only completion signal.
  it('ends a failed login from its status file while the terminal stays open with its output', async () => {
    const h = harness({
      aiProvider: 'cursor-agent',
      verdict: () => ({ state: 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
      statusAfter: { polls: 1, code: 3 },
    });

    await loginPlanner(h.deps);

    const message = 'The Cursor login exited with code 3. Run /login cursor-agent to retry and recheck sign-in.';
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: false, message });
    expect(h.deps.notifications.warn).toHaveBeenCalledWith(`Ordewell could not confirm the Cursor login. ${message}`);
    // No exitStatus: the wrapper is alive, holding the failed output on screen;
    // the terminal is not disposed, so the scrollback is still accessible.
    expect(h.terminal.exitStatus).toBeUndefined();
    expect(h.terminal.disposed).toBe(0);
    expect(h.deps.log).toHaveBeenCalledWith('Login exit: runner=cursor-agent code=3');
    // A failed login is no recheck (ADR-0052): its blocker stays.
    expect(h.deps.runnerInstallation.recheck).not.toHaveBeenCalled();
    expect(h.deps.sendState).not.toHaveBeenCalled();
  });

  it('rechecks a successful login read from its status file, without an exitStatus', async () => {
    let rechecked = false;
    const h = harness({
      aiProvider: 'cursor-agent',
      verdict: () => ({ state: rechecked ? 'signed-in' : 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
      statusAfter: { polls: 1, code: 0 },
    });
    const recheck = vi.fn(async () => { rechecked = true; return { usable: true, auth: { state: 'unknown' as const } }; });
    Object.assign(h.deps.runnerInstallation, { recheck });

    await loginPlanner(h.deps);

    expect(h.terminal.exitStatus).toBeUndefined();
    expect(recheck).toHaveBeenCalledWith('cursor-agent');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });
  });

  it('makes and removes the wrapper status dir around the attempt', async () => {
    const h = harness({ exitAfter: { polls: 1, code: 0 } });
    let during: string[] = [];
    const sleep = h.deps.sleep!;
    Object.assign(h.deps, {
      sleep: async (ms: number) => {
        during = fs.readdirSync(h.tempRoot);
        await sleep(ms);
      },
    });

    await loginPlanner(h.deps);

    expect(during.some((n) => n.startsWith('ordewell-login-'))).toBe(true);
    expect(fs.readdirSync(h.tempRoot)).toEqual([]);
  });

  it("rechecks Cursor's login when the wrapper process itself exits 0", async () => {
    let rechecked = false;
    const h = harness({
      aiProvider: 'cursor-agent',
      verdict: () => ({ state: rechecked ? 'signed-in' : 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
      exitAfter: { polls: 1, code: 0 },
    });
    const recheck = vi.fn(async () => { rechecked = true; return { usable: true, auth: { state: 'unknown' as const } }; });
    Object.assign(h.deps.runnerInstallation, { recheck });

    await loginPlanner(h.deps);

    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Cursor login',
      cwd: '/ws',
      shellPath: '/bin/sh',
      isTransient: true,
    }));
    expect(h.command()).toEqual(['/fake/bin/cursor-agent', 'login']);
    expect(h.terminal.sent).toEqual([]);
    expect(h.terminal.shown).toBe(1);
    expect(recheck).toHaveBeenCalledWith('cursor-agent');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });
  });

  it('signs in the active planner when the message names no runner, in its own terminal', async () => {
    // Signed out while it opens the terminal, signed in on the second poll.
    const h = harness({ verdict: (probe) => (probe >= 3 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.runnerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Claude Code login',
      cwd: '/ws',
      shellPath: '/bin/sh',
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/accounts/other' }),
      isTransient: true,
    }));
    expect(h.command()).toEqual(['/fake/bin/claude', 'auth', 'login']);
    expect(h.terminal.shown).toBe(1);
    // The manifest's own argv, handed to the wrapper as parameters; nothing typed.
    expect(h.terminal.sent).toEqual([]);
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
    // The real augmented PATH, with every file on it standing in for the agent.
    const h = harness({
      verdict: (probe) => (probe >= 3 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE),
      launch: { exists: () => true },
    });

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

  // #62 F3: typed into a login shell, the name was found again after its
  // startup files ran, so an rc file's PATH or alias could start another binary.
  it('starts the first file on the probe\'s PATH, by its full path, with the wrapper never re-finding the name', async () => {
    const h = harness({
      aiProvider: 'cline',
      verdict: () => ({ state: 'signed-out', loginCommand: ['cline', 'auth'] }),
      exitAfter: { polls: 1, code: 0 },
      launch: {
        resolvePath: async () => '/opt/homebrew/bin:/Users/me/.local/bin:/usr/local/bin',
        exists: (file) => file === '/Users/me/.local/bin/cline' || file === '/usr/local/bin/cline',
      },
    });

    await loginPlanner(h.deps, 'cline');

    expect(h.command()).toEqual(['/Users/me/.local/bin/cline', 'auth']);
    expect(h.terminal.options.shellPath).toBe('/bin/sh');
    // The terminal's own PATH is the one the file was found on, under the host's spelling.
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    expect(h.terminal.options.env?.[pathKey]).toBe('/opt/homebrew/bin:/Users/me/.local/bin:/usr/local/bin');
    expect(h.terminal.sent).toEqual([]);
  });

  it('says the login could not start, and opens no terminal, when the agent is not on that PATH', async () => {
    const h = harness({
      aiProvider: 'cursor-agent',
      verdict: () => ({ state: 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
      launch: { resolvePath: async () => '/nowhere', exists: () => false },
    });

    await loginPlanner(h.deps);

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'cursor-agent', ok: false,
      message: 'The Cursor login could not be started. Could not find "cursor-agent" on PATH.',
    });
    // The folders searched are the log's, not the row's.
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('/nowhere'));
  });

  describe('on Windows', () => {
    const WIN_BIN = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const CMD = 'C:\\Windows\\System32\\cmd.exe';
    /** A shim as npm's cmd-shim writes it, CRLF and all, starting `target` (relative to the shim) with node. */
    const npmNodeShim = (target: string): string => [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
    ].join('\r\n');
    const windows = (files: Record<string, string>): Omit<LaunchDeps, 'platform'> => ({
      resolvePath: async () => WIN_BIN,
      exists: (file) => file in files,
      readShim: (file) => files[file],
      pathExt: () => '.COM;.EXE;.BAT;.CMD',
      comSpec: () => CMD,
    });
    const codexSignedOut = { state: 'signed-out' as const, loginCommand: ['codex', 'login'] };

    // Windows PowerShell picks npm's codex.ps1 over codex.cmd and, under the
    // default Restricted policy, refuses to run it: the wrapper runs the shim's node target directly.
    it("starts an npm shim's own script with the node beside it, as a spawn does", async () => {
      const h = harness({
        platform: 'win32',
        verdict: (probe) => (probe >= 3 ? { ...codexSignedOut, state: 'signed-in' } : codexSignedOut),
        launch: windows({
          [`${WIN_BIN}\\codex.cmd`]: npmNodeShim('node_modules\\@openai\\codex\\bin\\codex.js'),
          [`${WIN_BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
          [`${WIN_BIN}\\node.exe`]: '',
        }),
      });

      await loginPlanner(h.deps, 'codex');

      // The Windows wrapper is cmd.exe running a batch that starts the shim's
      // own resolved target; the command line stays inside the batch, not typed.
      expect(h.terminal.options.shellPath).toBe(CMD);
      expect(h.terminal.options.shellArgs as string).toMatch(/^\/d \/s \/c /);
      expect(h.batch()).toContain(`${WIN_BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`);
      expect(h.batch()).toContain('login');
      expect(h.terminal.sent).toEqual([]);
      expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: true });
    });

    it('runs a batch file of its own through cmd.exe, its line handed over as written', async () => {
      const h = harness({
        platform: 'win32',
        aiProvider: 'cursor-agent',
        verdict: () => ({ state: 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
        exitAfter: { polls: 1, code: 0 },
        launch: windows({ [`${WIN_BIN}\\cursor-agent.cmd`]: '@echo off\r\npowershell -File "%~dp0cursor-agent.ps1" %*\r\n' }),
      });

      await loginPlanner(h.deps);

      // A lone .cmd keeps its verbatim command line, now embedded in the batch.
      expect(h.terminal.options.shellPath).toBe(CMD);
      expect(h.terminal.options.shellArgs as string).toMatch(/^\/d \/s \/c /);
      expect(h.batch()).toContain(`cursor-agent.cmd login`);
    });

    it('starts a native executable directly', async () => {
      const h = harness({
        platform: 'win32',
        aiProvider: 'cursor-agent',
        verdict: () => ({ state: 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
        exitAfter: { polls: 1, code: 0 },
        launch: windows({ [`${WIN_BIN}\\cursor-agent.exe`]: '', [`${WIN_BIN}\\cursor-agent.cmd`]: '@echo off\r\n' }),
      });

      await loginPlanner(h.deps);

      // Even a native exe is wrapped, so a failed login's output is retained.
      expect(h.terminal.options.shellPath).toBe(CMD);
      expect(h.batch()).toContain(`${WIN_BIN}\\cursor-agent.exe`);
      expect(h.batch()).toContain('login');
      expect(h.batch()).toContain('pause');
    });
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
    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'Codex login', shellPath: '/bin/sh' }));
    expect(h.command()).toEqual(['/fake/bin/codex', 'login']);
    expect(h.deps.config.aiProvider).toBe('claude-code');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: true });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Signed in to Codex.');
  });

  it("runs a task-only agent's own login, though it cannot plan", async () => {
    // Copilot has a login but no status command, so the sign-in cannot be
    // confirmed by a probe; the terminal still runs the manifest's argv.
    const h = harness({ verdict: () => ({ state: 'unknown', loginCommand: ['copilot', 'login'] }), exitAfter: { polls: 2, code: undefined } });

    await loginPlanner(h.deps, 'copilot-cli');

    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'GitHub Copilot CLI login', shellPath: '/bin/sh' }));
    expect(h.command()).toEqual(['/fake/bin/copilot', 'login']);
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

  it.each([
    ['opencode', 'OpenCode has no login Ordewell can run. Run opencode auth login and choose a provider.'],
    ['qwen-code', 'Qwen Code has no login Ordewell can run. Run /key-set and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.'],
  ])('names the other ways into %s where it has no login to run', async (runner, message) => {
    const h = harness({ verdict: () => ({ state: 'signed-out', signIn: runnerSignIn(runner)! }) });

    await loginPlanner(h.deps, runner);

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.notifications.info).toHaveBeenCalledWith(message);
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner, ok: false, message });
  });

  it('points a provider runner at its key, the only sign-in it has, and opens no terminal', async () => {
    const h = harness({ verdict: () => ({ state: 'signed-in' }) });

    await loginPlanner(h.deps, 'openrouter');

    const message = 'OpenRouter has no login: it runs on its API key, which /key-set openrouter replaces.';
    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.notifications.info).toHaveBeenCalledWith(message);
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'openrouter', ok: false, message });
  });

  it('points Custom at its endpoint, which may take no key at all', async () => {
    const h = harness({ verdict: () => ({ state: 'signed-in' }) });

    await loginPlanner(h.deps, 'openai_compatible');

    const message = 'Custom has no login: it runs on the endpoint OPENAI_COMPATIBLE_BASE_URL names, which /key-set openai_compatible replaces.';
    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'openai_compatible', ok: false, message });
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
    // A closed login is no recheck (ADR-0052): what was recorded stands.
    expect(h.deps.runnerInstallation.recheck).not.toHaveBeenCalled();
    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The terminal closed before sign-in finished.',
    });
    expect(h.deps.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
  });

  // ADR-0052, #46 F7: Cursor has no status command, so no poll can confirm its
  // login. Its exit is when it is asked again, once, by the agent's own
  // handshake, and only that answer says it is signed in.
  it.each([
    ['unknown', { ok: false, message: 'The login finished, but Cursor cannot say whether it is signed in. Send again to try it.' }],
    ['signed-out', { ok: false, message: 'Cursor still reports not logged in.' }],
    ['signed-in', { ok: true }],
  ] as const)('rechecks an agent with no status command once its login exits 0: %s', async (answer, ended) => {
    // The recheck records what the agent answered, which every later look reads.
    let rechecked = false;
    const h = harness({
      aiProvider: 'cursor-agent',
      verdict: () => ({ state: rechecked ? answer : 'signed-out', loginCommand: ['cursor-agent', 'login'] }),
      exitAfter: { polls: 3, code: 0 },
    });
    const recheck = vi.fn(async () => { rechecked = true; return { usable: true, auth: { state: answer } }; });
    Object.assign(h.deps.runnerInstallation, { recheck });

    await loginPlanner(h.deps);

    expect(recheck).toHaveBeenCalledWith('cursor-agent');
    // No status command, so the wait polled nothing: one look before, one after.
    expect(h.deps.runnerInstallation.runnerUsability).toHaveBeenCalledTimes(2);
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'cursor-agent', ...ended });
    // The recheck changed what is recorded, so both roles are redrawn from it.
    expect(h.deps.sendState).toHaveBeenCalled();
  });

  // A login that failed or was cancelled is no recheck (ADR-0052): its blocker
  // stays, and the send gate still asks the agent before the next turn.
  it.each([
    [1, 'The Cursor login exited with code 1. Run /login cursor-agent to retry and recheck sign-in.'],
    [undefined, 'The terminal closed before sign-in finished.'],
  ] as const)('ends a login that exits %s as a failure, keeping what was recorded', async (code, message) => {
    const h = harness({ aiProvider: 'cursor-agent', verdict: () => ({ state: 'signed-out', loginCommand: ['cursor-agent', 'login'] }), exitAfter: { polls: 2, code } });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.recheck).not.toHaveBeenCalled();
    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'cursor-agent', ok: false, message });
    expect(h.deps.notifications.warn).toHaveBeenCalledWith(`Ordewell could not confirm the Cursor login. ${message}`);
  });

  it('asks a status command once more when the login exits between two polls', async () => {
    // Signed in by the time it exits, before any poll saw it.
    const h = harness({ verdict: (probe) => (probe >= 2 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE), exitAfter: { polls: 1, code: 0 } });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.recheck).toHaveBeenCalledWith('claude-code');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
  });

  it.each([
    ['claude-code', SIGNED_OUT_CLAUDE],
    ['cursor-agent', { state: 'signed-out', loginCommand: ['cursor-agent', 'login'] } as RunnerAuth],
  ])('ends %s\'s login, terminal and all, after the time limit, with the reason inline', async (runner, auth) => {
    const h = harness({ timeoutMs: 60_000, verdict: () => auth });

    await loginPlanner(h.deps, runner);

    expect(h.terminal.disposed).toBe(1);
    expect(h.deps.runnerInstallation.recheck).not.toHaveBeenCalled();
    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner, ok: false, message: 'Sign-in did not finish in time.',
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
  // after the terminal exists (a terminal disposed between create and show, say)
  // must still end the attempt, or the button stays disabled until a reload.
  it('ends the attempt as a failure when showing the terminal throws', async () => {
    const h = harness();
    h.terminal.show = () => { throw new Error('terminal was disposed'); };

    await loginPlanner(h.deps);

    expect(h.ended()).toMatchObject({ type: 'plannerLoginEnded', runner: 'claude-code', ok: false });
    expect((h.ended() as { message?: string }).message).toBeTruthy();
  });
});

/**
 * The real installation and catalog, with the agent's ACP handshake faked: what
 * a login's recheck records is what the send gate and both pickers read next.
 */
describe('the recheck after a login, on the real installation', () => {
  let store: string | undefined;
  afterEach(() => {
    resetRunnerAuth();
    if (store) fs.rmSync(store, { recursive: true, force: true });
    store = undefined;
  });

  /**
   * The provider store `cline auth` leaves behind, which Cline's start reads
   * before any handshake (the key is a placeholder): with none, Cline is
   * refused before it is asked, which its readiness work owns.
   */
  function clineStore(): Record<string, string> {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-cline-store-'));
    const file = path.join(store, 'providers.json');
    fs.writeFileSync(file, JSON.stringify({ lastUsedProvider: 'openrouter', providers: { openrouter: { settings: { provider: 'openrouter', apiKey: 'placeholder' } } } }));
    return { CLINE_PROVIDER_SETTINGS_PATH: file };
  }

  function real(runner: 'cursor-agent' | 'cline', answer: 'signed-out' | DiscoveredModel[]) {
    const registry = new RunnerRegistry();
    const config = { aiProvider: runner as PlannerBackendId, getProviderApiKey: () => '', planningModel: '', orchestratorModel: '', openaiCompatibleBaseUrl: '' };
    const acpClient = vi.fn(async () => answer);
    const env = runner === 'cline' ? clineStore() : {};
    const modelResolver = new ModelResolver(registry, config as never, { env: async () => env, acpClient, workspace: () => '/ws', execImpl: async () => ({ stdout: '' }) });
    const installation = new RunnerInstallation(registry, async () => ({ stdout: '2026.10.22' }), Date.now, { launch: { platform: 'linux' }, workspace: () => '/ws' });
    // A turn found it signed out: the blocker a probe with no status command cannot clear.
    recordRunnerAuth(runner, signedOutAuth(runnerSignIn(runner)!), '/ws');
    return { acpClient, modelResolver, installation };
  }

  it.each(['cursor-agent', 'cline'] as const)('clears %s\'s recorded blocker once its handshake opens a session', async (runner) => {
    const r = real(runner, []);
    const h = harness({ aiProvider: runner, runnerInstallation: r.installation, modelResolver: r.modelResolver, exitAfter: { polls: 2, code: 0 } });

    await loginPlanner(h.deps, runner);

    expect(h.command()).toEqual([`/fake/bin/${runner}`, ...runnerSignIn(runner)!.login!.slice(1)]);
    expect(r.acpClient).toHaveBeenCalled();
    expect(recordedRunnerAuth(runner, '/ws')?.state).toBe('signed-in');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner, ok: true });
    expect(h.deps.sendState).toHaveBeenCalled();
  });

  it.each([['cursor-agent', 'Cursor'], ['cline', 'Cline']] as const)('keeps %s\'s blocker when its handshake still refuses, though the login exited 0', async (runner, label) => {
    const r = real(runner, 'signed-out');
    const h = harness({ aiProvider: runner, runnerInstallation: r.installation, modelResolver: r.modelResolver, exitAfter: { polls: 1, code: 0 } });

    await loginPlanner(h.deps, runner);

    expect(r.acpClient).toHaveBeenCalled();
    expect(recordedRunnerAuth(runner, '/ws')?.state).toBe('signed-out');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner, ok: false, message: `${label} still reports not logged in.` });
    // Both pickers are redrawn from the blocker it recorded again.
    expect(h.deps.sendState).toHaveBeenCalled();
  });
  /** A store path with nothing there yet, which Cline's hook reads before it would spawn Cline. */
  function emptyClineStore(): { env: Record<string, string>; file: string } {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-cline-store-'));
    const file = path.join(store, 'providers.json');
    return { env: { CLINE_PROVIDER_SETTINGS_PATH: file }, file };
  }

  function keylessCline(env: Record<string, string>) {
    const registry = new RunnerRegistry();
    const config = { aiProvider: 'cline' as PlannerBackendId, getProviderApiKey: () => '', planningModel: '', orchestratorModel: '', openaiCompatibleBaseUrl: '' };
    const acpClient = vi.fn(async (_command: string, _args: string[], _opts?: { env?: Record<string, string | undefined> }) => [] as DiscoveredModel[]);
    const modelResolver = new ModelResolver(registry, config as never, { env: async () => env, acpClient, workspace: () => '/ws', execImpl: async () => ({ stdout: '' }) });
    const installation = new RunnerInstallation(registry, async () => ({ stdout: '3.0.74' }), Date.now, { launch: { platform: 'linux' }, workspace: () => '/ws' });
    // What discovery records when Cline's hook found no provider key: Cline was never asked.
    recordRunnerAuth('cline', signedOutAuth({ ...runnerSignIn('cline')!, needsKey: true }, 'no provider key'), '/ws');
    return { acpClient, modelResolver, installation };
  }

  it("says Ordewell still has no key, not that Cline refused, when Cline's setup exits 0 and its hook still finds none", async () => {
    const { env } = emptyClineStore();
    const r = keylessCline(env);
    const h = harness({ aiProvider: 'cline', runnerInstallation: r.installation, modelResolver: r.modelResolver, exitAfter: { polls: 1, code: 0 } });

    await loginPlanner(h.deps, 'cline');

    expect(h.command()).toEqual(['/fake/bin/cline', 'auth']);
    // Refused before any spawn: no ACP reply exists to attribute to Cline.
    expect(r.acpClient).not.toHaveBeenCalled();
    expect(recordedRunnerAuth('cline', '/ws')).toMatchObject({ state: 'signed-out', detail: 'no provider key', signIn: { needsKey: true } });
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'cline', ok: false,
      message: 'The Cline setup finished, but Ordewell still has no provider API key it can hand Cline. Set it up with /login cline, or run cline auth, and choose an API provider and enter its key; an account sign-in alone is not enough.',
    });
    expect(h.deps.sendState).toHaveBeenCalled();
  });

  it('turns Cline ready once its setup leaves a provider key in the store, in the shape `cline auth` 3.0.74 writes', async () => {
    const { env, file } = emptyClineStore();
    const r = keylessCline(env);
    const h = harness({ aiProvider: 'cline', runnerInstallation: r.installation, modelResolver: r.modelResolver, exitAfter: { polls: 1, code: 0 } });
    // As `cline auth -p openrouter -k <key> -m <model>` left it in a throwaway HOME (the key is a placeholder).
    const sleep = h.deps.sleep!;
    Object.assign(h.deps, {
      sleep: async (ms: number) => {
        fs.writeFileSync(file, JSON.stringify({
          version: 1, lastUsedProvider: 'openrouter', modes: {},
          providers: { openrouter: { settings: { provider: 'openrouter', apiKey: 'sk-or-placeholder', model: 'anthropic/claude-sonnet-4' }, updatedAt: '2026-11-25T22:04:48.563Z', tokenSource: 'manual' } },
        }));
        await sleep(ms);
      },
    });

    await loginPlanner(h.deps, 'cline');

    expect(r.acpClient).toHaveBeenCalled();
    expect(r.acpClient.mock.calls.at(-1)?.[2]?.env).toMatchObject({ CLINE_PROVIDER: 'openrouter', CLINE_API_KEY: 'sk-or-placeholder', CLINE_MODEL: 'anthropic/claude-sonnet-4' });
    expect(recordedRunnerAuth('cline', '/ws')?.state).toBe('signed-in');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'cline', ok: true });
  });
});
