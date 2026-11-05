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
    ORDEWELL_ENABLED_RUNNERS: 'claude-code',
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

export function launchApp(sandbox: Sandbox, env: Record<string, string>): Promise<ElectronApplication> {
  return electron.launch({
    // A Linux CI runner has no setuid chrome-sandbox, and its AppArmor forbids
    // the unprivileged user namespaces Chromium's sandbox falls back to.
    args: [DESKTOP, `--user-data-dir=${sandbox.userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env,
    cwd: sandbox.tmp,
  });
}

/** Opens `dir` from the welcome window's Open folder…, and returns the workspace window. */
export async function openFolder(app: ElectronApplication, welcome: Page, dir: string): Promise<Page> {
  // The native picker cannot be driven: main's dialog answers with the repository.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, dir);
  const [win] = await Promise.all([app.waitForEvent('window'), welcome.getByRole('button', { name: 'Open folder…' }).click()]);
  return win;
}

export function removeSandbox(sandbox: Sandbox): void {
  fs.rmSync(sandbox.tmp, { recursive: true, force: true, maxRetries: 5 });
}
