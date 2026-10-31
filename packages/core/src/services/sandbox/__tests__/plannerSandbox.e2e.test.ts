import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PlannerShellSandbox, resolvePlannerSandbox } from '../plannerSandbox';
import type { ResearchShell, ShellLaunch } from '../../researchShell';

/**
 * The sandbox itself, on this host: Seatbelt on macOS, bubblewrap on Linux.
 * Where the probe fails (no `bwrap`, a kernel that restricts user namespaces,
 * Windows, CI's image) the whole file skips and its title says why, so a
 * green run never claims a sandbox it did not exercise.
 */

const POSIX: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };

function installed(binary: string): boolean {
  return spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(launch: ShellLaunch, command: string, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(launch.file ?? '/bin/sh', [...launch.args, command], { cwd, env: launch.env, timeout: 60_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

/**
 * CI sets this on a host that is meant to run the sandbox, so a probe that
 * fails there fails the suite: a green run must mean the real sandbox ran,
 * not that every test skipped again.
 */
const REQUIRE_SANDBOX = process.env.ORDEWELL_REQUIRE_SANDBOX === '1';

// The probe is asynchronous and the skip is decided when the suite is collected, so the outer suite awaits it.
describe("the planner's sandbox", async () => {
  const availability = await resolvePlannerSandbox();
  const title = availability.available
    ? `on this host (${availability.backend.name})`
    : `${REQUIRE_SANDBOX ? 'required' : 'skipped'}: ${availability.notice.split('\n')[0]}`;

  describe.skipIf(!availability.available && !REQUIRE_SANDBOX)(title, () => {
    if (!availability.available) {
      it('has a sandbox on this host (ORDEWELL_REQUIRE_SANDBOX=1)', () => {
        throw new Error(availability.notice);
      });
      return;
    }

    let workspace: string;
    const sandbox = new PlannerShellSandbox();

    const sh = async (command: string, opts: { network?: boolean; cwd?: string } = {}) =>
      run((await sandbox.launch(POSIX, { network: opts.network ?? false })).launch, command, opts.cwd ?? workspace);

    beforeAll(() => {
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sandbox-ws-')));
      writeFileSync(join(workspace, 'README.md'), 'hello sandbox\n');
      writeFileSync(join(workspace, 'package.json'), '{ "name": "sandbox-fixture", "version": "1.0.0" }\n');
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: workspace });
      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'first');
      writeFileSync(join(workspace, 'README.md'), 'hello sandbox, changed\n');
    });

    afterAll(() => {
      sandbox.end();
      rmSync(workspace, { recursive: true, force: true });
    });

    it('cannot write the workspace or the home directory', async () => {
      const inWorkspace = join(workspace, 'x');
      expect((await sh(`touch '${inWorkspace}'`)).code).not.toBe(0);
      expect(existsSync(inWorkspace)).toBe(false);

      // A name of its own rather than `~/x`, so a broken sandbox cannot clobber a file the user has there.
      const inHome = join(homedir(), `.ordewell-sandbox-check-${process.pid}`);
      try {
        expect((await sh(`echo > '${inHome}'`)).code).not.toBe(0);
        expect(existsSync(inHome)).toBe(false);
      } finally {
        rmSync(inHome, { force: true });
      }
    });

    it('cannot write the workspace with the network either', async () => {
      expect((await sh('touch x', { network: true })).code).not.toBe(0);
      expect(existsSync(join(workspace, 'x'))).toBe(false);
    });

    it('writes into $TMPDIR, its scratch directory', async () => {
      const result = await sh('echo scratch-ok > "$TMPDIR/f" && cat "$TMPDIR/f" && echo "$TMPDIR"');
      expect(result.code).toBe(0);
      const [content, dir] = result.out.trim().split('\n');
      expect(content).toBe('scratch-ok');
      expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('scratch-ok\n');
    });

    it.each([
      ['git status', /README\.md/],
      ['git log --oneline', /first/],
      ['git diff', /changed/],
      ['ls', /package\.json/],
      ['cat README.md', /hello sandbox/],
      ['find . -name "*.md" -not -path "./.git/*"', /README\.md/],
      ['grep -r sandbox README.md', /hello sandbox/],
      ['npm ls', /sandbox-fixture@1\.0\.0/],
      // macOS's /bin/sh writes a here-document to /tmp, not $TMPDIR.
      ['cat <<EOF\nheredoc-ok\nEOF', /heredoc-ok/],
    ])('runs `%s`', async (command, expected) => {
      const result = await sh(command);
      expect(result.out).toMatch(expected);
      expect(result.code).toBe(0);
    });

    it('leaves no lock behind that `git status` would have taken', async () => {
      await sh('git status');
      expect(existsSync(join(workspace, '.git', 'index.lock'))).toBe(false);
    });

    it.skipIf(!installed('rg'))('runs `rg`', async () => {
      const result = await sh('rg sandbox README.md');
      expect(result).toMatchObject({ code: 0 });
      expect(result.out).toMatch(/hello sandbox/);
    });

    it.skipIf(!installed('cargo'))('runs `cargo metadata` on a crate with its lockfile', async () => {
      const crate = join(workspace, 'crate');
      mkdirSync(join(crate, 'src'), { recursive: true });
      writeFileSync(join(crate, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
      writeFileSync(join(crate, 'src', 'lib.rs'), '');
      // A repository commits its lockfile; without one, cargo writes it beside the manifest, which the sandbox refuses.
      spawnSync('cargo', ['generate-lockfile', '--offline'], { cwd: crate });
      const result = await sh('cargo metadata --format-version 1', { cwd: crate });
      expect(result.out).toContain('"name":"fixture"');
      expect(result.code).toBe(0);
    });

    it.skipIf(!installed('go'))('runs `go list`', async () => {
      const mod = join(workspace, 'gomod');
      mkdirSync(mod, { recursive: true });
      writeFileSync(join(mod, 'go.mod'), 'module example.com/fixture\n\ngo 1.21\n');
      writeFileSync(join(mod, 'main.go'), 'package main\n\nfunc main() {}\n');
      const result = await sh('go list ./...', { cwd: mod });
      expect(result.out).toContain('example.com/fixture');
      expect(result.code).toBe(0);
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

      it("is withheld from a command that ran without asking, and kept for an approved one", async () => {
        const connect = `'${process.execPath}' connect.js ${port}`;
        expect((await sh(connect, { network: false })).code).not.toBe(0);
        expect((await sh(connect, { network: true })).code).toBe(0);
      });

      // OpenCode's server takes a new MCP command from whoever has its
      // password, and a macOS command can read that password from the
      // server's environment: so the native shell must not reach it (N2).
      it("keeps a native shell, which has the network, off loopback and this machine's Unix sockets (ADR-0036 N2)", async () => {
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-native-tmp-')));
        const socketDir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-native-sock-')));
        const socketPath = join(socketDir, 'api.sock');
        const local = createServer((socket) => socket.end());
        await new Promise<void>((resolve) => local.listen(socketPath, resolve));
        try {
          const native = sandbox.launchNativeShell({ workspace, tmpdir: tmp, shell: '/bin/sh' });
          if (availability.backend.name !== 'Seatbelt') {
            // Bubblewrap has no way to keep the network but drop loopback, so it refuses (N4).
            await expect(native).rejects.toThrow();
            return;
          }
          const launch = await native;
          expect((await run(launch, `'${process.execPath}' connect.js ${port}`, workspace)).code).toBe(3);
          writeFileSync(join(tmp, 'unix.js'),
            `const s = require('net').connect(${JSON.stringify(socketPath)});\n`
            + "s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(3));\n"
            + 'setTimeout(() => process.exit(4), 5000);\n');
          expect((await run(launch, `'${process.execPath}' '${join(tmp, 'unix.js')}'`, workspace)).code).toBe(3);
          // The same socket is reachable from outside, so the refusal above is the sandbox's.
          expect((await run({ file: '/bin/sh', args: ['-c'], env: process.env }, `'${process.execPath}' '${join(tmp, 'unix.js')}'`, workspace)).code).toBe(0);
        } finally {
          await new Promise<void>((resolve) => local.close(() => resolve()));
          rmSync(tmp, { recursive: true, force: true });
          rmSync(socketDir, { recursive: true, force: true });
        }
      });
    });

    // Seatbelt has no setting up to be killed in: `sandbox-exec` becomes the shell.
    it.skipIf(process.platform !== 'darwin')('runs the command as the launcher itself, so no process stands between a kill and it', async () => {
      const { launch } = await sandbox.launch(POSIX, { network: false });
      const child = spawn(launch.file!, [...launch.args, 'echo $$'], { cwd: workspace, env: launch.env, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout!.on('data', (chunk) => { out += String(chunk); });
      await once(child, 'close');

      expect(out.trim()).toBe(String(child.pid));
    });

    // A top-level bash with a socket on standard input, which is what Node gives
    // it, reads `~/.bashrc`, and what starts bubblewrap runs outside the sandbox.
    it('reads no startup file on the way into the sandbox', async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sandbox-home-')));
      const marker = join(home, 'marker');
      writeFileSync(join(home, '.bashrc'), `touch '${marker}'\n`);
      const { launch } = await sandbox.launch(POSIX, { network: false });
      const child = spawn(launch.file!, [...launch.args, 'true'], { cwd: workspace, env: { ...launch.env, HOME: home, SHLVL: undefined }, stdio: ['pipe', 'ignore', 'ignore'] });
      try {
        await once(child, 'close');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('takes a path with quotes, parentheses and a newline as a path, never as policy', async () => {
      if (!availability.available) return;
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sandbox-path-')));
      const hostile = join(root, 'a"b) (allow file-write* (subpath "/"))\nc');
      mkdirSync(hostile, { recursive: true });
      try {
        const launch = availability.backend.wrap(
          { shell: '/bin/sh', shellArgs: ['-c'], env: process.env },
          availability.profile({ scratch: hostile, network: false }),
        );
        expect((await run(launch, 'touch "$TMPDIR/inside"', workspace)).code).toBe(0);
        expect(existsSync(join(hostile, 'inside'))).toBe(true);
        expect((await run(launch, `touch '${join(root, 'beside')}'`, workspace)).code).not.toBe(0);
        expect(existsSync(join(root, 'beside'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
