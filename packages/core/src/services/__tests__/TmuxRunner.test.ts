import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TmuxRunner, type ExecFileFn } from '../TmuxRunner';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerPluginManifest } from '../../plugins/types';

function manifest(overrides: Partial<RunnerPluginManifest> = {}): RunnerPluginManifest {
  return {
    name: 'test-runner',
    displayName: 'Test Runner',
    description: 'test',
    version: '1.0.0',
    runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true },
    features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
    modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
    ...overrides,
  };
}

function fakeRegistry(m: RunnerPluginManifest): RunnerRegistry {
  return { get: (id: string) => (id === m.name ? { manifest: m, source: 'builtin' } : undefined) } as unknown as RunnerRegistry;
}

const baseOpts = (m: RunnerPluginManifest, taskId = 'task-1234-abcd') => ({
  taskId,
  runner: m.name,
  prompt: 'do the thing',
  cwd: '/workspace',
  registry: fakeRegistry(m),
});

describe('TmuxRunner', () => {
  let logDir: string;
  let execFileImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logDir = mkdtempSync(join(tmpdir(), 'ordewell-tmux-test-'));
    execFileImpl = vi.fn().mockResolvedValue({ stdout: '', stderr: '' }) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(logDir, { recursive: true, force: true });
  });

  /**
   * Every tmux invocation must name the daemon's private socket. An unprefixed
   * call silently targets the shared default server, which is exactly how a
   * runner ends up inheriting a different daemon's environment (a stale API
   * key, most damagingly). Asserting the prefix here — once, over every
   * recorded call — keeps that guarantee on all the assertions below, which
   * then read against the command as if the prefix weren't there.
   */
  function tmuxCalls(): [string, string[]][] {
    return (execFileImpl.mock.calls as [string, string[]][]).map(([cmd, args]) => {
      expect(cmd).toBe('tmux');
      expect(args.slice(0, 2)).toEqual(['-L', 'ordewell-3742']);
      return [cmd, args.slice(2)] as [string, string[]];
    });
  }

  function makeRunner(overrides: Partial<{ pollIntervalMs: number }> = {}) {
    return new TmuxRunner({
      port: 3742,
      execFileImpl: execFileImpl as unknown as ExecFileFn,
      resolvePath: async () => '/augmented/bin:/usr/bin',
      logDir,
      pollIntervalMs: overrides.pollIntervalMs ?? 100,
    });
  }

  it('opens a new window in the shared session with the resolved, quoted invocation', async () => {
    const runner = makeRunner();
    await runner.spawn(baseOpts(manifest()));

    const call = tmuxCalls().find(([, args]) => args[0] === 'new-window');
    expect(call).toBeDefined();
    const [cmd, args] = call!;
    expect(cmd).toBe('tmux');
    expect(args[1]).toBe('-t');
    expect(args[2]).toBe('ordewell-3742');
    expect(args[3]).toBe('-n');
    expect(args[4]).toBe('t-task1234abcd');
    expect(args[5]).toBe('-c');
    expect(args[6]).toBe('/workspace');
    expect(args[7]).toContain(`'test-cli' 'do the thing'`);
    expect(args[7]).toContain('ORDEWELL_TMUX_EXIT');
  });

  /**
   * Regression: a tmux window is a real TTY, so the runner's own TUI is the
   * whole point of ADR-0007 — but the transport used to declare itself headless
   * and got the non-interactive subcommand instead (Codex streamed `codex exec`
   * output into the window). Autonomy is the other axis and must stay on: the
   * window is unattended, so permission-skipping flags still belong.
   */
  it('launches the interactive shape while keeping autonomy flags on', async () => {
    const m = manifest({
      runner: {
        command: 'test-cli',
        argsTemplate: [
          '{{if headlessSession}}', 'exec', '{{/if}}',
          '{{if interactive}}', '--tui', '{{/if}}',
          '{{if headless}}', '--yes', '{{/if}}',
          '{{prompt}}',
        ],
        promptInArgs: true,
      },
      features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '', headlessFlag: '--yes' },
    });
    const runner = makeRunner();
    await runner.spawn({ ...baseOpts(m), mode: 'build' });

    const shellCmd = tmuxCalls().find(([, args]) => args[0] === 'new-window')![1][7];
    expect(shellCmd).toContain(`'test-cli' '--tui' '--yes' 'do the thing'`);
    expect(shellCmd).not.toContain('exec"');
    expect(shellCmd).not.toContain(`'exec'`);
  });

  it('passes the task cwd through to arg resolution, not just to the window', async () => {
    const m = manifest({
      runner: { command: 'test-cli', argsTemplate: ['{{if projectTrust}}', '-c', '{{projectTrust}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
    });
    const runner = makeRunner();
    await runner.spawn(baseOpts(m));

    const shellCmd = tmuxCalls().find(([, args]) => args[0] === 'new-window')![1][7];
    expect(shellCmd).toContain(`'-c' 'projects."/workspace".trust_level="trusted"'`);
  });

  it('starts piping the window output into a per-session log file', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));

    const call = tmuxCalls().find(([, args]) => args[0] === 'pipe-pane');
    expect(call).toBeDefined();
    const [, args] = call!;
    expect(args[1]).toBe('-t');
    expect(args[2]).toBe('ordewell-3742:t-task1234abcd');
    expect(args[3]).toContain(session.id);
  });

  it('emits content appended to the log file and buffers it ANSI-stripped', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));
    const logPath = join(logDir, `${session.id}.log`);

    const emitted: string[] = [];
    session.onOutput((text) => emitted.push(text));

    appendFileSync(logPath, '\x1b[31mred\x1b[0m line\n');
    await vi.advanceTimersByTimeAsync(100);

    expect(emitted).toEqual(['\x1b[31mred\x1b[0m line\n']);
    expect(session.getOutput()).toBe('red line\n');
  });

  it('detects the completion sentinel, fires onExit, and leaves the window running', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));
    const logPath = join(logDir, `${session.id}.log`);

    const exit = vi.fn();
    session.onExit(exit);

    appendFileSync(logPath, 'work done\n<<<ORDEWELL_TMUX_EXIT:0>>>\n');
    await vi.advanceTimersByTimeAsync(100);

    expect(exit).toHaveBeenCalledWith(0);
    expect(tmuxCalls().some(([, args]) => args[0] === 'kill-window')).toBe(false);
  });

  it('stops piping and removes the log file once the sentinel is seen', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));
    const logPath = join(logDir, `${session.id}.log`);

    appendFileSync(logPath, '<<<ORDEWELL_TMUX_EXIT:1>>>\n');
    await vi.advanceTimersByTimeAsync(100);

    const disablesPiping = tmuxCalls().some(
      ([, args]) => args[0] === 'pipe-pane' && args.length === 3,
    );
    expect(disablesPiping).toBe(true);
    expect(existsSync(logPath)).toBe(false);
  });

  it('forwards write() as literal tmux send-keys', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));

    session.write('y\n');

    const call = tmuxCalls().find(([, args]) => args[0] === 'send-keys');
    expect(call).toBeDefined();
    const [, args] = call!;
    expect(args).toEqual(['send-keys', '-t', 'ordewell-3742:t-task1234abcd', '-l', 'y\n']);
  });

  it('kill() closes the window and fires onExit(-1) without waiting for a sentinel', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));

    const exit = vi.fn();
    session.onExit(exit);
    runner.stop(session.id);

    const killed = tmuxCalls().some(
      ([, args]) => args[0] === 'kill-window' && args[2] === 'ordewell-3742:t-task1234abcd',
    );
    expect(killed).toBe(true);
    expect(exit).toHaveBeenCalledWith(-1);
    expect(runner.activeCount).toBe(0);
  });

  it('opens a freshly named window on retry instead of reusing the failed one', async () => {
    const runner = makeRunner();
    await runner.spawn(baseOpts(manifest()));
    await runner.spawn(baseOpts(manifest()));

    const windows = tmuxCalls()
      .filter(([, args]) => args[0] === 'new-window')
      .map(([, args]) => args[4]);
    expect(windows).toEqual(['t-task1234abcd', 't-task1234abcd-2']);
  });

  it('detects a completion sentinel split across two log flushes', async () => {
    const runner = makeRunner();
    const session = await runner.spawn(baseOpts(manifest()));
    const logPath = join(logDir, `${session.id}.log`);

    const exit = vi.fn();
    session.onExit(exit);

    appendFileSync(logPath, 'work done\n<<<ORDEWELL_TMUX');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).not.toHaveBeenCalled();

    appendFileSync(logPath, '_EXIT:0>>>\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps two plans with the same task id apart: distinct windows, ids and logs', async () => {
    const runner = makeRunner();
    const a = await runner.spawn({ ...baseOpts(manifest(), 'task-1'), planSessionId: 'session-1753000042111' });
    const b = await runner.spawn({ ...baseOpts(manifest(), 'task-1'), planSessionId: 'session-1753000098222' });

    const windows = tmuxCalls()
      .filter(([, args]) => args[0] === 'new-window')
      .map(([, args]) => args[4]);
    expect(windows).toEqual(['t-042111-task1', 't-098222-task1']);
    expect(a.id).not.toBe(b.id);
    expect(runner.activeCount).toBe(2);
  });

  it('creates the shared session itself, once, when spawn runs before ensureSession', async () => {
    const runner = makeRunner();
    await runner.spawn(baseOpts(manifest()));
    await runner.spawn(baseOpts(manifest(), 'task-other'));

    const creations = tmuxCalls().filter(([, args]) => args[0] === 'new-session');
    expect(creations).toHaveLength(1);
    const firstWindow = tmuxCalls().findIndex(([, args]) => args[0] === 'new-window');
    const creation = tmuxCalls().findIndex(([, args]) => args[0] === 'new-session');
    expect(creation).toBeLessThan(firstWindow);
  });

  it('throws on an unknown runner id', async () => {
    const runner = makeRunner();
    await expect(
      runner.spawn({ ...baseOpts(manifest()), runner: 'nope' }),
    ).rejects.toThrow(/Unknown runner: nope/);
  });

  it('ensureSession reaps a stale session before creating a fresh one', async () => {
    const runner = makeRunner();
    await runner.ensureSession();

    expect(tmuxCalls().some(([, args]) => args[0] === 'has-session')).toBe(true);
    expect(tmuxCalls().some(([, args]) => args[0] === 'kill-session')).toBe(true);
    expect(tmuxCalls().some(([, args]) => args[0] === 'new-session')).toBe(true);
  });

  it('killSession tears down the daemon\'s whole tmux server', async () => {
    const runner = makeRunner();
    await runner.killSession();

    const call = tmuxCalls().find(([, args]) => args[0] === 'kill-server');
    expect(call).toBeDefined();
    expect(call![1]).toEqual(['kill-server']);
  });

  it('runs every tmux command against the daemon\'s own socket, never the default server', async () => {
    const runner = makeRunner();
    await runner.ensureSession();
    const session = await runner.spawn(baseOpts(manifest()));
    session.write('hello');
    session.kill();
    await runner.killSession();

    // tmuxCalls() asserts the -L prefix on each call; this pins that the suite
    // actually exercised the full surface rather than passing vacuously.
    const verbs = tmuxCalls().map(([, args]) => args[0]);
    expect(new Set(verbs)).toEqual(
      new Set(['has-session', 'kill-session', 'new-session', 'new-window',
               'pipe-pane', 'send-keys', 'kill-window', 'kill-server',
               'set-option', 'bind-key']),
    );
  });

  it('enables mouse scrolling, a deep scrollback and PageUp/Down copy-mode on the session', async () => {
    const runner = makeRunner();
    await runner.ensureSession();

    const verbs = tmuxCalls();
    expect(verbs.some(([, a]) => a[0] === 'set-option' && a.includes('mouse') && a.includes('on'))).toBe(true);
    expect(verbs.some(([, a]) => a[0] === 'set-option' && a.includes('history-limit') && a.includes('100000'))).toBe(true);
    // A root-table PageUp binding is what makes the key enter copy-mode without
    // the tmux prefix; without it the inner app swallows it.
    expect(verbs.some(([, a]) => a[0] === 'bind-key' && a[1] === '-n' && a[2] === 'PageUp')).toBe(true);
    // PageUp/PageDown page through the scrollback inside copy mode — both key
    // tables, so the bindings hold regardless of `mode-keys`.
    const copyKeys = verbs
      .filter(([, a]) => a[0] === 'bind-key' && a[1] === '-T' && (a[2] === 'copy-mode' || a[2] === 'copy-mode-vi'))
      .map(([, a]) => `${a[2]}:${a[3]}`);
    expect(copyKeys).toEqual(
      expect.arrayContaining([
        'copy-mode:PageUp', 'copy-mode:PageDown',
        'copy-mode-vi:PageUp', 'copy-mode-vi:PageDown',
      ]),
    );
  });

  it('sets history-limit before any window is created, so the scrollback depth applies', async () => {
    const runner = makeRunner();
    await runner.spawn(baseOpts(manifest()));

    const setHistory = tmuxCalls().findIndex(([, a]) => a[0] === 'set-option' && a.includes('history-limit'));
    const firstWindow = tmuxCalls().findIndex(([, a]) => a[0] === 'new-window');
    expect(setHistory).toBeGreaterThanOrEqual(0);
    expect(setHistory).toBeLessThan(firstWindow);
  });
});
