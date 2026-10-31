import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PlannerShellSandbox, resolvePlannerSandbox, SEALED_LIMITS, TASK_SEALED_LIMITS, type SealedRunOptions } from '../plannerSandbox';
import { mirrorDir } from '../../worktreeLink';
import { BaseFileSystem } from '../../BaseFileSystem';
import { ApprovalPolicy } from '../../ApprovalPolicy';
import { ranSealed } from '../../researchStepSummary';
import type { ResearchShell, ShellLaunch } from '../../researchShell';
import { MEMORY_LIMIT_SIGNAL, type SandboxLimits } from '../SandboxBackend';
import type { ToolOutcome } from '../../../interfaces/IFileSystem';

/**
 * Sealed runs on this host (ADR-0036 S1): Seatbelt on macOS, bubblewrap on
 * Linux. Where the probe fails (no sandbox, or one that cannot start a sealed
 * run) the whole file skips and its title says why, so a green run never
 * claims a sealed run it did not exercise.
 */

const POSIX: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };

function run(launch: ShellLaunch, command: string, cwd: string): Promise<{ code: number; out: string; ms: number; signal: NodeJS.Signals | null }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(launch.file ?? '/bin/sh', [...launch.args, command], {
      cwd, env: launch.env, timeout: launch.wallTimeMs ?? 60_000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
      resolve({ code, out: `${stdout}${stderr}`, ms: Date.now() - started, signal: err?.signal ?? null });
    });
  });
}

