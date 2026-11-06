import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScriptRunner, type ScriptRunnerDeps, type ScriptSpawnFn } from '../ScriptRunner';
import type { ScriptExit, StructuredEvent } from '../../interfaces/IRunner';
import { DEFAULT_SCRIPT_TIMEOUT_MS, type ScriptBody } from '../../models/ScriptTask';
import type { PlacedLaunch, RunnerLaunch, RunnerPlacement } from '../executionLease';
import { patient } from '../../testing';

/**
 * A script task's body as it really runs (ADR-0035): real processes, at a real
 * workspace root, with nothing between the body and its exit status.
 */

const node = process.execPath;
const js = (code: string, ...args: string[]): string[] => [node, '-e', code, ...args];

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-script-'));
  workspaces.push(dir);
  return dir;
}

async function start(body: Partial<ScriptBody> & ({ commands: string[][] } | { script: string }), opts: { env?: Record<string, string>; deps?: ScriptRunnerDeps; cwd?: string; attempt?: number; placement?: RunnerPlacement } = {}) {
  const cwd = opts.cwd ?? workspace();
  const runner = new ScriptRunner(opts.deps);
  const session = await runner.spawn({ taskId: 't1', runner: 'script', prompt: '', cwd, env: opts.env, attempt: opts.attempt, ...(opts.placement ? { placement: opts.placement } : {}), script: { timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS, ...body } as ScriptBody });
  const events: StructuredEvent[] = [];
  let output = '';
  session.onEvent((event) => events.push(event));
  session.onOutput((text) => { output += text; });
  const exit = new Promise<ScriptExit>((resolve) => session.onScriptExit(resolve));
  const exited = new Promise<number>((resolve) => session.onExit(resolve));
  return { runner, session, cwd, events, exit, exited, output: () => output };
}

const ofType = <T extends StructuredEvent['type']>(events: StructuredEvent[], type: T) =>
  events.filter((e): e is Extract<StructuredEvent, { type: T }> => e.type === type);

describe('ScriptRunner: commands', () => {
  it('runs every command in order, each as its own argument vector with no shell, and passes when each exits 0', async () => {
    const run = await start({ commands: [js("console.log('one')"), js('console.log(process.argv[1])', '$(echo injected); echo two')] });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(await run.exited).toBe(0);
    // The metacharacters reached the program as one word: nothing joined the vector into a shell line.
    expect(run.output()).toBe('one\n$(echo injected); echo two\n');
    expect(ofType(run.events, 'script_run').map((e) => 'argv' in e && e.argv.slice(1))).toEqual([
      ['-e', "console.log('one')"],
      ['-e', 'console.log(process.argv[1])', '$(echo injected); echo two'],
    ]);
    expect(ofType(run.events, 'script_exit').map((e) => [e.code, e.signal])).toEqual([[0, null], [0, null]]);
  });

  it('stops at the first command that fails, with its status and the end of its error output', async () => {
    const run = await start({
      commands: [
        js("console.log('ok')"),
        js("process.stderr.write('disk full\\n'); process.exit(3)"),
        js("require('fs').writeFileSync('third', 'ran')"),
      ],
    });

    const exit = await run.exit;
    expect(exit).toMatchObject({ outcome: 'failed', status: { code: 3, signal: null }, errorTail: 'disk full\n' });
    expect(exit.outcome === 'failed' && exit.command).toContain("process.exit(3)");
    expect(await run.exited).toBe(1);
    expect(ofType(run.events, 'script_run')).toHaveLength(2);
    expect(fs.existsSync(path.join(run.cwd, 'third'))).toBe(false);
  });

  it('fails a command that cannot start, saying why', async () => {
    const run = await start({ commands: [['ordewell-no-such-program-anywhere', '--version']] });

    const exit = await run.exit;
    expect(exit).toMatchObject({ outcome: 'failed', status: { code: null, signal: null } });
    expect(exit.outcome === 'failed' && exit.status.error).toMatch(/ENOENT/);
  });

  it('runs at the workspace root, with the workspace\'s variables over the host\'s', async () => {
    const run = await start({ commands: [js('console.log(process.cwd()); console.log(process.env.ORDEWELL_TEST_VAR)')] }, { env: { ORDEWELL_TEST_VAR: 'from the workspace' } });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(run.output()).toBe(`${fs.realpathSync(run.cwd)}\nfrom the workspace\n`);
  });

  it('keeps the head and the tail of a long output in its log, and all of it in its output', async () => {
    const run = await start({ commands: [js("process.stdout.write('x'.repeat(100000) + 'END')")] });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    const logged = ofType(run.events, 'script_output');
    const kept = logged.map((e) => e.text).join('');
    expect(kept.length).toBeLessThan(60_000);
    expect(kept.endsWith('END')).toBe(true);
    expect(logged.at(-1)!.omittedChars).toBe(100_003 - kept.length);
    expect(run.output().length).toBe(100_003);
  });
});

