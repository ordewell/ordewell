import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseFileSystem } from '../BaseFileSystem';
import { ApprovalPolicy } from '../ApprovalPolicy';
import { ranSealed } from '../researchStepSummary';
import type { ShellLaunch } from '../researchShell';
import {
  PlannerShellSandbox, SEALED_LIMITS, plannerShellProfile, sealedShellProfile, type PlannerSandboxAvailability,
} from '../sandbox/plannerSandbox';
import type { SandboxBackend, SandboxLaunch, SandboxProfile } from '../sandbox/SandboxBackend';
import type { ToolOutcome } from '../../interfaces/IFileSystem';
import { DEFAULT_SCRIPT_TIMEOUT_MS } from '../../models/ScriptTask';

/**
 * A read-only task's `run_command` (ADR-0046): the planner's command rules at
 * the task's working directory, nobody asked, and what would ask or be
 * refused run sealed with the task's worktree writable.
 */

/** Hands back a launch that names the profile it was built from, so a test reads which profile each command ran under. */
class RecordingBackend implements SandboxBackend {
  readonly name = 'recording';
  readonly profiles: SandboxProfile[] = [];

  async probe(): Promise<{ ok: true }> {
    return { ok: true };
  }

  wrap(_invocation: unknown, profile: SandboxProfile): SandboxLaunch {
    this.profiles.push(profile);
    const sealed = profile.limits !== undefined;
    return { file: sealed ? '/sealed' : '/sandboxed', args: [String(this.profiles.length - 1)], env: {}, ...(sealed ? { wallTimeMs: profile.limits!.wallTimeMs, memoryBytes: profile.limits!.memoryBytes } : {}) };
  }
}

function available(backend: SandboxBackend): PlannerSandboxAvailability {
  return {
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'darwin', services: [] }, opts),
    sealed: { available: true, profile: (opts) => sealedShellProfile({ platform: 'darwin', reads: ['/usr'], masked: [], overlay: false }, opts) },
  };
}

interface Ran {
  command: string;
  cwd: string;
  sealed: boolean;
  /** The profile it ran under; absent where no sandbox ran it. */
  profile?: SandboxProfile;
}

class WorkspaceFileSystem extends BaseFileSystem {
  readonly ran: Ran[] = [];
  /** What a command does to the disk as it runs, for one that must leave something behind. */
  effect?: (ran: Ran) => Promise<void> | void;
  /** What the next command returns, for a shell the test ends itself (a time limit); `ran` otherwise. */
  result?: ToolOutcome;

  constructor(private readonly root: string, private readonly backend: RecordingBackend | null) {
    super(undefined, new PlannerShellSandbox(async () => (backend ? available(backend) : { available: false, notice: 'no sandbox in this test' })));
  }

  getWorkspaceRoot(): string { return this.root; }
  protected async readFileImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async listDirImpl(): Promise<ToolOutcome> { throw new Error('not used'); }

