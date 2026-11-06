/**
 * What the desktop specs share to drive the built app offline: a temp git
 * repository under a temp HOME, the mock planner provider, a hermetic PATH whose
 * only runner is bench/pipeline's fake-claude, and the Electron launch.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../../..');
export const DESKTOP = path.join(ROOT, 'packages/desktop');

/** One spec's temp directory: HOME, the repository the app opens, and the PATH's own bin. */
export interface Sandbox {
  readonly tmp: string;
  readonly home: string;
  readonly repo: string;
  readonly userData: string;
  readonly fakeClaudeLog: string;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Polls a port until it is `up`, or not, for at most ten seconds. */
export async function untilListening(port: number, up: boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (await listening(port) === up) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function git(sandbox: Sandbox, ...args: string[]): string {
  return execFileSync('git', args, { cwd: sandbox.repo, encoding: 'utf8', env: { ...process.env, HOME: sandbox.home } });
}

/** A temp HOME with a git identity, and a repository with one commit on main. */
export function makeSandbox(prefix = 'ordewell-desktop-e2e-'): Sandbox {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const sandbox: Sandbox = {
    tmp,
    home: path.join(tmp, 'home'),
    repo: path.join(tmp, 'repo'),
    userData: path.join(tmp, 'user-data'),
    fakeClaudeLog: path.join(tmp, 'fake-claude.log'),
  };
  for (const dir of [sandbox.home, sandbox.repo]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(sandbox.home, '.gitconfig'), '[user]\n\tname = Desktop E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n');
  git(sandbox, 'init', '-q');
  fs.writeFileSync(path.join(sandbox.repo, 'README.md'), '# demo\n');
  git(sandbox, 'add', '.');
  git(sandbox, 'commit', '-qm', 'init');
  return sandbox;
}

/**
 * Only the fake runner, node and git are on PATH. With the machine's own PATH the
 * daemon's model discovery spawns whatever real codex or opencode is installed,
 * which is neither offline nor quick. The daemon still appends the login shell's
 * PATH and the usual install directories after this one, so codex and opencode
 * are stubs that fail as a missing command does, and shadow a real install.
 */
function hermeticPath(sandbox: Sandbox): string {
  const bin = path.join(sandbox.tmp, 'bin');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
    for (const absent of ['codex', 'opencode']) fs.writeFileSync(path.join(bin, absent), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  }
  return [path.join(ROOT, 'bench/pipeline/fake-claude'), bin, '/usr/bin', '/bin'].join(path.delimiter);
}

export interface EnvOptions {
  /** Leave out the mock planner provider, as a machine with no API key has none. */
  readonly noProvider?: boolean;
  /** The mock planner's persona (bench/live/mock-provider.mjs), which decides the plan it answers with. */
  readonly persona?: string;
  /** The agents enabled in Settings, where the default is Claude Code alone. */
  readonly runners?: string;
}

/** The environment of the app, or of a daemon started beside it: the same HOME, PATH and planner. */
export function appEnv(sandbox: Sandbox, daemonPort: number, mockPort: number, options: EnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A developer's own Ordewell, Claude Code or VS Code settings would steer the app under test.
    if (value === undefined || /^(ORDEWELL_|VSCODE_|CLAUDE)/.test(key) || key === 'ELECTRON_RUN_AS_NODE' || key === 'ANTHROPIC_API_KEY') continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: sandbox.home,
    PATH: hermeticPath(sandbox),
    ORDEWELL_PORT: String(daemonPort),
    ORDEWELL_NO_VERSION_CHECK: '1',
    ORDEWELL_ENABLED_RUNNERS: options.runners ?? 'claude-code',
    ...(options.noProvider ? {} : {
      AI_PROVIDER: 'openrouter',
      ORCHESTRATOR_MODEL: `mock/${options.persona ?? 'desktop-e2e'}`,
      OPENROUTER_API_KEY: 'mock-key',
      OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    }),
    FAKE_CLAUDE_LOG: sandbox.fakeClaudeLog,
  };
}

/** bench/live's mock provider on a free port, listening before this returns. */
export async function startMock(extraArgs: readonly string[] = []): Promise<{ port: number; process: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'bench/live/mock-provider.mjs'), '--port', String(port), ...extraArgs], { stdio: 'ignore' });
  // The planner's first turn must never meet a closed port.
  if (!await untilListening(port, true)) {
    child.kill();
    throw new Error(`the mock provider never listened on ${port}`);
  }
  return { port, process: child };
}

/** The switch main's testWindows.ts reads; main consults only that module. */
const TEST_WINDOWS_ENV = 'ORDEWELL_DESKTOP_TEST_WINDOWS';

/** Windows the polling loop found shown or focused, by app: the suite fails on any (see {@link closeApp}). */
const sightings = new WeakMap<ElectronApplication, { found: string[]; timer: NodeJS.Timeout }>();

/** The windows of the app that are visible or focused right now, as text; empty when the run is invisible. */
async function windowsOnShow(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const slot = globalThis as unknown as { ordewellShown?: string[] };
    return [
      ...(slot.ordewellShown ?? []),
      ...BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed() && (win.isVisible() || win.isFocused()))
        .map((win) => `"${win.getTitle()}" is ${win.isVisible() ? 'visible' : 'focused'}`),
    ];
  });
}