describe('ScriptRunner: the whole output', () => {
  // The failure of a long command sits in the middle, which the log drops.
  const middle = "process.stdout.write('a'.repeat(50000) + 'MIDDLE_FAILURE' + 'b'.repeat(50000)); process.exitCode = 2";

  it('streams all of an attempt\'s output to its file, and names the file in the exit', async () => {
    const cwd = workspace();
    const file = path.join(cwd, 'out', '1.output.txt');
    const run = await start({ commands: [js(middle)] }, { cwd, deps: { fullOutputFile: (taskId, attempt) => { expect([taskId, attempt]).toEqual(['t1', 1]); fs.mkdirSync(path.dirname(file)); return file; } }, attempt: 1 });

    const exit = await run.exit;
    await run.exited;
    expect(exit).toMatchObject({ outcome: 'failed', fullOutput: { file, droppedChars: 0 } });
    const saved = fs.readFileSync(file, 'utf8');
    expect(saved).toBe(`${'a'.repeat(50000)}MIDDLE_FAILURE${'b'.repeat(50000)}`);
    // The log still drops the middle: only the file is whole.
    expect(ofType(run.events, 'script_output').map((e) => e.text).join('')).not.toContain('MIDDLE_FAILURE');
  });

  it('has the file complete by the time the end is handed on', async () => {
    const cwd = workspace();
    const file = path.join(cwd, '1.output.txt');
    const run = await start({ commands: [js("process.stdout.write('done\\n')")] }, { cwd, deps: { fullOutputFile: () => file }, attempt: 1 });
    let seen = '';
    run.session.onScriptExit(() => { seen = fs.readFileSync(file, 'utf8'); });

    expect(await run.exit).toMatchObject({ outcome: 'passed', fullOutput: { file } });
    expect(seen).toBe('done\n');
  });

  it('counts what a hard cap does not keep, and says so at the end of the file', async () => {
    const cwd = workspace();
    const file = path.join(cwd, '1.output.txt');
    const run = await start({ commands: [js("process.stdout.write('x'.repeat(1000))")] }, { cwd, deps: { fullOutputFile: () => file, fullOutputMaxChars: 400 }, attempt: 1 });

    expect(await run.exit).toMatchObject({ fullOutput: { file, droppedChars: 600 } });
    const saved = fs.readFileSync(file, 'utf8');
    expect(saved.startsWith('x'.repeat(400))).toBe(true);
    expect(saved).toContain('600 more characters were not saved');
  });

  it('runs on without a file when it cannot be written', async () => {
    const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, 'blocked'), '');
    const file = path.join(cwd, 'blocked', '1.output.txt');
    const run = await start({ commands: [js("console.log('still runs')")] }, { cwd, deps: { fullOutputFile: () => file }, attempt: 1 });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(run.output()).toBe('still runs\n');
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });

  it('makes no file for an attempt with no number', async () => {
    const cwd = workspace();
    const run = await start({ commands: [js("console.log('x')")] }, { cwd, deps: { fullOutputFile: () => { throw new Error('asked'); } } });

    expect(await run.exit).toEqual({ outcome: 'passed' });
  });
});

describe('ScriptRunner: a script', () => {
  it('runs one script in the research shell and passes when it exits 0', async () => {
    const run = await start({ script: 'echo hello\necho "$ORDEWELL_TEST_VAR"' }, { env: { ORDEWELL_TEST_VAR: 'set' } });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(run.output()).toBe('hello\nset\n');
    expect(ofType(run.events, 'script_run')).toEqual([{ type: 'script_run', script: 'echo hello\necho "$ORDEWELL_TEST_VAR"' }]);
  });

  it('fails when the script exits otherwise, with its status and the end of its error output', async () => {
    const run = await start({ script: 'echo started\necho "no such resource group" >&2\nexit 4' });

    const exit = await run.exit;
    expect(exit).toEqual({ outcome: 'failed', status: { code: 4, signal: null }, errorTail: 'no such resource group\n' });
    expect(ofType(run.events, 'script_exit')).toEqual([expect.objectContaining({ code: 4, signal: null })]);
  });
});

