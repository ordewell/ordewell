import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlannerShellSandbox, resolvePlannerSandbox } from '../sandbox/plannerSandbox';
import { BaseFileSystem } from '../BaseFileSystem';
import { capturePatch, type PatchCaptureResult } from '../PatchCapture';
import { ranSealed } from '../researchStepSummary';
import type { ShellLaunch } from '../researchShell';
import type { TaskShell, ToolOutcome } from '../../interfaces/IFileSystem';

/**
 * A read-only task's prototype saved as a patch (ADR-0050), end to end: real
 * git, and the capture run through a real task shell in this host's sandbox
 * (Seatbelt on macOS, bubblewrap on Linux). The patch is then applied, outside
 * any sandbox, in a fresh worktree at the same base. Where no sealed run can
 * start the file skips, and its title says why; CI's sandbox job sets
 * ORDEWELL_REQUIRE_SANDBOX so a skip there fails instead.
 */

/** The task shell as the adapters run it, against a real workspace. */
class HostFileSystem extends BaseFileSystem {
  /** Every launch: sealed when it carries a sealed run's time limit. */
  readonly launches: Array<{ sealed: boolean; cwd: string }> = [];

  constructor(private readonly root: string, sandbox: PlannerShellSandbox) {
    super(undefined, sandbox);
  }

  getWorkspaceRoot(): string { return this.root; }
  protected async readFileImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async listDirImpl(): Promise<ToolOutcome> { throw new Error('not used'); }

