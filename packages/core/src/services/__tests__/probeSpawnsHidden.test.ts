import { describe, expect, it, vi } from 'vitest';
// vi.mock below is hoisted above these, so each module gets the recording child_process.
import { defaultExec as discoveryExec } from '../ModelDiscovery';
import { defaultExec as installationExec } from '../RunnerInstallation';
import { defaultExec as authExec } from '../runnerAuth';
import { defaultDeps as workspaceEnvDeps } from '../workspaceEnv';
import { setEnv } from '../../testing';

/**
 * The agent probes a daemon runs at startup (is it installed, is it signed
 * in, which models its command line lists, the workspace's direnv) each
 * spawn a console program. Codex's and ACP agents' model lists go through
 * RunnerProcess instead, which this does not cover. On Windows a GUI host,
 * the desktop app's daemon, would flash a console window for every one of
 * them unless the spawn asks for none. Each probe is run
 * here through its real default against a recording child_process, so the
 * option is pinned with the ones the spawn already passed.
 */
const calls = vi.hoisted(() => [] as Array<{ fn: 'exec' | 'execFile' | 'spawn'; command: string; args?: string[]; options: Record<string, unknown> }>);

vi.mock('child_process', async (importOriginal) => {
  const { promisify } = await import('util');
  const actual = await importOriginal<typeof import('child_process')>();
  type Callback = (err: Error | null, stdout: string, stderr: string) => void;
  const child = () => ({ kill: () => true, stdout: null, stderr: null });
  const exec = (command: string, options: Record<string, unknown>, callback: Callback) => {
    calls.push({ fn: 'exec', command, options });
    queueMicrotask(() => callback(null, 'v1.2.3\n', ''));
    return child();
  };
  // As the real one: promisified, it answers `{ stdout, stderr }`.
  Object.defineProperty(exec, promisify.custom, {
    value: (command: string, options: Record<string, unknown>) =>
      new Promise((resolve) => { exec(command, options, (_err, stdout, stderr) => resolve({ stdout, stderr })); }),
  });
  const execFile = (command: string, args: string[], options: Record<string, unknown>, callback: Callback) => {
    calls.push({ fn: 'execFile', command, args, options });
    queueMicrotask(() => callback(null, 'ok', ''));
    return child();
  };
  // A Windows discovery probe goes to the host's job supervisor (ADR-0078).
  // This one says it is ready and offers pipes that do not exist, so the
  // probe fails before any command runs; what is pinned is the supervisor's
  // own spawn.
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ fn: 'spawn', command, args, options });
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    stdin.setEncoding('utf8');
    stdin.on('data', (line: string) => { const [kind, id] = line.split(' '); if (kind === 'start') stdout.write(`listening ${id}\n`); });
    const fake = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin, pid: 1, exitCode: null, signalCode: null, kill: () => true, ref: () => {}, unref: () => {} });
    queueMicrotask(() => stdout.write('ready\n'));
    return fake;
  };
  return { ...actual, default: { ...actual, exec, execFile, spawn }, exec, execFile, spawn };
});

vi.mock('../../utils/shellPath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/shellPath')>();
  return { ...actual, augmentedPath: async () => '/usr/bin' };
});


function last(): (typeof calls)[number] {
  const call = calls.at(-1);
  if (!call) throw new Error('nothing was spawned');
  return call;
}

/** The supervisor spawns hidden, and starts each probe with no console and SW_HIDE, as windowsHide would. */
function expectHiddenSupervisor(call: (typeof calls)[number]): void {
  expect(call).toMatchObject({ fn: 'spawn', command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', options: { windowsHide: true } });
  expect(call.args?.at(-1)).toMatch(/\$creation = .*\$CREATE_NO_WINDOW/);
  expect(call.args?.at(-1)).toContain('STARTF_USESHOWWINDOW');
}

describe('the agent probes spawn with no console window', () => {
  it('model discovery', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // Where the supervisor is found; a Linux host has no SystemRoot.
    const restore = setEnv({ SystemRoot: 'C:\\Windows' });
    try {
      await expect(discoveryExec('opencode models', { timeout: 1000 })).rejects.toThrow(/discovery cleanup could not be set up/);
      expectHiddenSupervisor(last());
    } finally { restore(); Object.defineProperty(process, 'platform', { value: platform }); }
  });

  it('the installation check', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const restore = setEnv({ SystemRoot: 'C:\\Windows' });
    try {
      await expect(installationExec('claude --version', { timeout: 8000 })).rejects.toThrow(/discovery cleanup could not be set up/);
      expectHiddenSupervisor(last());
    } finally { restore(); Object.defineProperty(process, 'platform', { value: platform }); }
  });

  it('the sign-in check', async () => {
    const env = { PATH: '/usr/bin' };
    expect(await authExec('claude', ['auth', 'status'], { timeout: 8000, env, verbatim: false })).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    const call = last();
    expect(call).toMatchObject({ fn: 'execFile', command: 'claude', args: ['auth', 'status'] });
    expect(call.options).toEqual({ timeout: 8000, env, encoding: 'utf8', windowsVerbatimArguments: false, windowsHide: true });
  });

  it("the workspace's direnv", async () => {
    const env = { PATH: '/usr/bin' };
    expect(await workspaceEnvDeps().run('direnv', ['export', 'json'], { cwd: '/work', env })).toEqual({ code: 0, stdout: 'ok', stderr: '' });
    const call = last();
    expect(call).toMatchObject({ fn: 'execFile', command: 'direnv', args: ['export', 'json'] });
    expect(call.options).toMatchObject({ cwd: '/work', env, encoding: 'utf8', windowsHide: true });
    expect(typeof call.options.timeout).toBe('number');
  });
});