describe('ScriptRunner: ending early', () => {
  it('kills the process tree when the time limit runs out, and fails saying so', async () => {
    const run = await start({ commands: [js('setTimeout(() => {}, 60_000)'), js("require('fs').writeFileSync('after', '')")], timeoutMs: 300 });

    const exit = await run.exit;
    expect(exit).toMatchObject({ outcome: 'timed-out', timeoutMs: 300 });
    // Windows ends the tree with taskkill, which leaves an exit code and no signal.
    const ended = process.platform === 'win32' ? {} : { signal: 'SIGTERM' };
    expect(ofType(run.events, 'script_exit')).toEqual([expect.objectContaining({ timedOut: true, ...ended })]);
    expect(fs.existsSync(path.join(run.cwd, 'after'))).toBe(false);
  }, patient(15_000));

  it('ends the running command on Stop, runs none after it, and resolves once the session has exited', async () => {
    const run = await start({ commands: [js("console.log('up'); setTimeout(() => {}, 60_000)"), js("require('fs').writeFileSync('after', '')")] });
    await vi.waitFor(() => expect(run.output()).toBe('up\n'));

    await run.runner.stop(run.session.id);

    expect(await run.exit).toMatchObject({ outcome: 'stopped' });
    expect(await run.exited).toBe(1);
    expect(run.runner.activeCount).toBe(0);
    expect(fs.existsSync(path.join(run.cwd, 'after'))).toBe(false);
  }, patient(15_000));

  it('runs nothing at all when stopped before its first command', async () => {
    const run = await start({ commands: [js("require('fs').writeFileSync('first', '')")] });

    await run.session.stop();

    expect(await run.exit).toMatchObject({ outcome: 'stopped' });
    expect(ofType(run.events, 'script_run')).toEqual([]);
    expect(fs.existsSync(path.join(run.cwd, 'first'))).toBe(false);
  });
});

describe('ScriptRunner: placed in a lease (ADR-0059 L5)', () => {
  /** What a container would do with a step, as a process on this host: `run` is what this host launches in its place. */
  function placement(run: (asked: RunnerLaunch) => string[], env: Record<string, string> = {}) {
    const asked: RunnerLaunch[] = [];
    const stop = vi.fn();
    const ended = vi.fn();
    const place = vi.fn(async (launch: RunnerLaunch): Promise<PlacedLaunch> => {
      asked.push(launch);
      const [command, ...args] = run(launch);
      return { command, args, env, stop, ended };
    });
    return { asked, stop, ended, lease: { cwd: '/task/work/repo', place, reach: async (url: string) => url, blob: async () => undefined } satisfies RunnerPlacement };
  }

  const says = js('process.stdout.write(process.argv.slice(1).join("|"))');

  it('hands each command to the lease as it was written, with none of this host\'s variables', async () => {
    const { asked, lease } = placement(() => says);

    const run = await start({ commands: [['npm', 'test', '--', 'a b']] }, { placement: lease, env: { WORKSPACE_SECRET: 'stays here' } });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(asked).toEqual([{ command: 'npm', args: ['test', '--', 'a b'], env: {}, files: [] }]);
  });

  it('runs a script in the container\'s own shell, not the one this host would pick', async () => {
    const { asked, lease } = placement(() => says);

    const run = await start({ script: 'npm ci && npm test' }, { placement: lease });

    await run.exit;
    expect(asked).toEqual([{ command: 'sh', args: ['-c', 'npm ci && npm test'], env: {}, files: [] }]);
  });

  it('takes the exit status of what ran there as the evidence', async () => {
    const { lease } = placement(() => js('process.stderr.write("broke"); process.exit(3)'));

    const run = await start({ commands: [['npm', 'test']] }, { placement: lease });

    expect(await run.exit).toMatchObject({ outcome: 'failed', status: { code: 3 }, errorTail: 'broke' });
  });

  it('logs what it ran there as a step like any other', async () => {
    const { lease } = placement(() => js('console.log("in the box")'));

    const run = await start({ commands: [['npm', 'test']] }, { placement: lease });

    await run.exit;
    expect(run.output()).toContain('in the box');
    expect(ofType(run.events, 'script_run')).toEqual([expect.objectContaining({ argv: ['npm', 'test'] })]);
  });

  it('gives the client on this host what the lease hands over by name', async () => {
    const { lease } = placement(() => js('console.log(process.env.HANDED)'), { HANDED: 'by name' });

    const run = await start({ commands: [['x']] }, { placement: lease });

    await run.exit;
    expect(run.output()).toContain('by name');
  });

  it('stops at the first that fails, and says each one ended', async () => {
    const { asked, ended, lease } = placement((launch) => (launch.command === 'bad' ? js('process.exit(1)') : js('')));

    const run = await start({ commands: [['good'], ['bad'], ['never']] }, { placement: lease });

    await run.exit;
    expect(asked.map(({ command }) => command)).toEqual(['good', 'bad']);
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it('ends a step where it runs when stopped: killing the client here does not reach it', async () => {
    const { stop, ended, lease } = placement(() => js('setInterval(() => {}, 1000); console.log("up")'));
    const run = await start({ commands: [['slow']] }, { placement: lease });
    await vi.waitFor(() => expect(run.output()).toContain('up'));

    await run.session.stop();

    expect(stop).toHaveBeenCalled();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(await run.exit).toMatchObject({ outcome: 'stopped' });
  });

  it('ends a step where it runs at its time limit', async () => {
    const { stop, lease } = placement(() => js('setInterval(() => {}, 1000)'));

    const run = await start({ commands: [['slow']], timeoutMs: 100 }, { placement: lease });

    expect(await run.exit).toMatchObject({ outcome: 'timed-out' });
    expect(stop).toHaveBeenCalled();
  });

  it('says a step it could not place failed to start', async () => {
    const lease: RunnerPlacement = { cwd: '/task/work/repo', place: async () => { throw new Error('the container is gone'); }, reach: async (url) => url, blob: async () => undefined };

    const run = await start({ commands: [['x']] }, { placement: lease });

    expect(await run.exit).toMatchObject({ outcome: 'failed', status: { error: 'the container is gone' } });
  });
});

describe('ScriptRunner: refusals', () => {
  it('runs nothing that is not a script task', async () => {
    await expect(new ScriptRunner().spawn({ taskId: 't1', runner: 'script', prompt: 'do it', cwd: workspace() })).rejects.toThrow(/no script body/);
  });

  it('takes no messages: there is no model to read them', async () => {
    const run = await start({ commands: [js('')] });

    expect(() => run.session.sendMessage('hello')).toThrow(/runs no model/);
    await run.exit;
  });
});

/** A child that exits 0 on the next turn, as a spawned program would. */
function exitingChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, exitCode: null as number | null, signalCode: null, killed: false });
  setImmediate(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  return child as unknown as ChildProcess;
}

