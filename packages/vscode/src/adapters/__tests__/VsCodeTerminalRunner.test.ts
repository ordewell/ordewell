import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { RunnerRegistry } from '@ordewell/core';
import type { RunnerPluginManifest } from '@ordewell/core';

import { VsCodeTerminalRunner } from '../VsCodeTerminalRunner';
import { __terminals, __resetTerminals } from '../../test/vscode.mock';

function manifest(overrides: Partial<RunnerPluginManifest['runner']> = {}): RunnerPluginManifest {
  return {
    name: 'test-runner',
    displayName: 'Test Runner',
    description: 'test',
    version: '1.0.0',
    runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, ...overrides },
    features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
    modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
  } as RunnerPluginManifest;
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn() };
  killed = false;
  exitCode: number | null = null;
  kill = vi.fn(() => { this.killed = true; return true; });
}

function makeRunner(opts: { hasScript?: boolean } = {}) {
  const child = new FakeChildProcess();
  const spawnImpl = vi.fn().mockReturnValue(child);
  const m = manifest();
  const runner = new VsCodeTerminalRunner({
    spawnImpl: spawnImpl as never,
    hasScriptCmd: () => opts.hasScript ?? false,
    resolvePath: async () => '/augmented/bin',
  });
  const spawnOpts = {
    taskId: 'task-1234-abcd',
    runner: m.name,
    prompt: 'do the thing',
    cwd: '/workspace',
    registry: { get: (id: string) => (id === m.name ? { manifest: m, source: 'builtin' } : undefined) } as unknown as RunnerRegistry,
  };
  return { runner, child, spawnImpl, spawnOpts };
}

describe('VsCodeTerminalRunner', () => {
  beforeEach(() => __resetTerminals());
  afterEach(() => vi.useRealTimers());

  it('does not start the child until the terminal opens', async () => {
    const { runner, spawnImpl, spawnOpts } = makeRunner();

    await runner.spawn(spawnOpts);
    expect(spawnImpl).not.toHaveBeenCalled();

    __terminals[0].pty.open({ columns: 100, rows: 40 });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  // The bug this class was rewritten for: output used to be read back out of
  // VS Code via a proposed API that never resolves in a published extension,
  // so the marker VerdictEngine watches for was never seen.
  it('captures child output without any terminal-data API', async () => {
    const { runner, child, spawnOpts } = makeRunner();
    const session = await runner.spawn(spawnOpts);
    const streamed: string[] = [];
    session.onOutput((text) => streamed.push(text));

    __terminals[0].pty.open({ columns: 100, rows: 40 });
    child.stdout.emit('data', Buffer.from('<<<ORDEWELL_DONE_abc123>>>\n'));

    expect(session.getOutput()).toContain('<<<ORDEWELL_DONE_abc123>>>');
    expect(streamed.join('')).toContain('<<<ORDEWELL_DONE_abc123>>>');
  });

  it('renders child output into the pseudoterminal with CRLF line endings', async () => {
    const { runner, child, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);
    const written: string[] = [];
    __terminals[0].pty.onDidWrite((data) => written.push(data));

    __terminals[0].pty.open({ columns: 100, rows: 40 });
    child.stdout.emit('data', Buffer.from('line one\nline two\n'));

    expect(written.join('')).toBe('line one\r\nline two\r\n');
  });

  it('passes the terminal dimensions to the child as COLUMNS/LINES', async () => {
    const { runner, spawnImpl, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);

    __terminals[0].pty.open({ columns: 100, rows: 40 });

    const env = spawnImpl.mock.calls[0][2].env;
    expect(env.COLUMNS).toBe('100');
    expect(env.LINES).toBe('40');
  });

  it('runs the interactive invocation under a PTY when script is available', async () => {
    const { runner, spawnImpl, spawnOpts } = makeRunner({ hasScript: true });
    await runner.spawn(spawnOpts);

    __terminals[0].pty.open({ columns: 100, rows: 40 });

    const [command, args] = spawnImpl.mock.calls[0];
    expect(command).toBe('script');
    expect(args).toEqual(['-q', '-e', '-f', '-c', `'test-cli' 'do the thing'`, '/dev/null']);
  });

  it('forwards terminal input to the child stdin', async () => {
    const { runner, child, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);
    __terminals[0].pty.open({ columns: 100, rows: 40 });

    __terminals[0].pty.handleInput?.('ORDEWELL_CONTINUE\r');

    expect(child.stdin.write).toHaveBeenCalledWith('ORDEWELL_CONTINUE\r');
  });

  it('kills the child when the user closes the terminal', async () => {
    const { runner, child, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);
    __terminals[0].pty.open({ columns: 100, rows: 40 });

    __terminals[0].pty.close();

    expect(child.kill).toHaveBeenCalled();
  });

  it('reports an exit when killed before the terminal ever opened', async () => {
    const { runner, spawnImpl, spawnOpts } = makeRunner();
    const session = await runner.spawn(spawnOpts);
    const exits: number[] = [];
    session.onExit((code) => exits.push(code));

    runner.stop(session.id);
    __terminals[0].pty.open({ columns: 100, rows: 40 });

    expect(exits).toEqual([-1]);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('starts the child anyway if the terminal is never rendered', async () => {
    vi.useFakeTimers();
    const { runner, spawnImpl, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);

    vi.advanceTimersByTime(3000);

    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves the terminal open on a non-zero exit so the failure stays readable', async () => {
    const { runner, child, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);
    const closed: number[] = [];
    const written: string[] = [];
    __terminals[0].pty.onDidClose?.((code) => closed.push(code));
    __terminals[0].pty.onDidWrite((data) => written.push(data));
    __terminals[0].pty.open({ columns: 100, rows: 40 });

    child.emit('close', 1);

    expect(closed).toEqual([]);
    expect(written.join('')).toContain('exited with code 1');
  });

  // A proposed API resolves under F5 and in the integration host, so nothing at
  // development time notices when one is reintroduced — only a published
  // install does, by silently capturing no output at all.
  it('no extension source reaches for a proposed API', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry)) continue;
        if (full.includes('__tests__') || full.includes('test-integration')) continue;
        const code = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (code.includes('onDidWriteTerminalData')) offenders.push(full);
      }
    };
    walk(join(__dirname, '../..'));

    expect(offenders).toEqual([]);
  });

  it('closes the terminal on a clean exit', async () => {
    const { runner, child, spawnOpts } = makeRunner();
    await runner.spawn(spawnOpts);
    const closed: number[] = [];
    __terminals[0].pty.onDidClose?.((code) => closed.push(code));
    __terminals[0].pty.open({ columns: 100, rows: 40 });

    child.emit('close', 0);

    expect(closed).toEqual([0]);
  });
});
