import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EscalationNotifier, notifyCommandOf, parseNotifyCommand, runNotifyCommand, type NotifyRun } from '../escalationNotifier';
import type { Escalation } from '../escalations';

const COMMAND = ['notify-me', '--now'];

const waiting = (id: string, over: Partial<Escalation> = {}): Escalation => ({
  id,
  kind: 'failed',
  task: { id: 't1', ref: '3.1', title: 'Fix the login' },
  reason: 'It failed.',
  options: [],
  ...over,
});

function notifier(over: { command?: () => readonly string[]; run?: NotifyRun } = {}) {
  const run = vi.fn<NotifyRun>(async () => {});
  const log = vi.fn();
  const subject = new EscalationNotifier({ command: over.command ?? (() => COMMAND), run: over.run ?? run, log });
  return { subject, run, log };
}

const settled = () => new Promise((resolve) => { setImmediate(resolve); });

describe('EscalationNotifier', () => {
  it('runs the command once for each id, however often the list repeats it', async () => {
    const { subject, run } = notifier();

    subject.changed([waiting('failed:t1:1')]);
    subject.changed([waiting('failed:t1:1')]);
    subject.changed([waiting('failed:t1:1'), waiting('approval:t2:1:p1')]);
    subject.changed([]);
    subject.changed([waiting('failed:t1:1')]);
    await settled();

    expect(run.mock.calls.map(([, env]) => env.ORDEWELL_ESCALATION_ID)).toEqual(['failed:t1:1', 'approval:t2:1:p1']);
    expect(run.mock.calls[0][0]).toEqual(COMMAND);
  });

  it('hands the escalation over in the four variables, and leaves the task empty on a wait of the run', async () => {
    const { subject, run } = notifier();

    subject.changed([waiting('failed:t1:1'), waiting('blocked-run:2', { kind: 'blocked-run', task: undefined, reason: 'Tracked files have uncommitted changes.' })]);
    await settled();

    expect(run.mock.calls.map(([, env]) => env)).toEqual([
      { ORDEWELL_ESCALATION_ID: 'failed:t1:1', ORDEWELL_ESCALATION_KIND: 'failed', ORDEWELL_ESCALATION_TASK: '3.1 Fix the login', ORDEWELL_ESCALATION_REASON: 'It failed.' },
      { ORDEWELL_ESCALATION_ID: 'blocked-run:2', ORDEWELL_ESCALATION_KIND: 'blocked-run', ORDEWELL_ESCALATION_TASK: '', ORDEWELL_ESCALATION_REASON: 'Tracked files have uncommitted changes.' },
    ]);
  });

  it('takes control characters out of what a runner wrote, and caps its length', async () => {
    const { subject, run } = notifier();

    subject.changed([waiting('checkpoint:t1:1', {
      task: { id: 't1', ref: '2', title: 'Line one\nLine two\r\u0000\u001b[31mred\u007f\u0085end' },
      reason: `Checkpoint: spoof\u202egnp.exe\u2028next ${'x'.repeat(600)}`,
    })]);
    await settled();

    const env = run.mock.calls[0][1];
    expect(env.ORDEWELL_ESCALATION_TASK).toBe('2 Line one Line two [31mred end');
    expect(env.ORDEWELL_ESCALATION_REASON).toBe(`Checkpoint: spoof gnp.exe next ${'x'.repeat(468)}…`);
    expect([...env.ORDEWELL_ESCALATION_REASON]).toHaveLength(500);
  });

  it('never cuts a character in two at the cap', async () => {
    const { subject, run } = notifier();

    subject.changed([waiting('failed:t1:1', { reason: `${'x'.repeat(498)}😀😀😀` })]);
    await settled();

    expect(run.mock.calls[0][1].ORDEWELL_ESCALATION_REASON).toBe(`${'x'.repeat(498)}😀…`);
  });

  it('counts what already waits as told, so a load sends nothing, and goes on with what is new', async () => {
    const { subject, run } = notifier();

    subject.baseline([waiting('checkpoint:t1:1'), waiting('merge-all:r1')]);
    subject.changed([waiting('checkpoint:t1:1'), waiting('merge-all:r1')]);
    expect(run).not.toHaveBeenCalled();

    subject.changed([waiting('checkpoint:t1:1'), waiting('failed:t2:1')]);
    await settled();
    expect(run.mock.calls.map(([, env]) => env.ORDEWELL_ESCALATION_ID)).toEqual(['failed:t2:1']);
  });

  it('forgets the plan left: a baseline replaces what was told, so another plan\'s same id is told again', async () => {
    const { subject, run } = notifier();

    subject.changed([waiting('failed:t1:1')]);
    subject.baseline([]);
    subject.changed([waiting('failed:t1:1')]);
    await settled();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stays silent while hushed: a plan on its way out says nothing, and neither does one coming in', async () => {
    const { subject, run } = notifier();

    subject.hush();
    subject.changed([waiting('failed:t1:1')]);
    expect(run).not.toHaveBeenCalled();

    subject.baseline([waiting('failed:t1:1')]);
    subject.changed([waiting('failed:t1:1'), waiting('failed:t2:1')]);
    await settled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs nothing with no command, and a command set later does not tell what already went by', async () => {
    let command: string[] = [];
    const { subject, run } = notifier({ command: () => command });

    subject.changed([waiting('failed:t1:1')]);
    command = COMMAND;
    subject.changed([waiting('failed:t1:1')]);
    await settled();
    expect(run).not.toHaveBeenCalled();

    subject.changed([waiting('failed:t1:1'), waiting('failed:t2:1')]);
    await settled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('logs a failure once, naming the program but none of its arguments, and never throws', async () => {
    const { subject, log } = notifier({
      command: () => ['curl', 'https://hooks.example.com/secret-token'],
      run: async () => { throw new Error('exited with code 7'); },
    });

    subject.changed([waiting('failed:t1:1')]);
    subject.changed([waiting('failed:t2:1')]);
    await settled();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('The notify command curl failed, and is not retried: exited with code 7');
  });

  it('survives a command it cannot read and a run that throws as it is called', async () => {
    const unreadable = notifier({ command: () => { throw new Error('bad setting'); } });
    const throwing = notifier({ run: () => { throw new Error('spawn EINVAL'); } });

    expect(() => unreadable.subject.changed([waiting('failed:t1:1')])).not.toThrow();
    expect(() => throwing.subject.changed([waiting('failed:t1:1')])).not.toThrow();
    await settled();

    expect(unreadable.log).toHaveBeenCalledTimes(1);
    expect(throwing.log).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the command: an answer that never comes holds nothing up', () => {
    const { subject } = notifier({ run: () => new Promise(() => {}) });

    expect(() => subject.changed([waiting('failed:t1:1')])).not.toThrow();
  });

  describe('with many escalations at once', () => {
    /** A command that answers only when told to, in the order it was started. */
    function held() {
      const answers: (() => void)[] = [];
      const started: string[] = [];
      const run: NotifyRun = (_command, env) => {
        started.push(env.ORDEWELL_ESCALATION_ID);
        return new Promise((resolve) => { answers.push(resolve); });
      };
      return { run, started, answer: async () => { answers.shift()?.(); await settled(); } };
    }

    const gates = (count: number) => Array.from({ length: count }, (_, i) => waiting(`merge-gate:t${i + 1}:1`));

    it('runs two at a time, and each one that ends lets the next start, in the order they came', async () => {
      const { run, started, answer } = held();
      const { subject } = notifier({ run });

      subject.changed(gates(5));
      expect(started).toEqual(['merge-gate:t1:1', 'merge-gate:t2:1']);

      await answer();
      expect(started).toEqual(['merge-gate:t1:1', 'merge-gate:t2:1', 'merge-gate:t3:1']);

      await answer();
      await answer();
      await answer();
      expect(started).toEqual(['merge-gate:t1:1', 'merge-gate:t2:1', 'merge-gate:t3:1', 'merge-gate:t4:1', 'merge-gate:t5:1']);
    });

    it('still tells an id once, however often the list repeats one that is waiting its turn', async () => {
      const { run, started, answer } = held();
      const { subject } = notifier({ run });

      subject.changed(gates(3));
      subject.changed(gates(3));
      await answer();
      await answer();
      await answer();

      expect(started).toEqual(['merge-gate:t1:1', 'merge-gate:t2:1', 'merge-gate:t3:1']);
    });

    it('goes on to the next when one fails', async () => {
      const started: string[] = [];
      const { subject, log } = notifier({
        run: async (_command, env) => {
          started.push(env.ORDEWELL_ESCALATION_ID);
          throw new Error('exited with code 1');
        },
      });

      subject.changed(gates(4));
      await settled();

      expect(started).toHaveLength(4);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('keeps 32 waiting, and says once that it dropped the rest', async () => {
      const { run, started, answer } = held();
      const { subject, log } = notifier({ run });

      subject.changed(gates(40));
      subject.changed([...gates(40), waiting('merge-gate:t41:1')]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('The notify command');
      expect(log.mock.calls[0][0]).toContain('list');

      for (let i = 0; i < 40; i++) await answer();
      expect(started).toEqual(gates(34).map(({ id }) => id));
    });

    it('says it dropped some even after a failure was logged: they are two different things', async () => {
      const answers: (() => void)[] = [];
      let fails = true;
      const { subject, log } = notifier({
        run: () => (fails ? Promise.reject(new Error('exited with code 1')) : new Promise((resolve) => { answers.push(resolve); })),
      });

      subject.changed([waiting('failed:t1:1')]);
      await settled();
      fails = false;
      subject.changed(gates(35));

      expect(log).toHaveBeenCalledTimes(2);
    });

    it('uses the command as it read it when the escalation appeared', async () => {
      const { run, answer } = held();
      const calls = vi.fn(run);
      let command = ['first'];
      const { subject } = notifier({ command: () => command, run: calls });

      subject.changed(gates(3));
      command = ['second'];
      await answer();

      expect(calls.mock.calls[2][0]).toEqual(['first']);
    });

    it('leaves a turn free for what comes next when no command is set', async () => {
      let command: string[] = [];
      const { run, started } = held();
      const { subject, log } = notifier({ command: () => command, run });

      subject.changed(gates(40));
      command = COMMAND;
      subject.changed([waiting('failed:t1:1')]);

      expect(started).toEqual(['failed:t1:1']);
      expect(log).not.toHaveBeenCalled();
    });

    it('still runs what was waiting when a plan goes on its way out: it was news as it appeared', async () => {
      const { run, started, answer } = held();
      const { subject } = notifier({ run });

      subject.changed(gates(3));
      subject.hush();
      await answer();

      expect(started).toContain('merge-gate:t3:1');
    });
  });
});

describe('runNotifyCommand', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-notify-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A node program that reports how it was run, then does what `then` says. */
  function program(then = ''): { path: string; report: string } {
    const report = join(dir, 'report.json');
    const path = join(dir, 'program.js');
    writeFileSync(path, `
      const fs = require('fs');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('ORDEWELL_ESCALATION_')));
      fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2), env, cwd: process.cwd(), pid: process.pid }));
      ${then}
    `);
    return { path, report };
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('keeps the text in the environment: nothing in it reaches the command line or a shell', async () => {
    const { path, report } = program();
    const hostile = `$(touch ${dir}/pwned) \`touch ${dir}/pwned\`; touch ${dir}/pwned`;

    await runNotifyCommand([process.execPath, path, 'fixed', '$ORDEWELL_ESCALATION_REASON'], { ORDEWELL_ESCALATION_REASON: hostile });

    const seen = JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; env: Record<string, string> };
    expect(seen.argv).toEqual(['fixed', '$ORDEWELL_ESCALATION_REASON']);
    expect(seen.env).toEqual({ ORDEWELL_ESCALATION_REASON: hostile });
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('runs in the home directory, outside any repository', async () => {
    const { path, report } = program();

    await runNotifyCommand([process.execPath, path], {});

    expect((JSON.parse(readFileSync(report, 'utf8')) as { cwd: string }).cwd).toBe(realpathSync(homedir()));
  });

  it('rejects on a failing exit and on a program that is not there', async () => {
    await expect(runNotifyCommand([process.execPath, '-e', 'process.exit(3)'], {})).rejects.toThrow('exited with code 3');
    await expect(runNotifyCommand([join(dir, 'no-such-program')], {})).rejects.toThrow('ENOENT');
  });

  it('stops a command that hangs at the limit, and what it started with it', async () => {
    const child = join(dir, 'child.pid');
    const { path, report } = program(`
      const started = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(child)}, String(started.pid));
      setInterval(() => {}, 1000);
    `);

    await expect(runNotifyCommand([process.execPath, path], {}, { timeLimitMs: 1000 })).rejects.toThrow('no answer within 1000 ms');

    const { pid } = JSON.parse(readFileSync(report, 'utf8')) as { pid: number };
    await vi.waitFor(() => expect([alive(pid), alive(Number(readFileSync(child, 'utf8')))]).toEqual([false, false]));
  });

  describe('when the host ends with a command still running', () => {
    /** A real host running a hung command that started a child, far from its limit, with an exit of its own on SIGUSR2. */
    async function hostWithHungCommand() {
      const childPid = join(dir, 'child.pid');
      const { path, report } = program(`
        const started = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(childPid)}, String(started.pid));
        setInterval(() => {}, 1000);
      `);
      const source = join(dir, 'host.ts');
      writeFileSync(source, `
        import { runNotifyCommand } from ${JSON.stringify(join(__dirname, '..', 'escalationNotifier.ts'))};
        process.on('SIGUSR2', () => process.exit(0));
        void runNotifyCommand([process.execPath, ${JSON.stringify(path)}], {}, { timeLimitMs: 60_000 }).catch(() => {});
        setInterval(() => {}, 1000);
      `);
      const bundle = join(dir, 'host.js');
      // The notifier's imports have no extensions and its classes use parameter properties, which node's own type stripping takes neither of.
      buildSync({ entryPoints: [source], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
      const host = spawn(process.execPath, [bundle], { stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        host.once('exit', (code, signal) => resolve({ code, signal }));
      });
      await vi.waitFor(() => expect(existsSync(report) && existsSync(childPid) && readFileSync(childPid, 'utf8') !== '').toBe(true));
      const pids = [(JSON.parse(readFileSync(report, 'utf8')) as { pid: number }).pid, Number(readFileSync(childPid, 'utf8'))];
      return { host, exited, pids };
    }

    const cleanUp = (pids: number[]) => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ }
      }
    };

    it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('a signal ends it and what it started, and still ends the host by that signal', async (signal) => {
      const { host, exited, pids } = await hostWithHungCommand();
      try {
        expect(pids.map(alive)).toEqual([true, true]);

        host.kill(signal);

        expect(await exited).toEqual({ code: null, signal });
        await vi.waitFor(() => expect(pids.map(alive)).toEqual([false, false]));
      } finally {
        host.kill('SIGKILL');
        cleanUp(pids);
      }
    });

    it.skipIf(process.platform === 'win32')('a host\'s own exit ends it too', async () => {
      const { host, exited, pids } = await hostWithHungCommand();
      try {
        host.kill('SIGUSR2');

        expect(await exited).toEqual({ code: 0, signal: null });
        await vi.waitFor(() => expect(pids.map(alive)).toEqual([false, false]));
      } finally {
        host.kill('SIGKILL');
        cleanUp(pids);
      }
    });
  });
});

describe('notifyCommandOf', () => {
  it('takes an argument vector as written, spaces and empty words included', () => {
    expect(notifyCommandOf(['terminal-notifier', '-title', 'Ordewell run', ''])).toEqual(['terminal-notifier', '-title', 'Ordewell run', '']);
  });

  it.each<[string, unknown]>([
    ['a string, which only a shell would split', 'notify-send hi'],
    ['nothing', undefined],
    ['an empty list', []],
    ['a list with no program', ['  ', 'hi']],
    ['a list of anything else', ['notify-send', 3]],
  ])('refuses %s', (_what, value) => {
    expect(notifyCommandOf(value)).toEqual([]);
  });
});

describe('parseNotifyCommand', () => {
  it('reads a JSON array', () => {
    expect(parseNotifyCommand('["notify-send", "Ordewell"]')).toEqual(['notify-send', 'Ordewell']);
  });

  it('is empty, and says nothing, when unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseNotifyCommand(undefined)).toEqual([]);
    expect(parseNotifyCommand('  ')).toEqual([]);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses anything else, with one warning for each value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseNotifyCommand('notify-send hi')).toEqual([]);
    expect(parseNotifyCommand('notify-send hi')).toEqual([]);
    expect(parseNotifyCommand('"notify-send"')).toEqual([]);

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