  protected async execBashImpl(command: string, shell: ShellLaunch, _signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome> {
    const profile = shell.file === null ? undefined : this.backend?.profiles[Number(shell.args[0])];
    const ran = { command, cwd, sealed: shell.file === '/sealed', ...(profile ? { profile } : {}) };
    this.ran.push(ran);
    await this.effect?.(ran);
    return this.result ?? { success: true, output: 'ran', truncated: false };
  }
}

describe("a read-only task's shell (ADR-0046)", () => {
  let workspace: string;
  let worktree: string;
  let asked: string[];

  /** The session's approvals under Guarded, whose card says no unless `yes` names the command. */
  function guarded(opts: { preApproved?: string[]; yes?: string[] } = {}): ApprovalPolicy {
    return new ApprovalPolicy({
      mode: 'ask',
      preApproved: opts.preApproved ?? [],
      ask: async (req) => {
        asked.push(req.subject);
        return opts.yes?.includes(req.subject) ?? false;
      },
    });
  }

  function session(backend: RecordingBackend | null = new RecordingBackend(), approval = guarded()): WorkspaceFileSystem {
    const fs = new WorkspaceFileSystem(workspace, backend);
    fs.setApproval(approval);
    return fs;
  }

  beforeEach(() => {
    asked = [];
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-task-shell-')));
    writeFileSync(join(workspace, 'a.md'), 'one\n');
    worktree = join(workspace, '.ordewell', 'worktrees', 'run', '1-review');
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('runs what would ask or be refused sealed, from its worktree, which is writable there, and asks nobody', async () => {
    const fs = session();
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const tests = await shell.run('npm test');
    const write = await shell.run('echo draft > notes.txt');
    const loop = await shell.run('for f in *.md; do wc -l "$f"; done');

    expect(asked).toEqual([]);
    expect(fs.ran.map(({ command, cwd, sealed }) => ({ command, cwd, sealed }))).toEqual([
      { command: 'npm test', cwd: worktree, sealed: true },
      { command: 'echo draft > notes.txt', cwd: worktree, sealed: true },
      { command: 'for f in *.md; do wc -l "$f"; done', cwd: worktree, sealed: true },
    ]);
    const profile = fs.ran[0].profile!;
    expect(profile.write).toContain(worktree);
    expect(profile.read).toContain(workspace);
    expect(profile.network).toBe(false);
    for (const outcome of [tests, write, loop]) {
      expect(ranSealed(outcome.output)).toBe(true);
      expect(outcome.output).toContain("This task's worktree is writable and is thrown away when the task ends.");
      expect(outcome.output).toContain('git can read the repository but not record anything in it');
    }
  });

  it("protects each worktree's .git in its sealed profile: the one writable worktree, or every repo's in a group (ADR-0046)", async () => {
    const lone = session();
    await lone.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    expect(lone.ran[0].profile!.gitWorktrees).toEqual([worktree]);

    const group = session();
    const alpha = join(worktree, 'alpha');
    const beta = join(worktree, 'beta');
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    await group.taskShell({ cwd: alpha, writable: worktree, worktrees: [alpha, beta] }).run('npm test');
    expect(group.ran[0].profile!.gitWorktrees).toEqual([alpha, beta]);
  });

  it("protects every .git entry the checkout brought, not only a worktree root (ADR-0046)", async () => {
    mkdirSync(join(worktree, 'vendor', '.git'), { recursive: true });
    writeFileSync(join(worktree, 'vendor', '.git', 'config'), '');
    mkdirSync(join(worktree, 'sub'));
    writeFileSync(join(worktree, 'sub', '.git'), 'gitdir: /repo/.git/modules/sub\n');
    const fs = session();

    await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');

    expect(fs.ran[0].profile!.gitEntries).toEqual(expect.arrayContaining([
      { path: join(worktree, 'vendor', '.git'), directory: true },
      { path: join(worktree, 'sub', '.git'), directory: false },
    ]));
  });

  it("gives its sealed runs a task-sized time limit, not the planner's short one (ADR-0046)", async () => {
    const fs = session();
    await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    await fs.bash('for f in *.md; do wc -l "$f"; done');

    expect(fs.ran[0].profile!.limits!.wallTimeMs).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
    expect(fs.ran[1].profile!.limits!.wallTimeMs).toBe(SEALED_LIMITS.wallTimeMs);
  });

  it('says the time limit ran out, rather than blaming reach, when a sealed run was ended at it', async () => {
    const fs = session();
    fs.result = { success: false, output: 'Command exited 1:\nexited with code 1', truncated: false, timedOut: true };

    const tests = await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    const loop = await fs.bash('for f in *.md; do wc -l "$f"; done');

    expect(tests.output).toContain('ended at its time limit of 10 minutes');
    expect(tests.output).toContain('Run less at a time');
    expect(tests.output).not.toContain('cannot reach the network');
    expect(loop.output).toContain('ended at its time limit of 1 minute');
    expect(loop.output).toContain('belongs in the plan as a task');
  });

  it('says the memory limit ended it, rather than blaming reach, when a sealed run was ended at it', async () => {
    const fs = session();
    fs.result = { success: false, output: 'Command exited 1:\n', truncated: false, signal: 'SIGUSR2' };

    const tests = await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    const loop = await fs.bash('for f in *.md; do wc -l "$f"; done');

    expect(tests.output).toContain('ended at its memory limit of 4 GiB');
    expect(tests.output).toContain('Run less at a time');
    expect(tests.output).not.toContain('cannot reach the network');
    expect(loop.output).toContain('ended at its memory limit of 4 GiB');
    expect(loop.output).toContain('belongs in the plan as a task');
  });

  it('runs what the classifier reads as read-only as the planner would, from the worktree, without the network', async () => {
    const fs = session();
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    await shell.run('git status');

    expect(fs.ran).toHaveLength(1);
    expect(fs.ran[0]).toMatchObject({ command: 'git status', cwd: worktree, sealed: false });
    // The planner's profile: nothing of the worktree writable, nothing approved, so no network.
    expect(fs.ran[0].profile).toMatchObject({ read: 'host', network: false });
    expect(fs.ran[0].profile!.write).not.toContain(worktree);
  });

  it('confines paths to its worktree: a read of the main checkout runs sealed, where the workspace is readable', async () => {
    const fs = session();
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    await shell.run(`cat ${join(workspace, 'a.md')}`);

    expect(asked).toEqual([]);
    expect(fs.ran[0]).toMatchObject({ sealed: true, cwd: worktree });
  });

  it("runs what the user's allowlist covers as the planner's command would, with the network the allowlist grants", async () => {
    const fs = session(new RecordingBackend(), guarded({ preApproved: ['gh issue list'] }));

    const outcome = await fs.taskShell({ cwd: worktree, writable: worktree }).run('gh issue list');

    expect(asked).toEqual([]);
    expect(fs.ran[0]).toMatchObject({ command: 'gh issue list', sealed: false });
    expect(fs.ran[0].profile?.network).toBe(true);
    expect(ranSealed(outcome.output)).toBe(false);
  });

  describe('once a sealed run has started, every later command of the attempt runs sealed', () => {
    /** Each command as it ran: sealed or not, and with the network or not. */
    const how = (fs: WorkspaceFileSystem) => fs.ran.map(({ command, sealed, profile }) => ({ command, sealed, network: profile?.network }));

    it('an allowlisted command keeps the network until then, and loses it after', async () => {
      const fs = session(new RecordingBackend(), guarded({ preApproved: ['gh issue list'] }));
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });

      await shell.run('gh issue list');
      await shell.run('echo draft > notes.txt');
      const after = await shell.run('gh issue list');

      expect(asked).toEqual([]);
      expect(how(fs)).toEqual([
        { command: 'gh issue list', sealed: false, network: true },
        { command: 'echo draft > notes.txt', sealed: true, network: false },
        { command: 'gh issue list', sealed: true, network: false },
      ]);
      expect(ranSealed(after.output)).toBe(true);
    });

    it("so does a command the classifier reads as read-only, with or without a worktree, and a continue's fresh shell starts unsealed", async () => {
      const fs = session();
      for (const site of [{ cwd: worktree, writable: worktree }, { cwd: workspace }]) {
        const shell = fs.taskShell(site);
        await shell.run('git status');
        await shell.run('npm test');
        await shell.run('git status');
      }

      expect(asked).toEqual([]);
      const run = [
        { command: 'git status', sealed: false, network: false },
        { command: 'npm test', sealed: true, network: false },
        { command: 'git status', sealed: true, network: false },
      ];
      expect(how(fs)).toEqual([...run, ...run]);
    });

    it('holds after a sealed run that failed, timed out or was aborted, which may still have written', async () => {
      const ends: Array<{ result?: ToolOutcome; abort?: boolean }> = [
        { result: { success: false, output: 'Command exited 1:\nfailed', truncated: false } },
        { result: { success: false, output: 'Command exited 1:\n', truncated: false, timedOut: true } },
        { abort: true },
      ];
      for (const end of ends) {
        const fs = session(new RecordingBackend(), guarded({ preApproved: ['gh issue list'] }));
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        const stop = new AbortController();
        fs.result = end.result;
        fs.effect = () => { if (end.abort) stop.abort(); };

        await shell.run('npm test', stop.signal);
        fs.result = undefined;
        fs.effect = undefined;
        await shell.run('gh issue list');

        expect(how(fs)).toEqual([
          { command: 'npm test', sealed: true, network: false },
          { command: 'gh issue list', sealed: true, network: false },
        ]);
      }
    });

    it('still refuses what an exclusion names and what the user denied on the card, wrapped or not (ADR-0036 S3)', async () => {
      const fs = session(new RecordingBackend(), guarded({ preApproved: ['!kubectl *secret*', '!cat *secret*', 'gh issue list'] }));
      await fs.bash('npm test');
      expect(asked).toEqual(['npm test']);
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });
      await shell.run('echo draft > notes.txt');

      const excluded = await shell.run('kubectl get secrets');
      const excludedRead = await shell.run('cat secret.txt');
      const denied = await shell.run('npm test');
      const wrapped = await shell.run('for i in 1 2; do npm test; done');

      expect(excluded.output).toContain('the planner allowlist excludes it ("!kubectl *secret*")');
      expect(excludedRead.output).toContain('the planner allowlist excludes it ("!cat *secret*")');
      expect(denied.output).toContain('The user denied it this session');
      expect(wrapped.output).toContain('The user denied "npm test" this session');
      expect(fs.ran.map((r) => r.command)).toEqual(['echo draft > notes.txt']);
      expect(asked).toEqual(['npm test']);
    });

    it('is explained once, in the header of the run that started it, and named in every later one', async () => {
      const fs = session(new RecordingBackend(), guarded({ preApproved: ['gh issue list'] }));
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });
      const scratchOnly = fs.taskShell({ cwd: workspace });

      const first = await shell.run('npm test');
      const later = [await shell.run('gh issue list'), await shell.run('for f in *.md; do wc -l "$f"; done')];
      const firstWithout = await scratchOnly.run('npm test');

      const header = (outcome: ToolOutcome) => outcome.output.split('\n')[0];
      expect(header(first)).toMatch(/^\[Ran sealed instead of being refused: .*\]$/);
      expect(header(first)).toContain("It may have written this task's worktree, so every later command of this task runs sealed too, without the network.");
      expect(header(firstWithout)).toContain("It may have written this task's scratch directory, so every later command of this task runs sealed too, without the network.");
      for (const outcome of later) {
        expect(header(outcome)).toMatch(/^\[Ran sealed, as every command of this task is after its first sealed run: no network and no home directory\. .*\]$/);
        expect(header(outcome)).not.toContain('may have written');
      }
    });