describe('ScriptRunner: on Windows', () => {
  it('finds the program through the launch seam and still runs no shell (ADR-0010)', async () => {
    const spawn = vi.fn<ScriptSpawnFn>(() => exitingChild());
    const run = await start({ commands: [['gh', 'pr', 'list']] }, {
      deps: {
        spawn,
        platform: 'win32',
        resolvePath: async () => 'C:\\tools',
        launch: { exists: (candidate) => candidate === 'C:\\tools\\gh.exe', pathExt: () => '.COM;.EXE;.BAT;.CMD' },
      },
    });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(spawn).toHaveBeenCalledWith('C:\\tools\\gh.exe', ['pr', 'list'], expect.objectContaining({ shell: false, detached: false, cwd: run.cwd }));
  });
});

describe('ScriptRunner: a credential of its spawn env (ADR-0061, H1)', () => {
  /** Fake, and no rule's shape: only the session's held record can recognise it. */
  const HELD = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
  const shows = (text: string) =>
    Array.from({ length: HELD.length - 7 }, (_, i) => HELD.slice(i, i + 8)).some((piece) => text.includes(piece));

  it('is hidden in its output, its log, its saved file and its error tail, though it was printed in two chunks', async () => {
    const dir = workspace();
    const run = await start({
      commands: [js([
        'const v = process.env.MISTRAL_API_KEY;',
        "process.stdout.write('key ' + v.slice(0, 10));",
        "setTimeout(() => { process.stdout.write(v.slice(10) + ' done\\n'); process.stderr.write('bad ' + v + '\\n'); process.exit(3); }, 50);",
      ].join(' '))],
    }, { env: { MISTRAL_API_KEY: HELD }, attempt: 1, deps: { fullOutputFile: () => path.join(dir, 'out.log') } });

    const exit = await run.exit;
    const logged = ofType(run.events, 'script_output').map((e) => e.text).join('');
    const saved = exit.fullOutput ? fs.readFileSync(exit.fullOutput.file, 'utf8') : '';
    expect({ output: shows(run.output()), logged: shows(logged), saved: shows(saved), tail: shows(JSON.stringify(exit)) })
      .toEqual({ output: false, logged: false, saved: false, tail: false });
    expect(run.output()).toBe('key [REDACTED secret: 36 chars] done\nbad [REDACTED secret: 36 chars]\n');
  });
});