  protected execBashImpl(command: string, shell: ShellLaunch, _signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome> {
    this.launches.push({ sealed: shell.wallTimeMs !== undefined, cwd });
    return new Promise((resolve) => {
      execFile(shell.file ?? '/bin/sh', [...shell.args, command], {
        cwd, env: shell.env, timeout: shell.wallTimeMs ?? 60_000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        resolve({ success: !err, output: `${stdout}${stderr}`, truncated: false });
      });
    });
  }
}

const REQUIRE_SANDBOX = process.env.ORDEWELL_REQUIRE_SANDBOX === '1';

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

describe('a patch saved from a read-only task', async () => {
  const availability = await resolvePlannerSandbox();
  const reason = !availability.available ? availability.notice : !availability.sealed.available ? availability.sealed.notice : undefined;
  // Named in the title, so a CI log shows which workspace mount the run exercised.
  const overlayMode = availability.available && availability.sealed.available
    && (availability.sealed.profile({ workspace: tmpdir() }).throwaway?.length ?? 0) > 0;
  const title = !reason && availability.available
    ? `sealed on this host (${availability.backend.name}, ${overlayMode ? 'throwaway overlay' : 'read-only workspace'})`
    : `${REQUIRE_SANDBOX ? 'required' : 'skipped'}: ${(reason ?? '').split('\n')[0]}`;

  describe.skipIf(reason !== undefined && !REQUIRE_SANDBOX)(title, () => {
    if (reason !== undefined) {
      it('has a sealed run on this host (ORDEWELL_REQUIRE_SANDBOX=1)', () => {
        throw new Error(reason);
      });
      return;
    }

    let repo: string;
    let elsewhere: string;
    let base: string;
    let worktrees = 0;
    const sandbox = new PlannerShellSandbox();

    beforeAll(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-e2e-')));
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-e2e-elsewhere-')));
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 't@t');
      git(repo, 'config', 'user.name', 't');
      mkdirSync(join(repo, 'src'));
      mkdirSync(join(repo, 'config'));
      writeFileSync(join(repo, 'README.md'), '# repo\n\none\ntwo\n');
      writeFileSync(join(repo, 'CONTRIBUTING.md'), 'contribute\n');
      writeFileSync(join(repo, 'LICENSE'), 'licensed\n');
      writeFileSync(join(repo, 'del.txt'), 'to be deleted\n');
      writeFileSync(join(repo, 'src', 'old.ts'), 'export const old = 1;\nexport const kept = 2;\n');
      writeFileSync(join(repo, 'config', 'settings.json'), '{}\n');
      writeFileSync(join(repo, 'logo.bin'), Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256)));
      // Ignored here, as most repositories ignore their own: the worktree's link to it must stay out by name.
      writeFileSync(join(repo, '.gitignore'), '.ordewell/\n.env\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'base');
      base = git(repo, 'rev-parse', 'HEAD').trim();
      // What the main checkout holds untracked, which Ordewell links into each worktree.
      writeFileSync(join(repo, '.env'), 'SECRET=1\n');
      writeFileSync(join(repo, '.env.development'), 'TOKEN=dev\n');
      writeFileSync(join(repo, 'config', 'local.json'), '{"local":true}\n');
      writeFileSync(join(elsewhere, 'secret.txt'), 'elsewhere\n');
    });

    afterAll(() => {
      sandbox.end();
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    });

    /** A task's worktree at the base, with the links Ordewell bootstraps into one, and its shell. */
    function explorer(): { worktree: string; shell: TaskShell; linked: string[]; fs: HostFileSystem } {
      worktrees += 1;
      const worktree = join(repo, '.ordewell', 'worktrees', 'run', `${worktrees}-explore`);
      git(repo, 'worktree', 'add', '-q', '-b', `ordewell/run/${worktrees}-explore`, worktree, base);
      // `.env*` files and a user's `worktreeLinks` path, linked live as bootstrap does on POSIX.
      symlinkSync(join(repo, '.env'), join(worktree, '.env'));
      symlinkSync(join(repo, '.env.development'), join(worktree, '.env.development'));
      symlinkSync(join(repo, 'config', 'local.json'), join(worktree, 'config', 'local.json'));
      const fs = new HostFileSystem(repo, sandbox);
      return { worktree, fs, shell: fs.taskShell({ cwd: worktree, writable: worktree }), linked: ['.env', '.env.development', 'config/local.json'] };
    }

    /** What the task does to its worktree, through its own shell: sealed, as every write of a read-only task is. */
    async function change(shell: TaskShell, script: string): Promise<void> {
      const ran = await shell.run(script);
      expect(ran.success, ran.output).toBe(true);
      expect(ranSealed(ran.output)).toBe(true);
    }

    function saved(result: PatchCaptureResult) {
      if (result.kind !== 'saved') throw new Error(`not saved: ${result.reason}`);
      return result;
    }

    /** The patch applied outside any sandbox in a fresh worktree at the base, as a later task would. */
    function replay(patch: Buffer): string {
      worktrees += 1;
      const at = join(repo, '.ordewell', 'worktrees', 'run', `${worktrees}-replay`);
      git(repo, 'worktree', 'add', '-q', '--detach', at, base);
      const file = join(tmpdir(), `ordewell-patch-e2e-${process.pid}-${worktrees}.patch`);
      writeFileSync(file, patch);
      try {
        git(at, 'apply', '--index', '--whitespace=nowarn', file);
      } finally {
        rmSync(file, { force: true });
      }
      return at;
    }

    const executable = (file: string) => (statSync(file).mode & 0o111) !== 0;

    it('captures modified, new, deleted, renamed, binary and mode-only changes, sealed, writing nothing to the repository, and replays them identically', async () => {
      const { worktree, shell, linked, fs } = explorer();
      try {
        await change(shell, [
          'printf "three\\n" >> README.md',
          'printf "export const added = 1;\\n" > src/new.ts',
          'rm del.txt',
          'mv src/old.ts src/renamed.ts',
          'head -c 4096 /dev/urandom > logo.bin',
          // Git calls a file binary for a NUL, which 1024 random bytes lack about one time in fifty.
          'mkdir assets && { printf "\\000"; head -c 1023 /dev/urandom; } > assets/new.bin',
          'chmod +x LICENSE',
        ].join(' && '));
        // A link leading out of the worktree that is not Ordewell's; the sealed profile refuses to make one, so it is made from here.
        symlinkSync(elsewhere, join(worktree, 'outside'));
        const objects = git(repo, 'count-objects', '-v');
        const index = readFileSync(git(worktree, 'rev-parse', '--git-dir').trim() + '/index');

        const launched = fs.launches.length;
        const result = saved(await capturePatch(shell, { linked }));

        expect(fs.launches.slice(launched)).toEqual([{ sealed: true, cwd: worktree }, { sealed: true, cwd: worktree }]);
        expect(git(repo, 'count-objects', '-v')).toBe(objects);
        expect(readFileSync(git(worktree, 'rev-parse', '--git-dir').trim() + '/index').equals(index)).toBe(true);
        expect(result.stats).toMatchObject({ base, files: 7, binary: 2, flags: [{ kind: 'excluded', count: 1, paths: ['outside'] }] });
        const text = result.patch.toString('utf8');
        expect(text).toContain('diff --git a/README.md b/README.md');
        expect(text).toContain('diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644');
        expect(text).toContain('diff --git a/del.txt b/del.txt\ndeleted file mode 100644');
        expect(text).toContain('rename from src/old.ts\nrename to src/renamed.ts');
        expect(text).toContain('diff --git a/LICENSE b/LICENSE\nold mode 100644\nnew mode 100755');
        expect(text.match(/GIT binary patch/g)).toHaveLength(2);
        for (const out of ['.env', 'local.json', 'outside', '120000']) expect(text).not.toContain(out);

        const applied = replay(result.patch);
        for (const file of ['README.md', 'src/new.ts', 'src/renamed.ts', 'logo.bin', 'assets/new.bin', 'LICENSE', 'CONTRIBUTING.md']) {
          expect(readFileSync(join(applied, file)).equals(readFileSync(join(worktree, file))), file).toBe(true);
          expect(executable(join(applied, file)), file).toBe(executable(join(worktree, file)));
        }
        expect(existsSync(join(applied, 'del.txt'))).toBe(false);
        expect(existsSync(join(applied, 'src', 'old.ts'))).toBe(false);
        expect(existsSync(join(applied, 'outside'))).toBe(false);
        expect(git(applied, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort()).toEqual([
          'A  assets/new.bin', 'A  src/new.ts', 'D  del.txt', 'M  LICENSE', 'M  README.md', 'M  logo.bin', 'R  src/old.ts -> src/renamed.ts',
        ]);
      } finally {
        shell.end();
      }
    });

    it('refuses a case-only rename, which a case-insensitive file system cannot apply', async () => {
      const { shell, linked } = explorer();
      try {
        await change(shell, 'mv CONTRIBUTING.md contributing.md');

        expect(await capturePatch(shell, { linked })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('"CONTRIBUTING.md" and "contributing.md" differ only in case') });
      } finally {
        shell.end();
      }
    });

    it("keeps out an .env.development link and a user's worktreeLinks path, by the names Ordewell linked, without flagging them", async () => {
      const { shell, linked } = explorer();
      try {
        await change(shell, 'printf "one more\\n" >> README.md');

        const result = saved(await capturePatch(shell, { linked }));

        expect(result.stats).toMatchObject({ files: 1, added: 1, removed: 0, flags: [] });
        const text = result.patch.toString('utf8');
        expect(text).not.toContain('.env');
        expect(text).not.toContain('config/local.json');
      } finally {
        shell.end();
      }
    });

    it('saves nothing, and starts no sealed run, before the task has run one', async () => {
      const { worktree, shell, linked, fs } = explorer();
      try {
        writeFileSync(join(worktree, 'README.md'), 'not the task\'s doing\n');
        expect(await capturePatch(shell, { linked })).toMatchObject({ kind: 'empty', reason: expect.stringContaining('no command of this task has run sealed') });
        expect(fs.launches).toEqual([]);
        // Still unsealed: a read-only command runs as the planner's would, not sealed.
        expect(ranSealed((await shell.run('git status --short')).output)).toBe(false);
      } finally {
        shell.end();
      }
    });
  });
});