    it('never happens where no sandbox can seal, since no sealed run ever started', async () => {
      const fs = session(null, guarded({ preApproved: ['gh issue list'] }));
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });

      const tests = await shell.run('npm test');
      const loop = await shell.run('for f in *.md; do wc -l "$f"; done');
      await shell.run('gh issue list');
      await shell.run('git status');

      expect(tests.output).toContain('this machine has no sandbox to seal it in');
      expect(loop.output).toContain('this machine has no sandbox to seal it in');
      expect(fs.ran).toEqual([
        { command: 'gh issue list', cwd: worktree, sealed: false },
        { command: 'git status', cwd: worktree, sealed: false },
      ]);
    });

    it("leaves the planner's own shell as it was, its sealed runs included", async () => {
      const fs = session(new RecordingBackend(), guarded({ preApproved: ['gh issue list'] }));
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });
      await shell.run('npm test');

      await fs.bash('gh issue list');
      await fs.bash('for f in *.md; do wc -l "$f"; done');
      await fs.bash('git status');
      const plannerSealed = await fs.bash('for f in *.md; do wc -l "$f"; done');
      await fs.bash('gh issue list');

      expect(how(fs).slice(1)).toEqual([
        { command: 'gh issue list', sealed: false, network: true },
        { command: 'for f in *.md; do wc -l "$f"; done', sealed: true, network: false },
        { command: 'git status', sealed: false, network: false },
        { command: 'for f in *.md; do wc -l "$f"; done', sealed: true, network: false },
        { command: 'gh issue list', sealed: false, network: true },
      ]);
      expect(fs.ran.slice(1).every((r) => r.cwd === workspace)).toBe(true);
      expect(plannerSealed.output).toMatch(/^\[Ran sealed instead of being refused: no network, no home directory, and nothing it writes reaches the workspace\./);
    });
  });

  it('runs sealed what the user let the planner run on the card: that grant was the planner\'s', async () => {
    const fs = session(new RecordingBackend(), guarded({ yes: ['npm ls --all'] }));
    await fs.bash('npm ls --all');
    expect(fs.ran[0]).toMatchObject({ sealed: false, cwd: workspace });

    await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm ls --all');

    expect(asked).toEqual(['npm ls --all']);
    expect(fs.ran[1]).toMatchObject({ sealed: true, cwd: worktree });
  });

  it('refuses what an allowlist exclusion names and what the user denied on the card, sealed or not (ADR-0036 S3)', async () => {
    const fs = session(new RecordingBackend(), guarded({ preApproved: ['!kubectl *secret*'] }));
    await fs.bash('npm test');
    expect(asked).toEqual(['npm test']);
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const excluded = await shell.run('kubectl get secrets');
    const denied = await shell.run('npm test');
    const wrapped = await shell.run('for i in 1 2; do npm test; done');

    expect(excluded.output).toContain('the planner allowlist excludes it ("!kubectl *secret*")');
    expect(denied.output).toContain('The user denied it this session');
    expect(wrapped.output).toContain('The user denied "npm test" this session');
    expect(fs.ran).toEqual([]);
    expect(asked).toEqual(['npm test']);
  });

  it('without a worktree of its own, runs sealed with the workspace read-only and nothing writable but scratch', async () => {
    const fs = session();

    const outcome = await fs.taskShell({ cwd: workspace }).run('npm test');

    expect(fs.ran[0]).toMatchObject({ sealed: true, cwd: workspace });
    expect(fs.ran[0].profile!.write).toHaveLength(1);
    expect(fs.ran[0].profile!.write[0]).not.toContain(workspace);
    expect(outcome.output).toContain('The workspace is read-only: this task has no worktree of its own.');
  });

  it('has a scratch directory of its own, which goes when the attempt ends', async () => {
    const fs = session();
    await fs.bash('git status');
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });
    await shell.run('npm test');

    const plannerScratch = fs.ran[0].profile!.env.TMPDIR;
    const taskScratch = fs.ran[1].profile!.env.TMPDIR;
    expect(taskScratch).toBeDefined();
    expect(taskScratch).not.toBe(plannerScratch);
    expect(existsSync(taskScratch)).toBe(true);

    shell.end();

    expect(existsSync(taskScratch)).toBe(false);
    expect(existsSync(plannerScratch)).toBe(true);
    fs.endSession();
  });

  it('removes a link a sealed run left leading out of the worktree and the workspace, and says so', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-task-shell-outside-')));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside\n');
      mkdirSync(join(worktree, 'src'));
      const fs = session();
      fs.effect = ({ command, sealed }) => {
        if (!sealed || !command.startsWith('ln ')) return;
        symlinkSync(outside, join(worktree, 'leak'));
        symlinkSync(join(outside, 'secret.txt'), join(worktree, 'src', 'deep'));
        symlinkSync(join(outside, 'missing'), join(worktree, 'dangling'));
        symlinkSync('../a.md', join(worktree, 'src', 'local'));
        symlinkSync(join(workspace, 'a.md'), join(worktree, 'workspace-file'));
      };
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });

      const linked = await shell.run(`ln -s '${outside}' leak`);
      await shell.run('cat leak/secret.txt');

      expect(fs.ran.map((r) => r.sealed)).toEqual([true, true]);
      expect(linked.output).toContain('may leave no link leading out of its worktree');
      for (const gone of ['leak', 'src/deep', 'dangling']) {
        expect(linked.output).toContain(gone);
        expect(() => lstatSync(join(worktree, gone))).toThrow();
      }
      expect(lstatSync(join(worktree, 'src', 'local')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(worktree, 'workspace-file')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes a link out hidden in a directory a sealed run left unreadable', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-task-shell-outside-')));
    const hidden = join(worktree, 'hide');
    try {
      const fs = session();
      fs.effect = ({ sealed }) => {
        if (!sealed) return;
        mkdirSync(join(hidden, 'deeper'), { recursive: true });
        symlinkSync(outside, join(hidden, 'key'));
        symlinkSync(outside, join(hidden, 'deeper', 'key'));
        mkdirSync(join(worktree, 'kept'));
        symlinkSync(outside, join(worktree, 'kept', 'key'));
        // Listed but not written, traversed but not listed, then neither: a walk that gives up where it is refused leaves every link.
        chmodSync(join(worktree, 'kept'), 0o555);
        chmodSync(join(hidden, 'deeper'), 0o000);
        chmodSync(hidden, 0o111);
      };
      const linked = await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');

      expect(linked.output).toContain('may leave no link leading out of its worktree');
      for (const gone of ['hide/key', 'hide/deeper/key', 'kept/key']) {
        expect(linked.output).toContain(gone);
        expect(() => lstatSync(join(worktree, gone))).toThrow();
      }
    } finally {
      for (const dir of [join(worktree, 'kept'), hidden, join(hidden, 'deeper')]) if (existsSync(dir)) chmodSync(dir, 0o700);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("removes a .git a sealed run left at a repo group's task workspace, where the runner's own git starts, and says so", async () => {
    const alpha = join(worktree, 'alpha');
    mkdirSync(alpha);
    writeFileSync(join(alpha, '.git'), 'gitdir: /repo/.git/worktrees/alpha\n');
    const fs = session();
    fs.effect = ({ sealed }) => {
      if (!sealed) return;
      mkdirSync(join(worktree, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(worktree, '.git', 'config'), '[core]\n\tfsmonitor = ./evil.sh\n');
    };
    const planted = await fs.taskShell({ cwd: worktree, writable: worktree, worktrees: [alpha] }).run('git init --bare .git');

    expect(existsSync(join(worktree, '.git'))).toBe(false);
    expect(planted.output).toContain('may leave no .git');
    // A worktree's own `.git` is the repository's, not one the run planted.
    expect(existsSync(join(alpha, '.git'))).toBe(true);

    const lone = session();
    writeFileSync(join(worktree, '.git'), 'gitdir: /repo/.git/worktrees/1-review\n');
    lone.effect = () => undefined;
    await lone.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    expect(existsSync(join(worktree, '.git'))).toBe(true);
  });

  it('removes a .git a sealed run planted in a subfolder, and says so, while a repository that was there before stays', async () => {
    mkdirSync(join(worktree, 'vendor', 'lib'), { recursive: true });
    writeFileSync(join(worktree, 'vendor', 'lib', '.git'), 'gitdir: /repo/.git/modules/lib\n');
    mkdirSync(join(worktree, 'vendor', 'tool', '.git'), { recursive: true });
    writeFileSync(join(worktree, 'vendor', 'tool', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const fs = session();
    fs.effect = ({ sealed }) => {
      if (!sealed) return;
      mkdirSync(join(worktree, 'sub', '.git', 'hooks'), { recursive: true });
      writeFileSync(join(worktree, 'sub', '.git', 'config'), '[core]\n\tfsmonitor = ./evil.sh\n');
    };
    const planted = await fs.taskShell({ cwd: worktree, writable: worktree }).run('git init sub');

    expect(planted.output).toContain('may leave no .git');
    expect(planted.output).toContain('sub/.git');
    expect(existsSync(join(worktree, 'sub', '.git'))).toBe(false);
    // A submodule's `.git` file and a vendored repository were the checkout's, not the run's.
    expect(readFileSync(join(worktree, 'vendor', 'lib', '.git'), 'utf8')).toBe('gitdir: /repo/.git/modules/lib\n');
    expect(readFileSync(join(worktree, 'vendor', 'tool', '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
  });

  describe('a .git entry the checkout brought is checked after every sealed run', () => {
    /** A vendored repository, and a submodule's `.git` file, as the checkout leaves them. */
    function checkoutGit(): void {
      mkdirSync(join(worktree, 'vendor', '.git', 'hooks'), { recursive: true });
      writeFileSync(join(worktree, 'vendor', '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
      writeFileSync(join(worktree, 'vendor', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
      mkdirSync(join(worktree, 'sub'), { recursive: true });
      writeFileSync(join(worktree, 'sub', '.git'), 'gitdir: /repo/.git/modules/sub\n');
    }

    /** The first command's result names the change; the next one never runs. */
    async function stopsAfter(mutate: () => void, changed: string): Promise<void> {
      checkoutGit();
      const fs = session();
      fs.effect = ({ sealed }) => { if (sealed) mutate(); };
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });

      const first = await shell.run('npm test');
      expect(first.output).toContain("A .git entry this task's checkout brought changed during a sealed run");
      expect(first.output).toContain(changed);

      const next = await shell.run('git status');
      expect(next.success).toBe(false);
      expect(next.output).toContain(`a .git entry the checkout brought changed during a sealed run (${changed})`);
      expect(next.output).toContain("this task's shell is stopped");
      expect(fs.ran.map((r) => r.command)).toEqual(['npm test']);
    }

    it('stops the task shell when a vendored .git config changed', async () => {
      await stopsAfter(() => writeFileSync(join(worktree, 'vendor', '.git', 'config'), '[core]\n\tfsmonitor = ./evil.sh\n'), 'vendor/.git');
    });

    it("stops the task shell when a vendored .git's hooks changed", async () => {
      await stopsAfter(() => {
        mkdirSync(join(worktree, 'vendor', '.git', 'hooks', 'extra'));
      }, 'vendor/.git');
    });

    it("stops the task shell when a submodule's .git file changed", async () => {
      await stopsAfter(() => writeFileSync(join(worktree, 'sub', '.git'), 'gitdir: fake\n'), 'sub/.git');
    });

    it('stops the task shell when an entry is replaced at the same path by another kind', async () => {
      await stopsAfter(() => {
        const dir = join(worktree, 'vendor', '.git');
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(dir, 'gitdir: fake\n');
      }, 'vendor/.git');
    });
  });

  it('stops the task shell when a .git a sealed run planted cannot be removed', async () => {
    const fs = session();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const sub = join(worktree, 'sub');
      // A non-empty directory where the sweep renames the .git aside, so even
      // a retry after giving the directory back its write cannot move it.
      const aside = join(sub, `.removed-git-${process.pid}-${now}`);
      fs.effect = ({ sealed }) => {
        if (!sealed) return;
        mkdirSync(join(sub, '.git'), { recursive: true });
        mkdirSync(aside, { recursive: true });
        writeFileSync(join(aside, 'keep'), 'x');
      };
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });

      const planted = await shell.run('git init sub');
      expect(planted.output).toContain('sub/.git');

      const next = await shell.run('git status');
      expect(next.success).toBe(false);
      expect(next.output).toContain('a repository a sealed run planted could not be removed (sub/.git)');
      expect(next.output).toContain("this task's shell is stopped");
      // The refused command never ran, and the `.git` is still where git would find it.
      expect(fs.ran.map((r) => r.command)).toEqual(['git init sub']);
    } finally {
      clock.mockRestore();
    }
  });

  it('runs one command at a time, so none reads the worktree while a sealed run still writes it', async () => {
    const fs = session();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    fs.effect = ({ sealed }) => (sealed ? held : undefined);
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const writing = shell.run('npm test');
    const reading = shell.run('cat a.md');
    // The first command's snapshot of the `.git` entries runs before it does.
    await vi.waitFor(() => expect(fs.ran.map((r) => r.command)).toEqual(['npm test']));
    expect(fs.ran.map((r) => r.command)).toEqual(['npm test']);

    release();
    await Promise.all([writing, reading]);
    expect(fs.ran.map((r) => r.command)).toEqual(['npm test', 'cat a.md']);
  });

  describe("Ordewell's own scripts, while the shell is held for them (ADR-0050)", () => {
    it('runs each sealed from the worktree root, judged by no command rule and with nobody asked, under the task\'s sealed profile', async () => {
      const fs = session(new RecordingBackend(), guarded({ preApproved: ['!git add *'] }));
      const shell = fs.taskShell({ cwd: join(worktree, 'pkg'), writable: worktree });
      await shell.run('npm test');
      expect((await shell.run('git add -A')).output).toContain('the planner allowlist excludes it');

      const outcome = await shell.hold!(async (own) => {
        expect(own).toMatchObject({ worktrees: [worktree], touched: true });
        expect(own.scratch).toBe(fs.ran[0].profile!.env.TMPDIR);
        return own.run('git add -A', worktree);
      });

      expect(outcome).toEqual({ success: true, output: 'ran', truncated: false });
      expect(fs.ran.map((r) => r.command)).toEqual(['npm test', 'git add -A']);
      expect(fs.ran.at(-1)).toMatchObject({ command: 'git add -A', cwd: worktree, sealed: true, profile: { write: expect.arrayContaining([worktree]), network: false, gitWorktrees: [worktree] } });
      expect(asked).toEqual([]);
    });

    it('tells it whether a sealed run has started, before which the worktree is as Ordewell checked it out', async () => {
      const shell = session().taskShell({ cwd: worktree, writable: worktree });
      expect(await shell.hold!(async (own) => own.touched)).toBe(false);
      await shell.run('npm test');
      expect(await shell.hold!(async (own) => own.touched)).toBe(true);
    });

    it('runs no command of the task until the work settles', async () => {
      const fs = session();
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });
      let release!: () => void;
      const held = shell.hold!(async (own) => {
        await own.run('stage', worktree);
        await new Promise<void>((resolve) => { release = resolve; });
        return own.run('export', worktree);
      });
      const command = shell.run('cat a.md');
      await vi.waitFor(() => expect(fs.ran.map((r) => r.command)).toEqual(['stage']));

      release();
      await Promise.all([held, command]);
      expect(fs.ran.map((r) => r.command)).toEqual(['stage', 'export', 'cat a.md']);
    });

    it('refuses a directory that is not a worktree of the task, a shell that is stopped, and a host with no sandbox', async () => {
      const elsewhere = session().taskShell({ cwd: worktree, writable: worktree });
      expect(await elsewhere.hold!((own) => own.run('git add -A', workspace))).toMatchObject({ success: false, output: expect.stringContaining('is not a worktree of this task') });

      const none = session(null);
      expect(await none.taskShell({ cwd: worktree, writable: worktree }).hold!((own) => own.run('git add -A', worktree)))
        .toMatchObject({ success: false, output: "Not run: this machine has no sandbox to seal it in, and Ordewell runs nothing in a read-only task's worktree outside one." });
      expect(none.ran).toEqual([]);

      mkdirSync(join(worktree, 'sub'), { recursive: true });
      writeFileSync(join(worktree, 'sub', '.git'), 'gitdir: /repo/.git/modules/sub\n');
      const fs = session();
      fs.effect = ({ sealed }) => { if (sealed) writeFileSync(join(worktree, 'sub', '.git'), 'gitdir: fake\n'); };
      const stopped = fs.taskShell({ cwd: worktree, writable: worktree });
      const own = await stopped.hold!((runs) => runs.run('git add -A', worktree));
      expect(own).toMatchObject({ success: false, output: expect.stringContaining("A .git entry this task's checkout brought changed") });
      expect(await stopped.hold!((runs) => runs.run('git add -A', worktree))).toMatchObject({ success: false, output: expect.stringContaining("this task's shell is stopped") });
      expect(fs.ran.map((r) => r.command)).toEqual(['git add -A']);
    });
  });

  it('asks the sandbox to refuse links in its worktree where it can, and only there (macOS)', async () => {
    const backend = new RecordingBackend();
    const fs = session(backend);
    await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    await fs.taskShell({ cwd: workspace }).run('npm test');
    await fs.bash('for f in *.md; do wc -l "$f"; done');

    const sealedProfiles = fs.ran.filter((r) => r.sealed).map((r) => r.profile);
    expect(sealedProfiles.map((p) => p?.linkless)).toEqual([[worktree], undefined, undefined]);
  });

  it('where no sandbox runs, runs what the classifier reads as read-only and refuses the rest, asking nobody', async () => {
    const fs = session(null);
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const status = await shell.run('git status');
    const tests = await shell.run('npm test');
    const loop = await shell.run('for f in *.md; do wc -l "$f"; done');
    const outside = await shell.run(`cat ${join(workspace, 'a.md')}`);

    expect(status.success).toBe(true);
    expect(fs.ran).toEqual([{ command: 'git status', cwd: worktree, sealed: false }]);
    expect(tests.output).toMatch(/^Command not run: npm test\nA read-only task asks nobody, so this command could only run sealed, and this machine has no sandbox to seal it in\./);
    expect(loop.output).toMatch(/^Command refused: /);
    expect(loop.output).toContain('this machine has no sandbox to seal it in');
    expect(outside.output).toContain('this machine has no sandbox to seal it in');
    expect(asked).toEqual([]);
  });
});
