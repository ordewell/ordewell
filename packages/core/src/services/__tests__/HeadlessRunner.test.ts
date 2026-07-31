import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HeadlessRunner, type SpawnFn } from '../HeadlessRunner';
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

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn() };
  killed = false;
  kill = vi.fn((_signal?: string) => { this.killed = true; this.emit('close', 0); return true; });
}

function makeRunner(overrides: { hasScript?: boolean } = {}) {
  const child = new FakeChildProcess();
  const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
  const runner = new HeadlessRunner({
    spawnImpl,
    hasScriptCmd: () => overrides.hasScript ?? false,
    resolvePath: async () => '/augmented/bin:/usr/bin',
  });
  return { runner, child, spawnImpl: spawnImpl as ReturnType<typeof vi.fn> };
}

const baseOpts = (m: RunnerPluginManifest) => ({
  taskId: 'task-1234-abcd',
  runner: m.name,
  prompt: 'do the thing',
  cwd: '/workspace',
  registry: fakeRegistry(m),
});

describe('HeadlessRunner', () => {
  it('spawns the resolved invocation with cwd and augmented PATH', async () => {
    const m = manifest();
    const { runner, spawnImpl } = makeRunner();

    await runner.spawn(baseOpts(m));

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('test-cli');
    expect(args).toEqual(['do the thing']);
    expect(options.cwd).toBe('/workspace');
    expect(options.env.PATH).toBe('/augmented/bin:/usr/bin');
  });

  it('wraps in a PTY via script when the manifest requires a TTY and script exists', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    const { runner, spawnImpl } = makeRunner({ hasScript: true });

    await runner.spawn(baseOpts(m));

    const [command, args] = spawnImpl.mock.calls[0];
    expect(command).toBe('script');
    expect(args).toEqual(['-q', '-e', '-f', '-c', `'test-cli' 'do the thing'`, '/dev/null']);
  });

  it('spawns directly when the manifest requires a TTY but script is unavailable', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    const { runner, spawnImpl } = makeRunner({ hasScript: false });

    await runner.spawn(baseOpts(m));

    expect(spawnImpl.mock.calls[0][0]).toBe('test-cli');
  });

  it('throws on an unknown runner id', async () => {
    const { runner } = makeRunner();
    await expect(
      runner.spawn({ ...baseOpts(manifest()), runner: 'nope' }),
    ).rejects.toThrow(/Unknown runner: nope/);
  });

  it('emits raw output but buffers it ANSI-stripped', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    const emitted: string[] = [];
    session.onOutput((text) => emitted.push(text));
    child.stdout.emit('data', Buffer.from('\x1b[31mred\x1b[0m line\r\n'));
    child.stderr.emit('data', Buffer.from('warn\r'));

    expect(emitted).toEqual(['\x1b[31mred\x1b[0m line\r\n', 'warn\r']);
    expect(session.getOutput()).toBe('red line\nwarn');
  });

  it('fires onExit with the close code and unregisters the session', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));
    expect(runner.activeCount).toBe(1);

    const exit = vi.fn();
    session.onExit(exit);
    child.emit('close', 3);

    expect(exit).toHaveBeenCalledWith(3);
    expect(runner.activeCount).toBe(0);
  });

  it('reports a spawn error as output and exit -1', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    const exit = vi.fn();
    session.onExit(exit);
    child.emit('error', new Error('ENOENT'));

    expect(session.getOutput()).toContain('Process error: ENOENT');
    expect(exit).toHaveBeenCalledWith(-1);
  });

  it('stop(sessionId) kills the underlying process', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    runner.stop(session.id);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.activeCount).toBe(0);
  });

  it('stopAll kills every active session', async () => {
    const m = manifest();
    const child1 = new FakeChildProcess();
    const child2 = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2) as unknown as SpawnFn;
    const runner = new HeadlessRunner({ spawnImpl, hasScriptCmd: () => false, resolvePath: async () => '' });

    await runner.spawn(baseOpts(m));
    await runner.spawn({ ...baseOpts(m), taskId: 'task-5678-efgh' });

    runner.stopAll();
    expect(child1.kill).toHaveBeenCalled();
    expect(child2.kill).toHaveBeenCalled();
    expect(runner.activeCount).toBe(0);
  });

  it('forwards write() to the child stdin', async () => {
    const m = manifest();
    const { runner, child } = makeRunner();
    const session = await runner.spawn(baseOpts(m));

    session.write('y\n');
    expect(child.stdin.write).toHaveBeenCalledWith('y\n');
  });
});

/**
 * The Windows launch route. `spawn` with `shell: false` is CreateProcess, which
 * performs no PATHEXT lookup — so the bare `test-cli` the invocation names was
 * ENOENT on Windows no matter how the user installed it.
 */
describe('HeadlessRunner on Windows', () => {
  function winRunner(files: string[]) {
    const child = new FakeChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child) as unknown as SpawnFn;
    const present = new Set(files.map((f) => f.toLowerCase()));
    const runner = new HeadlessRunner({
      spawnImpl,
      hasScriptCmd: () => false,
      resolvePath: async () => 'C:\\tools',
      launchDeps: {
        platform: 'win32',
        exists: (c) => present.has(c.toLowerCase()),
        comSpec: () => 'C:\\Windows\\System32\\cmd.exe',
        pathExt: () => '.EXE;.CMD',
      },
    });
    return { runner, spawnImpl: spawnImpl as ReturnType<typeof vi.fn> };
  }

  it('spawns the resolved executable rather than the bare command name', async () => {
    const m = manifest();
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.exe']);

    await runner.spawn(baseOpts(m));

    const [command, , options] = spawnImpl.mock.calls[0];
    expect(command).toBe('C:\\tools\\test-cli.exe');
    expect(options.windowsVerbatimArguments).toBeUndefined();
  });

  it('routes a batch shim through cmd.exe with verbatim arguments', async () => {
    const m = manifest();
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.cmd']);

    await runner.spawn(baseOpts(m));

    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // Without the flag, Node would re-quote an already-quoted command line.
    expect(options.windowsVerbatimArguments).toBe(true);
  });

  // A `script`-wrapped invocation is POSIX-only and would be unresolvable here.
  it('never wraps in script, because hasScriptCmd is false on Windows', async () => {
    const m = manifest({ runner: { command: 'test-cli', argsTemplate: ['{{prompt}}'], promptInArgs: true, requiresTty: true } });
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.exe']);

    await runner.spawn(baseOpts(m));

    expect(spawnImpl.mock.calls[0][0]).toBe('C:\\tools\\test-cli.exe');
  });

  it('hands the child exactly one PATH-ish key', async () => {
    const m = manifest();
    const { runner, spawnImpl } = winRunner(['C:\\tools\\test-cli.exe']);

    await runner.spawn(baseOpts(m));

    const env = spawnImpl.mock.calls[0][2].env as Record<string, string>;
    const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
    expect(pathKeys).toHaveLength(1);
    expect(env[pathKeys[0]]).toBe('C:\\tools');
  });
});