function works(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

/** The planner's shell as the adapters run it, against a real workspace. */
class HostFileSystem extends BaseFileSystem {
  runs = 0;

  constructor(private readonly root: string, sandbox: PlannerShellSandbox) {
    super(undefined, sandbox);
  }

  getWorkspaceRoot(): string { return this.root; }
  protected async readFileImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async listDirImpl(): Promise<ToolOutcome> { throw new Error('not used'); }

  protected async execBashImpl(command: string, shell: ShellLaunch, _signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome> {
    this.runs += 1;
    const { code, out, signal } = await run(shell, command, cwd);
    return { success: code === 0, output: code === 0 ? out : `Command exited ${code}:\n${out}`, truncated: false, ...(signal ? { signal } : {}) };
  }
}

/**
 * CI sets this on a host that is meant to run the sandbox, so a probe that
 * fails there fails the suite: a green run must mean the real sealed run
 * happened, not that every test skipped again.
 */
const REQUIRE_SANDBOX = process.env.ORDEWELL_REQUIRE_SANDBOX === '1';

// The probe is asynchronous and the skip is decided when the suite is collected, so the outer suite awaits it.
describe('sealed runs', async () => {
  const availability = await resolvePlannerSandbox();
  const reason = !availability.available ? availability.notice : !availability.sealed.available ? availability.sealed.notice : undefined;
  // Named in the title, so a CI log shows which workspace mount the run exercised.
  const overlayMode = availability.available && availability.sealed.available
    && (availability.sealed.profile({ workspace: tmpdir() }).throwaway?.length ?? 0) > 0;
  const title = !reason && availability.available
    ? `on this host (${availability.backend.name}, ${overlayMode ? 'throwaway overlay' : 'read-only workspace'})`
    : `${REQUIRE_SANDBOX ? 'required' : 'skipped'}: ${(reason ?? '').split('\n')[0]}`;

  describe.skipIf(reason !== undefined && !REQUIRE_SANDBOX)(title, () => {
    if (reason !== undefined) {
      it('has a sealed run on this host (ORDEWELL_REQUIRE_SANDBOX=1)', () => {
        throw new Error(reason);
      });
      return;
    }

    let workspace: string;
    let elsewhere: string;
    const sandbox = new PlannerShellSandbox();

    const sealed = async (command: string) => run(await sandbox.launchSealed(POSIX, { workspace }), command, workspace);

    beforeAll(() => {
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-ws-')));
      writeFileSync(join(workspace, 'a.md'), 'one\ntwo\n');
      writeFileSync(join(workspace, 'b.md'), 'three\n');
      // Another repository on the same disk, which a sealed run must not see.
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-other-')));
      writeFileSync(join(elsewhere, 'secret.txt'), 'other-repo-secret\n');
      spawnSync('git', ['init', '-q'], { cwd: elsewhere });
    });

    afterAll(() => {
      sandbox.end();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    });

    it('runs a for loop, a here-document and a pipeline over the workspace', async () => {
      const loop = await sealed('for f in *.md; do printf "%s %s\\n" "$f" "$(wc -l < "$f" | tr -d " ")"; done');
      expect(loop).toMatchObject({ code: 0, out: 'a.md 2\nb.md 1\n' });
      const heredoc = await sealed('cat <<EOF\nheredoc-ok\nEOF');
      expect(heredoc).toMatchObject({ code: 0, out: 'heredoc-ok\n' });
      expect((await sealed('cat a.md b.md | sort | head -1')).out).toBe('one\n');
    });

    it.skipIf(!works('python3', ['-c', 'pass']))('runs inline code for an interpreter', async () => {
      const result = await sealed('python3 -c "import sys; print(sum(range(10)), sys.prefix != \'\')"');
      expect(result.out).toContain('45 True');
      expect(result.code).toBe(0);
    });

    it('keeps an intermediate file in $TMPDIR, which is also $HOME, for a later run of the session', async () => {
      expect((await sealed('ls | sort > "$TMPDIR/files" && [ "$HOME" = "$TMPDIR" ] && echo same')).out).toBe('same\n');
      expect((await sealed('cat "$HOME/files"')).out).toBe('a.md\nb.md\n');
    });

    it('cannot change the workspace', async () => {
      const result = await sealed('echo written > a.md; touch new.md; ls new.md');
      // A throwaway overlay takes the write and drops it when the run ends; read-only refuses it.
      const overlaid = availability.available && availability.sealed.available && (availability.sealed.profile({ workspace }).throwaway?.length ?? 0) > 0;
      if (!overlaid) expect(result.code).not.toBe(0);
      expect(existsSync(join(workspace, 'new.md'))).toBe(false);
      expect((await sealed('cat a.md')).out).toBe('one\ntwo\n');
    });

    it("cannot read a file in the user's home directory", async () => {
      // A name of its own, so the check never touches a file the user has there.
      const inHome = join(homedir(), `.ordewell-sealed-check-${process.pid}`);
      writeFileSync(inHome, 'home-secret\n');
      try {
        const result = await sealed(`cat '${inHome}'; ls -a '${homedir()}'`);
        expect(result.out).not.toContain('home-secret');
        // Named in the errors, never listed.
        expect(result.out.split('\n')).not.toContain(`.ordewell-sealed-check-${process.pid}`);
        expect(result.code).not.toBe(0);
      } finally {
        rmSync(inHome, { force: true });
      }
    });

    it('cannot read another repository', async () => {
      const result = await sealed(`cat '${join(elsewhere, 'secret.txt')}'; ls '${elsewhere}'; git -C '${elsewhere}' status`);
      expect(result.out).not.toContain('other-repo-secret');
      expect(result.out.split('\n')).not.toContain('secret.txt');
      expect(result.code).not.toBe(0);
    });

    it('keeps none of the credentials in the environment it was started from', async () => {
      process.env.ORDEWELL_SEALED_CHECK_TOKEN = 'token-value';
      try {
        expect((await sealed('env')).out).not.toContain('token-value');
      } finally {
        delete process.env.ORDEWELL_SEALED_CHECK_TOKEN;
      }
    });

    describe('the network', () => {
      let server: Server;
      let port: number;

      beforeAll(async () => {
        server = createServer((socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
        writeFileSync(join(workspace, 'connect.js'),
          "const s = require('net').connect(Number(process.argv[2]), '127.0.0.1');\n"
          + "s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(3));\n"
          + 'setTimeout(() => process.exit(4), 5000);\n');
      });

      afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

      it('is out of reach, even on the loopback', async () => {
        // The test's own Node may live in the user's home, which a sealed run cannot read, so its exit is all that matters.
        expect((await sealed(`'${process.execPath}' connect.js ${port}`)).code).not.toBe(0);
        if (works('python3', ['-c', 'pass'])) {
          const python = await sealed(`python3 -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 3)"`);
          expect(python.code).not.toBe(0);
        }
      });
    });

    // A bomb spends the user's process budget, which macOS charges every sealed
    // run on the host against, so a sealed run in another file beside it fails
    // to fork. One held well under the real limit leaves them room; the real
    // one runs only in CI's sandbox job, where test:sandbox runs a file at a
    // time.
    const bombProcesses = REQUIRE_SANDBOX ? SEALED_LIMITS.processes : 32;
    const bomb = (name: string) => `${name}() { ${name} | ${name} & }; ${name}`;

    it('stops a fork bomb at its process limit, and leaves none of it behind', async () => {
      const launch = await sandbox.launchSealed(POSIX, { workspace, limits: { ...SEALED_LIMITS, processes: bombProcesses } });
      const result = await run(launch, `echo "group=$$"; ${bomb(`ordewell_bomb_${process.pid}`)}; sleep 2; echo survived`, workspace);
      expect(result.out).toMatch(/fork|Resource temporarily unavailable|Cannot fork/i);
      expect(result.out).toContain('survived');
      expect(result.ms).toBeLessThan(30_000);
      // Its processes went with the run, once a loaded machine has finished
      // tearing them down. Counted by process group: a bomb's forks are named
      // `(bash)` or `<defunct>` while they come and go, never by the marker.
      const group = /group=\s*(\d+)/.exec(result.out)?.[1];
      expect(group).toBeDefined();
      await expectGroupGone(group!);
    });

    /** The run's processes, gone with it once a loaded machine has finished tearing them down. */
    async function expectGroupGone(group: string): Promise<void> {
      const left = () => spawnSync('ps', ['-A', '-o', 'pgid='], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.trim() === group);
      await vi.waitFor(() => expect(left()).toEqual([]), { timeout: 20_000, interval: 500 });
    }

    it('ends at its wall-time limit with every process it started', async () => {
      const launch = await sandbox.launchSealed(POSIX, { workspace, limits: { ...SEALED_LIMITS, wallTimeMs: 1_500 } });
      const result = await run(launch, 'echo "group=$$"; sleep 30; echo survived', workspace);
      expect(result.signal).toBe('SIGKILL');
      expect(result.out).not.toContain('survived');
      expect(result.ms).toBeLessThan(15_000);
      await expectGroupGone(/group=\s*(\d+)/.exec(result.out)![1]);
    });

    it('leaves no watcher behind when the caller kills it', async () => {
      const launch = await sandbox.launchSealed(POSIX, { workspace });
      const child = spawn(launch.file!, [...launch.args, 'sleep 30'], { cwd: workspace, env: launch.env, stdio: ['pipe', 'ignore', 'ignore'] });
      const processes = () => spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout.split('\n').flatMap((line) => {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        return Number.isInteger(ppid) ? [{ pid, ppid }] : [];
      });
      let started: number[] = [];
      await vi.waitFor(() => {
        started = processes().filter((p) => p.ppid === child.pid).map((p) => p.pid);
        expect(started.length).toBeGreaterThanOrEqual(2);
      });
      child.kill('SIGKILL');
      await vi.waitFor(() => {
        const alive = new Set(processes().map((p) => p.pid));
        expect(started.filter((pid) => alive.has(pid))).toEqual([]);
      }, { timeout: 20_000, interval: 500 });
    });

    describe('what a test run needs', () => {
      // A package's real path is the install it came from, which the links in a task's worktree lead to.
      const install = dirname(dirname(realpathSync(createRequire(__filename).resolve('vitest/package.json'))));
      const checkout = dirname(install);
      // CI keeps its Node where no sealed run reads, and a user's may be in their home: the one thing these tests add to the profile.
      const node = realpathSync(process.execPath);

      async function launchWithNode(opts: SealedRunOptions): Promise<ShellLaunch> {
        if (!availability.available || !availability.sealed.available) throw new Error('no sealed run on this host');
        const profile = availability.sealed.profile({ scratch: sandbox.scratchPath(), ...opts });
        return availability.backend.wrap(
          { shell: '/bin/sh', shellArgs: ['-c'], env: process.env },
          { ...profile, read: [...(profile.read as readonly string[]), dirname(dirname(node))] },
        );
      }

      it('runs a WebAssembly memory, which reserves far more address space than it touches', async () => {
        const launch = await launchWithNode({ workspace });
        const result = await run(launch, `'${node}' -e "new WebAssembly.Memory({ initial: 1 }); console.log('reserved')"`, workspace);
        expect(result.out).toContain('reserved');
        expect(result.code).toBe(0);
      });

      describe('a real vitest run', () => {
        let project: string;

        beforeAll(() => {
          // A task's worktree as bootstrap leaves one: a repository, with the install mirrored into it.
          project = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-vitest-')));
          spawnSync('git', ['init', '-q'], { cwd: project });
          writeFileSync(join(project, 'package.json'), '{"name":"sealed-vitest","type":"module"}\n');
          writeFileSync(join(project, 'sum.test.js'), "import { expect, it } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });\n");
          mirrorDir(install, join(project, 'node_modules'), { platform: process.platform, from: checkout, to: project });
        });

        afterAll(() => {
          rmSync(project, { recursive: true, force: true });
        });

        it("passes, keeping its cache in the worktree and writing none of the shared install", async () => {
          const before = readdirSync(install, { withFileTypes: true }).map((entry) => entry.name);
          const launch = await launchWithNode({ workspace: checkout, writable: project, limits: TASK_SEALED_LIMITS });
          const result = await run(launch, `'${node}' node_modules/vitest/vitest.mjs run`, project);
          expect(result.out).toContain('1 passed');
          expect(result.out).not.toContain('EPERM');
          expect(result.code).toBe(0);
          expect(existsSync(join(project, 'node_modules', '.vite', 'vitest', 'results.json'))).toBe(true);
          expect(lstatSync(join(project, 'node_modules', '.vite')).isDirectory()).toBe(true);
          expect(readdirSync(install, { withFileTypes: true }).map((entry) => entry.name)).toEqual(before);

          await run(launch, 'echo written > node_modules/vitest/sealed-check', project);
          expect(existsSync(join(install, 'vitest', 'sealed-check'))).toBe(false);
        }, 60_000);
      });
    });

    describe('its memory limit', () => {
      const limit = 300 * 1024 ** 2;

      /** The same sandbox, holding a sealed run to a limit small enough to pass on any machine. */
      class SmallMemorySandbox extends PlannerShellSandbox {
        constructor(private readonly also: Partial<SandboxLimits> = {}) {
          super();
        }

        override launchSealed(shell: ResearchShell, opts: SealedRunOptions): Promise<ShellLaunch> {
          return super.launchSealed(shell, { ...opts, limits: { ...SEALED_LIMITS, memoryBytes: limit, ...this.also } });
        }
      }

      /** A shell that touches 128 MiB and keeps it, by doubling a string, which needs no interpreter a host may lack. */
      const hold = 'hold() { x=0123456789abcdef; i=0; while [ $i -lt 23 ]; do x="$x$x"; i=$((i + 1)); done; sleep 30; }';

      it('sums its processes, ends them all past the limit, and says so rather than blaming reach', async () => {
        const small = new SmallMemorySandbox();
        try {
          const fs = new HostFileSystem(workspace, small);
          // Each is under the limit: only the sum is over it.
          const outcome = await fs.bash(`echo "group=$$"; ${hold}; hold & hold & hold & wait; echo survived`, undefined, { sealed: true });
          expect(outcome.success).toBe(false);
          expect(outcome.signal).toBe(MEMORY_LIMIT_SIGNAL);
          expect(outcome.output).toContain('ended at its memory limit of 300 MiB');
          expect(outcome.output).toContain('counted across all its processes');
          expect(outcome.output).not.toContain('survived');
          expect(outcome.output).not.toContain('cannot reach the network');
          await expectGroupGone(/group=\s*(\d+)/.exec(outcome.output)![1]);
        } finally {
          small.end();
        }
      }, 40_000);

      it('still ends a run at the limit while a fork bomb holds its process limit', async () => {
        const small = new SmallMemorySandbox({ processes: bombProcesses });
        try {
          const fs = new HostFileSystem(workspace, small);
          // Started before the bomb, they wait for it to reach the limit before
          // they touch anything, and spin on what they hold: no `sleep` of theirs
          // starts under a bomb.
          const spin = hold.replace('hold() {', 'hold() { while [ ! -e "$TMPDIR/go" ]; do :; done;').replace('sleep 30', 'while :; do :; done');
          const settle = 'i=0; while [ $i -lt 100000 ]; do i=$((i + 1)); done';
          // Its complaints go to a file: a bomb's fill any buffer a caller keeps for the output.
          const outcome = await fs.bash(`echo "group=$$"; ${spin}; hold & hold & hold & { ${bomb(`ordewell_bomb_${process.pid}`)}; } 2>"$TMPDIR/bomb"; ${settle}; : > "$TMPDIR/go"; wait; echo survived`, undefined, { sealed: true });
          expect(readFileSync(join(small.scratchPath(), 'bomb'), 'utf8')).toMatch(/fork|Resource temporarily unavailable|Cannot fork/i);
          expect(outcome.signal).toBe(MEMORY_LIMIT_SIGNAL);
          expect(outcome.output).toContain('ended at its memory limit of 300 MiB');
          await expectGroupGone(/group=\s*(\d+)/.exec(outcome.output)![1]);
        } finally {
          small.end();
        }
      }, 40_000);

      it('leaves alone a run that stays under it', async () => {
        const small = new SmallMemorySandbox();
        try {
          const fs = new HostFileSystem(workspace, small);
          const outcome = await fs.bash('x=0123456789abcdef; i=0; while [ $i -lt 20 ]; do x="$x$x"; i=$((i + 1)); done; sleep 3; echo survived', undefined, { sealed: true });
          expect(outcome.success).toBe(true);
          expect(outcome.output).toContain('survived');
        } finally {
          small.end();
        }
      }, 40_000);
    });

    it('backgrounds a job without a stray "Killed" line, keeping the foreground exit code', async () => {
      // The process-group reaper must not let monitor mode print its own kill
      // into the command's output, which reads as a crash (fail-visibly).
      const result = await sealed('sleep 0.1 & echo hi');
      expect(result.out).toContain('hi');
      expect(result.out).not.toMatch(/Killed/);
      expect(result.code).toBe(0);
    });

    it.skipIf(process.platform !== 'darwin')('cannot load a launchd job through the inherited bootstrap port', async () => {
      // launchd would run the job outside the sandbox, as the user; (deny
      // job-creation) refuses it. A read-only probe, cleaned up either way.
      const label = `com.ordewell.sealed-test.${process.pid}`;
      try {
        const result = await sealed(`launchctl submit -l '${label}' -- /usr/bin/true`);
        expect(result.code).not.toBe(0);
        // Nothing loaded: printing the job from outside fails too.
        expect(spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`]).status).not.toBe(0);
      } finally {
        spawnSync('launchctl', ['remove', label]);
      }
    });

    describe('through the planner shell', () => {
      it('runs a refused loop sealed, and says so first', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        const outcome = await fs.bash('for f in *.md; do echo "$f"; done');
        expect(outcome.output).toMatch(/^\[Ran sealed instead of being refused: /);
        expect(outcome.output).toContain('a.md\nb.md');
      });

      it('still refuses a command an exclusion names', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        fs.setApproval(new ApprovalPolicy({ mode: 'deny', preApproved: ['!python3'] }));
        const outcome = await fs.bash('for f in *.md; do python3 -c "print(1)"; done');
        expect(outcome.output).toMatch(/^Command refused: the planner allowlist excludes it \("!python3"\)/);
        expect(fs.runs).toBe(0);
      });

      it('never runs sealed a command the user denied', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        fs.setApproval(new ApprovalPolicy({ ask: async () => false }));
        expect((await fs.bash('npm test')).output).toContain('Command not approved: npm test');
        expect((await fs.bash('npm test', undefined, { sealed: true })).output).toContain('The user denied it this session');
        expect(fs.runs).toBe(0);
        expect(readdirSync(workspace)).not.toContain('node_modules');
      });

      it('still refuses a denied command when a loop wraps it (S3)', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        let asks = 0;
        fs.setApproval(new ApprovalPolicy({ ask: async () => { asks += 1; return false; } }));
        expect((await fs.bash('npm test')).output).toContain('Command not approved: npm test');
        // The classifier refuses the loop unread; without the inner-scope check
        // it would run `npm test` sealed, routing around the denial.
        const wrapped = await fs.bash('for f in *.md; do npm test; done');
        expect(wrapped.output).toContain('The user denied "npm test" this session');
        expect(fs.runs).toBe(0);
        expect(asks).toBe(1);
      });
    });

    describe("through a read-only task's shell (ADR-0046)", () => {
      let repo: string;
      let worktree: string;
      const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

      beforeAll(() => {
        repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-repo-')));
        writeFileSync(join(repo, 'a.md'), 'one\n');
        git(repo, 'init', '-q');
        git(repo, 'add', 'a.md');
        git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
        worktree = join(repo, '.ordewell', 'worktrees', 'run', '1-review');
        git(repo, 'worktree', 'add', '-q', '-b', 'ordewell/run/1-review', worktree);
      });

      afterAll(() => {
        rmSync(repo, { recursive: true, force: true });
      });

      it('takes the task-sized time limit a read-only task gives its sealed runs', async () => {
        const launch = await sandbox.launchSealed(POSIX, { workspace: repo, limits: TASK_SEALED_LIMITS });
        expect(launch.wallTimeMs).toBe(TASK_SEALED_LIMITS.wallTimeMs);
      });

      it('writes its own worktree, sealed, and nothing of the checkout it was cut from', async () => {
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          const tried = await shell.run('echo fixed > a.md && printf "test\\n" > added.test && cat a.md added.test');
          expect(tried.output).toMatch(/^\[Ran sealed instead of being refused: /);
          expect(tried.output).toContain('fixed\ntest');
          expect(existsSync(join(worktree, 'added.test'))).toBe(true);

          // Edit then test: the later command runs in the same worktree, sealed too.
          const tested = await shell.run('test -f added.test && cat added.test');
          expect(tested.success).toBe(true);
          expect(tested.output).toContain('test');

          const escaped = await shell.run(`echo changed > '${join(repo, 'a.md')}'`);
          // A throwaway overlay takes the write and drops it with the run; read-only refuses it (S1).
          const overlaid = availability.available && availability.sealed.available
            && (availability.sealed.profile({ workspace: repo }).throwaway?.length ?? 0) > 0;
          if (!overlaid) expect(escaped.success).toBe(false);
          expect(readFileSync(join(repo, 'a.md'), 'utf8')).toBe('one\n');
          // A file the checkout never had is the sharper canary: no copy-up of an existing one can hide it.
          const planted = await shell.run(`touch '${join(repo, 'escaped.txt')}'`);
          if (!overlaid) expect(planted.success).toBe(false);
          expect(existsSync(join(repo, 'escaped.txt'))).toBe(false);
          // Nor does a later sealed run see the discarded layer: the checkout is still the base.
          const reread = await shell.run(`cat '${join(repo, 'a.md')}'`);
          expect(reread.success).toBe(true);
          expect(reread.output.endsWith('one\n')).toBe(true);
        } finally {
          shell.end();
        }
      });

      it('leaves no link out of its worktree for a later command, or a native read tool, to follow', async () => {
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          await shell.run(`ln -s '${elsewhere}' leak`);
          const read = await shell.run('cat leak/secret.txt');
          expect(read.output).not.toContain('other-repo-secret');
          expect(() => lstatSync(join(worktree, 'leak'))).toThrow();

          // Seatbelt refuses a link made or moved into the worktree, but not a
          // directory moved in that holds one, so the walk runs on macOS too.
          await shell.run(`mkdir "$TMPDIR/d" && ln -s '${elsewhere}' "$TMPDIR/d/leak" && mv "$TMPDIR/d" moved`);
          expect(existsSync(join(worktree, 'moved'))).toBe(true);
          expect(() => lstatSync(join(worktree, 'moved', 'leak'))).toThrow();

          // Nor one in a directory left traversable but not listable, which a read naming the path still follows.
          await shell.run(`mkdir "$TMPDIR/h" && ln -s '${elsewhere}' "$TMPDIR/h/key" && mv "$TMPDIR/h" hidden && chmod 111 hidden`);
          expect(existsSync(join(worktree, 'hidden'))).toBe(true);
          expect(() => readFileSync(join(worktree, 'hidden', 'key', 'secret.txt'))).toThrow();
        } finally {
          shell.end();
          rmSync(join(worktree, 'leak'), { force: true });
          rmSync(join(worktree, 'moved'), { recursive: true, force: true });
          if (existsSync(join(worktree, 'hidden'))) chmodSync(join(worktree, 'hidden'), 0o700);
          rmSync(join(worktree, 'hidden'), { recursive: true, force: true });
        }
      });

      it('runs an allowlisted command sealed once a sealed run may have rewritten what it runs', async () => {
        // A file outside the workspace that the planner's sandbox, which reads the whole host, can read.
        const canaryDir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-canary-')));
        const canary = join(canaryDir, 'canary.txt');
        writeFileSync(canary, `canary-${process.pid}\n`);
        const fs = new HostFileSystem(repo, sandbox);
        fs.setApproval(new ApprovalPolicy({ preApproved: ['sh check.sh'] }));
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        const fresh = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          writeFileSync(join(worktree, 'check.sh'), 'echo checked\n');
          const before = await shell.run('sh check.sh');
          expect(ranSealed(before.output)).toBe(false);
          expect(before.output).toContain('checked');

          const rewrite = await shell.run(`echo "cat '${canary}'" > check.sh`);
          expect(ranSealed(rewrite.output)).toBe(true);
          expect(readFileSync(join(worktree, 'check.sh'), 'utf8')).toContain(canary);

          const after = await shell.run('sh check.sh');
          expect(ranSealed(after.output)).toBe(true);
          expect(after.output).not.toContain(`canary-${process.pid}`);

          // What the rewritten script would have read outside the sealed profile, in an attempt's shell that never ran one sealed.
          expect((await fresh.run('sh check.sh')).output).toContain(`canary-${process.pid}`);
        } finally {
          shell.end();
          fresh.end();
          rmSync(join(worktree, 'check.sh'), { force: true });
          rmSync(canaryDir, { recursive: true, force: true });
        }
      });

      it('reads the repository through git, and cannot record anything in it', async () => {
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        const head = git(repo, 'rev-parse', 'ordewell/run/1-review').stdout;
        try {
          const log = await shell.run('git log --oneline -1 | cat');
          expect(log.output).toContain('base');

          const commit = await shell.run('git add -A && git -c user.name=t -c user.email=t@t commit -qm task');
          // A throwaway overlay takes the commit and drops it with the run (S1);
          // without one the repository is read-only and refuses it outright.
          const overlaid = availability.available && availability.sealed.available
            && (availability.sealed.profile({ workspace: repo }).throwaway?.length ?? 0) > 0;
          if (commit.success) expect(overlaid).toBe(true);
          else expect(commit.output).toContain('git can read the repository but not record anything in it');
          expect(git(repo, 'rev-parse', 'ordewell/run/1-review').stdout).toBe(head);
        } finally {
          shell.end();
        }
      });

      it("cannot write, replace, rename or remove its worktree's .git, so git outside loads no planted repository (ADR-0046)", async () => {
        const original = readFileSync(join(worktree, '.git'), 'utf8');
        const launch = await sandbox.launchSealed(POSIX, { workspace: repo, writable: worktree, worktrees: [worktree], limits: TASK_SEALED_LIMITS });
        const inWorktree = (command: string) => run(launch, command, worktree);
        try {
          // git still reads the repository inside the sealed run.
          expect((await inWorktree('git log --oneline -1 | cat')).out).toContain('base');

          for (const command of ['rm -f .git', 'mv .git moved-git', 'rm -f .git && mkdir .git', 'echo planted >> .git', 'printf "gitdir: planted\\n" > .git']) {
            expect((await inWorktree(command)).code).not.toBe(0);
          }
          // Untouched: still the repository's gitdir pointer, never removed or moved.
          expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(original);
          expect(existsSync(join(worktree, 'moved-git'))).toBe(false);

          // Creating a `.git` beneath the worktree: refused on macOS; a residual bubblewrap cannot close on Linux.
          const beneath = await inWorktree('mkdir -p sub && mkdir sub/.git');
          if (process.platform === 'darwin') {
            expect(beneath.code).not.toBe(0);
            expect(existsSync(join(worktree, 'sub', '.git'))).toBe(false);
          }
        } finally {
          rmSync(join(worktree, 'sub'), { recursive: true, force: true });
          rmSync(join(worktree, 'moved-git'), { recursive: true, force: true });
        }
      });

      it("protects every .git entry the checkout brought, so neither a submodule's file nor a vendored repository can be armed (ADR-0046)", async () => {
        const nested = join(worktree, 'submodule');
        git(repo, 'worktree', 'add', '-q', '-b', 'ordewell/run/1-review-submodule', nested);
        const vendor = join(worktree, 'vendor');
        mkdirSync(vendor, { recursive: true });
        git(vendor, 'init', '-q');
        const submoduleGit = readFileSync(join(nested, '.git'), 'utf8');
        const vendorConfig = readFileSync(join(vendor, '.git', 'config'), 'utf8');
        const canary = join(repo, `nested-canary-${process.pid}`);
        writeFileSync(join(worktree, 'evil.sh'), `#!/bin/sh\ntouch '${canary}'\n`);
        chmodSync(join(worktree, 'evil.sh'), 0o755);
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          // A submodule's `.git` file repointed at a repository of the run's
          // own, armed to run a program for git outside the sandbox.
          const armFile = await shell.run(`git init -q --bare submodule/fake && git --git-dir=submodule/fake config core.bare false && git --git-dir=submodule/fake config core.worktree .. && git --git-dir=submodule/fake config core.fsmonitor "$PWD/evil.sh" && printf 'gitdir: fake\\n' > submodule/.git`);
          expect(ranSealed(armFile.output)).toBe(true);
          expect(armFile.success).toBe(false);
          // The write to the protected file is what failed: the repository of
          // the run's own was made first.
          expect(existsSync(join(nested, 'fake'))).toBe(true);
          expect(readFileSync(join(nested, '.git'), 'utf8')).toBe(submoduleGit);

          // A vendored repository's own config, armed the same way.
          const armDir = await shell.run('git -C vendor config core.fsmonitor "$PWD/evil.sh"');
          expect(ranSealed(armDir.output)).toBe(true);
          expect(armDir.success).toBe(false);
          expect(readFileSync(join(vendor, '.git', 'config'), 'utf8')).toBe(vendorConfig);

          // What the runner's own git runs there, as the user and outside the sandbox.
          expect(git(nested, 'status').status).toBe(0);
          expect(git(vendor, 'status').status).toBe(0);
          expect(existsSync(canary)).toBe(false);
        } finally {
          shell.end();
          rmSync(join(nested, 'fake'), { recursive: true, force: true });
          writeFileSync(join(nested, '.git'), submoduleGit);
          writeFileSync(join(vendor, '.git', 'config'), vendorConfig);
          rmSync(join(worktree, 'evil.sh'), { force: true });
          rmSync(canary, { force: true });
          git(repo, 'worktree', 'remove', '--force', nested);
          rmSync(vendor, { recursive: true, force: true });
        }
      });

      it("cannot rename or remove its own worktree root, so a .git planted outside cannot be moved back (ADR-0046)", async () => {
        const original = readFileSync(join(worktree, '.git'), 'utf8');
        const canary = join(repo, `root-canary-${process.pid}`);
        writeFileSync(join(worktree, 'evil.sh'), `#!/bin/sh\ntouch '${canary}'\n`);
        chmodSync(join(worktree, 'evil.sh'), 0o755);
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          // #51's sequence: take the worktree out of the sandbox's writable set,
          // plant a repository of the run's own, and move it back under the
          // path the sweep trusts. A root that cannot be renamed leaves it all
          // inside the writable directory where every rule still applies.
          const moved = await shell.run(`orig="$PWD"; cd "$TMPDIR"; mv "$orig" moved && { cd moved; git init -q --bare planted; git --git-dir=planted config core.bare false; git --git-dir=planted config core.worktree ..; git --git-dir=planted config core.fsmonitor "$orig/evil.sh"; printf 'gitdir: planted\\n' > .git; cd "$TMPDIR"; mv moved "$orig"; }`);
          expect(ranSealed(moved.output)).toBe(true);
          expect(moved.success).toBe(false);
          expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(original);
          expect(existsSync(join(worktree, 'planted'))).toBe(false);

          // The root itself is denied, not its contents: creating and removing
          // a file there, and sealed git reads, still work.
          const inside = await shell.run('printf "inside\\n" > inside-root.txt && cat inside-root.txt');
          expect(inside.success).toBe(true);
          expect(inside.output).toContain('inside');
          expect((await shell.run('git status --short | cat')).success).toBe(true);
          expect((await shell.run('git diff | cat')).success).toBe(true);
          expect((await shell.run('rm inside-root.txt')).success).toBe(true);
          expect(existsSync(join(worktree, 'inside-root.txt'))).toBe(false);

          // What the runner's own git runs where it starts, as the user and outside the sandbox.
          expect(spawnSync('git', ['-C', worktree, 'status'], { encoding: 'utf8' }).status).toBe(0);
          expect(existsSync(canary)).toBe(false);
        } finally {
          shell.end();
          writeFileSync(join(worktree, '.git'), original);
          rmSync(join(worktree, 'planted'), { recursive: true, force: true });
          rmSync(join(worktree, 'evil.sh'), { force: true });
          rmSync(canary, { force: true });
        }
      });

      it("in a repo group, writes each worktree but not the group root, and sweeps a .git planted below one (ADR-0046)", async () => {
        const group = join(repo, '.ordewell', 'worktrees', 'run', '3-group-write');
        const alpha = join(group, 'alpha');
        const beta = join(group, 'beta');
        git(repo, 'worktree', 'add', '-q', '-b', 'ordewell/run/3-group-write-alpha', alpha);
        git(repo, 'worktree', 'add', '-q', '-b', 'ordewell/run/3-group-write-beta', beta);
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: group, writable: group, worktrees: [alpha, beta] });
        try {
          // The group root is where the runner's own git starts, and holds no
          // worktree's `.git`: it is not persistently writable. Where the root
          // is a read-only bind the write is refused; under bubblewrap's
          // throwaway overlay it succeeds into the layer discarded with the run.
          const root = await shell.run('echo nope > root.txt');
          const overlaid = availability.available && availability.sealed.available
            && (availability.sealed.profile({ workspace: repo }).throwaway?.length ?? 0) > 0;
          if (!overlaid) expect(root.success).toBe(false);
          expect(existsSync(join(group, 'root.txt'))).toBe(false);

          const inAlpha = await shell.run('echo changed > alpha/a.md && cat alpha/a.md');
          expect(inAlpha.success).toBe(true);
          expect(inAlpha.output).toContain('changed');
          const inBeta = await shell.run('printf "one\\n" > beta/b.md && cat beta/b.md');
          expect(inBeta.success).toBe(true);
          expect(inBeta.output).toContain('one');

          // Sealed git still reads the repository through each worktree's `.git` file.
          const log = await shell.run('git -C alpha log --oneline -1 | cat');
          expect(log.output).toContain('base');
          expect((await shell.run('git -C beta status --short')).success).toBe(true);

          // A `.git` below a worktree: refused by Seatbelt, planted and swept
          // by the run under bubblewrap. Either way none is left for git.
          const planted = await shell.run('mkdir -p alpha/sub && mkdir alpha/sub/.git');
          if (process.platform === 'linux') expect(planted.output).toContain('alpha/sub/.git');
          expect(existsSync(join(alpha, 'sub', '.git'))).toBe(false);
        } finally {
          shell.end();
          git(repo, 'worktree', 'remove', '--force', alpha);
          git(repo, 'worktree', 'remove', '--force', beta);
          rmSync(group, { recursive: true, force: true });
        }
      });

      it("leaves no .git at a repo group's task workspace, where the runner's own git starts (ADR-0046)", async () => {
        const group = join(repo, '.ordewell', 'worktrees', 'run', '2-group');
        const alpha = join(group, 'alpha');
        git(repo, 'worktree', 'add', '-q', '-b', 'ordewell/run/2-group', alpha);
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: group, writable: group, worktrees: [alpha] });
        try {
          const planted = await shell.run(`git init -q --bare .git && printf '[core]\\n\\tfsmonitor = %s/evil.sh\\n' "$PWD" >> .git/config && printf '#!/bin/sh\\ntouch CANARY\\n' > evil.sh && chmod +x evil.sh`);
          expect(ranSealed(planted.output)).toBe(true);
          await shell.run('mkdir .GIT');
          // On macOS, whose file system ignores case, `.GIT` is the `.git` git looks for.
          expect(existsSync(join(group, '.git'))).toBe(false);

          // What the runner runs where it starts, as the user and outside the sandbox.
          git(group, 'status');
          expect(existsSync(join(group, 'CANARY'))).toBe(false);
        } finally {
          shell.end();
          git(repo, 'worktree', 'remove', '--force', alpha);
          rmSync(group, { recursive: true, force: true });
        }
      });
    });
  });
});