/**
 * Launches the app with its windows hidden (ORDEWELL_DESKTOP_TEST_WINDOWS), so
 * a run never opens a window on the developer's screen, takes focus or makes
 * macOS switch Space. The page renders as it would shown, and Playwright's own
 * input and focus emulation do not need the OS to focus the window.
 * What the run could not do invisibly would be a regression: a window that is
 * ever shown or focused fails the suite at {@link closeApp} and {@link openFolder}.
 */
export async function launchApp(sandbox: Sandbox, env: Record<string, string>): Promise<ElectronApplication> {
  const app = await electron.launch({
    // A Linux CI runner has no setuid chrome-sandbox, and its AppArmor forbids
    // the unprivileged user namespaces Chromium's sandbox falls back to.
    args: [DESKTOP, `--user-data-dir=${sandbox.userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...env, [TEST_WINDOWS_ENV]: 'hidden' },
    cwd: sandbox.tmp,
  });
  // A show or a focus is recorded as it happens, since a window shown and hidden again between two polls leaves no trace in a snapshot.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const slot = globalThis as unknown as { ordewellShown?: string[] };
    const shown: string[] = [];
    slot.ordewellShown = shown;
    const watch = (win: import('electron').BrowserWindow): void => {
      for (const event of ['show', 'focus', 'restore'] as const) win.on(event as 'show', () => { shown.push(`a window emitted "${event}"`); });
    };
    for (const win of BrowserWindow.getAllWindows()) watch(win);
    electronApp.on('browser-window-created', (_event, win) => { watch(win); });
  });
  const entry = { found: [] as string[], timer: setInterval(() => {
    windowsOnShow(app).then((now) => { if (now.length) entry.found.push(...now); }, () => undefined);
  }, 250) };
  entry.timer.unref();
  sightings.set(app, entry);
  return app;
}

/** Fails when a window of the app was ever shown or focused during the run. */
export async function assertWindowsHidden(app: ElectronApplication): Promise<void> {
  const found = [...(sightings.get(app)?.found ?? []), ...await windowsOnShow(app)];
  if (found.length) throw new Error(`a test run must open no visible window and never take focus, but: ${[...new Set(found)].join('; ')}`);
}

/** Closes the app after checking that the run stayed invisible; a close that fails is no failure of the run. */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  let hidden: Error | undefined;
  await assertWindowsHidden(app).catch((error: unknown) => { hidden = error instanceof Error && error.message.startsWith('a test run') ? error : undefined; });
  const entry = sightings.get(app);
  if (entry) clearInterval(entry.timer);
  await app.close().catch(() => undefined);
  if (hidden) throw hidden;
}

/** Opens `dir` from the welcome window's Open folder…, and returns the workspace window. */
export async function openFolder(app: ElectronApplication, welcome: Page, dir: string): Promise<Page> {
  // The native picker cannot be driven: main's dialog answers with the repository.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, dir);
  const [win] = await Promise.all([app.waitForEvent('window'), welcome.getByRole('button', { name: 'Open folder…' }).click()]);
  await assertWindowsHidden(app);
  return win;
}

export function removeSandbox(sandbox: Sandbox): void {
  fs.rmSync(sandbox.tmp, { recursive: true, force: true, maxRetries: 5 });
}

// ------------------------------------------------- what the daemon says of runners

/** What a faked answer carries: a body, and the status the daemon sent it with. */
export interface FakedAnswer {
  readonly status?: number;
  readonly body: unknown;
}

/**
 * What the app's main process answers in the daemon's place. `runners` replaces
 * GET /api/runners; `models` is laid over the daemon's own GET /api/models, so
 * the planner's catalog stays real while a runner's list or error is not.
 */
export interface FakedDaemon {
  readonly runners?: FakedAnswer;
  readonly models?: { readonly modelsByRunner?: Record<string, unknown[]>; readonly runnerErrors?: Record<string, string> };
}

/**
 * The tour has one installed agent, so most of what the app shows of the other
 * seven (an install card, a signed-out flag, a too-old reason, a model error) is
 * a state of the machine the tour cannot create offline. This answers for the
 * daemon in main's `DaemonProxy`, the renderer's only way to it (ADR-0063 H4),
 * so every window draws what a real daemon's answer would make it draw.
 * Calling it again replaces the answers; `undefined` gives the real daemon back.
 */
export async function fakeDaemon(app: ElectronApplication, faked: FakedDaemon | undefined): Promise<void> {
  await app.evaluate((_electron, answers) => {
    // This function is serialised into main, where this file's imports do not exist and `require`
    // may not either (main is a module); the same builtin objects the proxy imports come from here.
    const builtin = <T>(name: string): T => (process as unknown as { getBuiltinModule(id: string): T }).getBuiltinModule(name);
    const http = builtin<typeof import('node:http')>('node:http');
    const { Readable } = builtin<typeof import('node:stream')>('node:stream');
    const { EventEmitter } = builtin<typeof import('node:events')>('node:events');
    type Call = (options: import('node:http').RequestOptions, callback?: (res: import('node:http').IncomingMessage) => void) => import('node:http').ClientRequest;
    const slot = globalThis as unknown as { tourFaked?: FakedDaemon | undefined; tourRealRequest?: Call };
    slot.tourFaked = answers ?? undefined;
    if (slot.tourRealRequest) return;
    const real = http.request as unknown as Call;
    slot.tourRealRequest = real;
    const respond = (callback: ((res: import('node:http').IncomingMessage) => void) | undefined, status: number, body: unknown): void => {
      const res = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as import('node:http').IncomingMessage;
      (res as { statusCode: number }).statusCode = status;
      callback?.(res);
    };
    // The proxy passes (options, callback) and never a URL.
    http.request = ((options, callback) => {
      const faked = slot.tourFaked;
      const path = String(options.path ?? '').split('?')[0];
      if (faked?.runners && path === '/api/runners' && options.method === 'GET') {
        const stand = new EventEmitter() as unknown as import('node:http').ClientRequest;
        (stand as { destroy: () => void }).destroy = () => undefined;
        (stand as unknown as { end: () => void }).end = () => { setImmediate(() => respond(callback, faked.runners?.status ?? 200, faked.runners?.body)); };
        return stand;
      }
      if (faked?.models && path === '/api/models' && options.method === 'GET') {
        const models = faked.models;
        return real.call(http, options, (res: import('node:http').IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try { body = JSON.parse(text); } catch { body = undefined; }
            if (typeof body !== 'object' || body === null) { respond(callback, res.statusCode ?? 502, text); return; }
            const daemons = body as { modelsByRunner?: Record<string, unknown[]>; runnerErrors?: Record<string, string> };
            respond(callback, res.statusCode ?? 200, {
              ...daemons,
              modelsByRunner: { ...daemons.modelsByRunner, ...models.modelsByRunner },
              runnerErrors: { ...daemons.runnerErrors, ...models.runnerErrors },
            });
          });
        });
      }
      return real.call(http, options, callback);
    }) as Call as unknown as typeof http.request;
  }, faked);
}

interface FakeRunner {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly usable?: boolean;
  readonly reason?: string;
  readonly version?: string;
  readonly auth?: Record<string, unknown>;
}

const loginSignIn = (runner: string, label: string, login: string[]): Record<string, unknown> => ({
  state: 'signed-out', loginCommand: login, signIn: { runner, label, login },
});

/** Eight runners as a machine that has them all in different states would answer. */
export const MIXED_RUNNERS: readonly FakeRunner[] = [
  { id: 'claude-code', name: 'Claude Code', enabled: true, version: '2.1.0', auth: { state: 'signed-in' } },
  { id: 'codex', name: 'Codex', enabled: true, version: '0.58.0', auth: loginSignIn('codex', 'Codex', ['codex', 'login']) },
  { id: 'opencode', name: 'OpenCode', enabled: false, version: '1.0.0', auth: { state: 'signed-in' } },
  { id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: true, version: '1.2.3', auth: { state: 'signed-in' } },
  {
    id: 'qwen-code', name: 'Qwen Code', enabled: true, version: '0.2.0',
    auth: { state: 'signed-out', signIn: { runner: 'qwen-code', label: 'Qwen Code', key: { provider: 'openrouter', label: 'OpenRouter', others: 'any OpenAI-compatible provider' } } },
  },
  {
    id: 'cline', name: 'Cline', enabled: true, version: '1.0.0', usable: false,
    reason: 'Cline 1.0.0 is older than the 1.3.0 Ordewell needs for its agent protocol. Update it, then Refresh.',
    auth: { state: 'unknown' },
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI', enabled: true, version: '0.9.0',
    auth: { state: 'signed-out', signIn: { runner: 'gemini-cli', label: 'Gemini CLI', key: { provider: 'google', label: 'Google' } } },
  },
  { id: 'cursor-agent', name: 'Cursor', enabled: true, version: '2025.10.1', auth: { state: 'signed-in' } },
];

export const fakedRunners = (runners: readonly FakeRunner[]): FakedAnswer => ({ body: { runners, orchestratorModel: 'mock/desktop-tour' } });

export const MIXED: FakedDaemon = {
  runners: fakedRunners(MIXED_RUNNERS),
  models: {
    modelsByRunner: { codex: [], 'qwen-code': [], cline: [] },
    runnerErrors: {
      codex: 'Codex is not signed in. Sign in with /login codex, or run codex login. Then Refresh.',
      'qwen-code': 'Qwen Code is not signed in. Choose OpenRouter in /key to hand it a key. Then Refresh.',
      cline: 'Cline 1.0.0 is older than the 1.3.0 Ordewell needs. Update it, then Refresh.',
    },
  },
};

/** No agent on the machine at all: the daemon lists none. */
export const NONE_INSTALLED: FakedDaemon = { runners: fakedRunners([]) };

/** The daemon answers, but not with a runner list. */
export const DETECTION_FAILED: FakedDaemon = {
  runners: { status: 500, body: { error: 'Runner detection failed: spawn EMFILE while looking for installed agents.' } },
};
