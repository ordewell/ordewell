#!/usr/bin/env node
/**
 * Drive a built `ordewell` executable end to end, offline, on a machine with no
 * Node on its PATH. This is the check that a standalone binary (the Node SEA)
 * carries everything it needs: its own runtime, its daemon and the planner loop.
 * `drive-conversation.mjs` imports the built core in-process and so proves none
 * of that.
 *
 *   node bench/live/drive-binary.mjs --bin <path-to-ordewell> [--mock-port 3799]
 *
 * It starts `mock-provider.mjs` itself on --mock-port (as scripts/ci.mjs's
 * plannerE2e does) and refuses to run if that port is already taken, since a
 * mock left over from an aborted run would be talked to instead. Do not start
 * one beforehand. This script's own `node` starts the mock and nothing else;
 * every spawn of the binary gets the environment below.
 *
 * Environment of every binary spawn (built from scratch, not inherited, so a
 * stray OPENROUTER_API_KEY or NODE_OPTIONS on the host cannot leak in):
 *   - HOME (and USERPROFILE/APPDATA/... on Windows) in a throwaway temp folder,
 *     so ~/.ordewell (settings, daemon token, pid file, log) is private
 *   - ORDEWELL_NO_VERSION_CHECK=1
 *   - PATH with every directory holding a `node` executable removed, plus a
 *     tools folder of `git` and `sh` (and a fake `claude` that only prints a
 *     version, so the runner probe finds one) because those commonly live in
 *     the same directory as `node` (/usr/bin). Node's absence is asserted.
 *   - OPENROUTER_BASE_URL=http://127.0.0.1:<mock-port>/v1, OPENROUTER_API_KEY=
 *     mock-key, AI_PROVIDER=openrouter, ORCHESTRATOR_MODEL=mock/<persona>
 *   - a free daemon port, passed as --port to every command
 *
 * Steps (one line each; the first failure ends the run with exit 1):
 *   1. `<bin> --version` exits 0 and prints a version
 *   2. `<bin> web --daemon --port N` starts the daemon, `<bin> status` reaches it
 *   3. `<bin> plan --goal ...` against the mock, twice, answered on stdin:
 *      - mock/interviewer asks two questions, then commits a 2-task plan
 *      - mock/goal-build commits a 3-task plan without asking anything
 *      and `status --json` shows the daemon holds both sessions with those tasks
 *   4. `<bin> stop --server --port N` stops it and the port is free again
 *
 * The daemon, the mock and the temp folder are cleaned up on every path.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const binArg = arg('bin');
const mockPort = Number(arg('mock-port', '3799'));
if (!binArg || !Number.isInteger(mockPort) || mockPort <= 0) {
  console.error('Usage: node bench/live/drive-binary.mjs --bin <path-to-ordewell> [--mock-port 3799]');
  process.exit(2);
}
const bin = path.resolve(binArg);

class StepError extends Error {}
const fail = (message) => { throw new StepError(message); };

// ---------- ports ----------
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function until(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------- PATH without node ----------
const nodeNames = WIN ? ['node.exe', 'node.cmd', 'node.bat', 'node'] : ['node'];

function holds(dir, names) {
  return names.some((name) => {
    try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
  });
}

function findOnPath(name, dirs) {
  const names = WIN ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  return dirs.find((dir) => holds(dir, names));
}

// ---------- running the binary ----------
function run(command, args, { env, cwd, input, timeoutMs = 90_000 }) {
  return new Promise((resolve) => {
    // A .cmd/.bat shim can only be started through a shell on Windows.
    const viaShell = WIN && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, { env, cwd, shell: viaShell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(err), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const tail = (text, n = 1500) => (text.length > n ? `…${text.slice(-n)}` : text).trim();

function describe(label, r) {
  return `${label} ${r.timedOut ? 'timed out' : `exited ${r.code}`}\n--- stdout ---\n${tail(r.stdout)}\n--- stderr ---\n${tail(r.stderr)}`;
}

// ---------- main ----------
const cleanups = [];
// Which step is running: "3b" is the second planner conversation of step 3.
let where = '1';
let daemonLog = '';
const pass = (message) => console.log(`ok   ${where}. ${message}`);

async function main() {
  if (!fs.existsSync(bin)) fail(`--bin ${bin} does not exist`);

  if (!(await portFree(mockPort))) {
    fail(`port ${mockPort} is already taken; stop whatever holds it (an old mock-provider?) or pass --mock-port`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-binary-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const tools = path.join(root, 'tools');
  for (const dir of [home, workspace, tools]) fs.mkdirSync(dir);

  // A repository to plan in, with a README and a source file for the planner to read.
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Demo project\n\nA tiny demo app. TODO: add tests.\n');
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export function main() {\n  console.log("demo");\n}\n');

  // PATH: drop every directory that holds node, keep the rest.
  const originalDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const keptDirs = originalDirs.filter((dir) => !holds(dir, nodeNames));
  // git and sh usually share a directory with node (/usr/bin), so they would vanish with it.
  for (const tool of WIN ? ['git'] : ['git', 'sh']) {
    const dir = findOnPath(tool, originalDirs);
    if (!dir || findOnPath(tool, keptDirs)) continue;
    if (WIN) continue; // symlinks need a privilege; Git for Windows does not live beside node
    fs.symlinkSync(path.join(dir, tool), path.join(tools, tool));
  }
  // The runner probe runs `claude --version`; a version is all it needs to count it installed.
  if (WIN) fs.writeFileSync(path.join(tools, 'claude.cmd'), '@echo 0.0.0-binary-e2e\r\n');
  else fs.writeFileSync(path.join(tools, 'claude'), '#!/bin/sh\necho "0.0.0-binary-e2e"\n', { mode: 0o755 });
  const pathDirs = [tools, ...keptDirs];

  const stillThere = findOnPath('node', pathDirs);
  if (stillThere) fail(`node is still on the PATH given to the binary (${stillThere})`);
  if (!WIN) {
    const probe = spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: pathDirs.join(path.delimiter) }, encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) fail(`sh finds node on the binary's PATH: ${probe.stdout.trim()}`);
  }
  if (!WIN && !findOnPath('git', pathDirs)) fail('git is not available to give the binary; install git');

  const git = spawnSync('git', ['init', '-q'], { cwd: workspace, env: { PATH: pathDirs.join(path.delimiter) }, encoding: 'utf8' });
  if (git.status !== 0) fail(`git init failed in the workspace: ${git.stderr || git.error}`);

  daemonLog = path.join(home, '.ordewell', 'server.log');

  const daemonPort = await freePort();
  const env = {
    PATH: pathDirs.join(path.delimiter),
    HOME: home,
    ...(WIN ? {
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      ProgramData: path.join(home, 'ProgramData'),
      SystemRoot: process.env.SystemRoot ?? '',
      ComSpec: process.env.ComSpec ?? '',
      PATHEXT: process.env.PATHEXT ?? '.EXE;.CMD;.BAT',
    } : {}),
    TMPDIR: root, TEMP: root, TMP: root,
    LANG: 'C.UTF-8',
    ORDEWELL_NO_VERSION_CHECK: '1',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPENROUTER_API_KEY: 'mock-key',
    AI_PROVIDER: 'openrouter',
    ORCHESTRATOR_MODEL: 'mock/interviewer',
  };
  const ordewell = (args, { env: extra, ...opts } = {}) => run(bin, args, { ...opts, env: { ...env, ...extra }, cwd: workspace });
  console.log(`bin ${bin}\nhome ${home}\ndaemon port ${daemonPort}, mock port ${mockPort}\nPATH has no node: ${pathDirs.length} dirs`);

  // The mock, which this script owns.
  const mock = spawn(process.execPath, [path.join(__dirname, 'mock-provider.mjs'), '--port', String(mockPort)], { stdio: ['ignore', 'ignore', 'inherit'] });
  cleanups.push(() => { mock.kill(); });
  let mockExited = false;
  mock.on('exit', () => { mockExited = true; });
  await until('the mock provider to listen', 10_000, async () => {
    if (mockExited) fail('the mock provider exited at startup');
    return !(await portFree(mockPort));
  });

  // 1. --version
  const version = await ordewell(['--version'], { timeoutMs: 30_000 });
  const printed = version.stdout.trim();
  if (version.code !== 0) fail(describe('`--version`', version));
  if (!/^\d+\.\d+\.\d+\S*$/.test(printed)) fail(`\`--version\` printed ${JSON.stringify(printed)}, not a version`);
  pass(`--version prints ${printed}`);

  // 2. the daemon
  where = '2';
  let daemonStarted = false;
  cleanups.push(async () => {
    if (!daemonStarted) return;
    // The binary's own stop first; if that failed, the pid file the daemon wrote.
    await ordewell(['stop', '--server', '--port', String(daemonPort)], { timeoutMs: 30_000 });
    for (const file of [path.join(home, '.ordewell', `server-${daemonPort}.pid`)]) {
      try {
        const pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
        if (pid > 0) process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
  });
  if (!(await portFree(daemonPort))) fail(`daemon port ${daemonPort} was taken before the start`);
  const started = await ordewell(['web', '--daemon', '--port', String(daemonPort)], { timeoutMs: 60_000 });
  daemonStarted = true;
  if (started.code !== 0 || !/Server (started|already running)/.test(started.stdout)) fail(describe('`web --daemon`', started));
  // `status` starts a daemon when none runs, so reaching it proves nothing alone; the port must be held as well.
  if (await portFree(daemonPort)) fail(`\`web --daemon\` returned but nothing listens on port ${daemonPort}`);
  const status = await until('`status` to report the daemon', 30_000, async () => {
    const r = await ordewell(['status', '--port', String(daemonPort)], { timeoutMs: 30_000 });
    return r.code === 0 ? r : null;
  });
  if (/Server not running/.test(status.stderr)) fail(`\`status\` had to start a daemon of its own:\n${tail(status.stderr)}`);
  pass(`daemon running on 127.0.0.1:${daemonPort}, \`status\` reaches it`);

  // 3. planner conversations through the daemon
  const scenarios = [
    {
      persona: 'mock/interviewer',
      goal: 'make this project better',
      input: 'code health\nnode:test\nconfirm\n',
      // two questions, an outline, then the committed plan
      printed: ['should I focus on code health', 'do you prefer node:test', 'Plan: 2 tasks', 'Set up node:test harness', 'Write docs'],
      tasks: 2,
      summary: 'mock/interviewer asked two questions and committed a 2-task plan',
    },
    {
      persona: 'mock/goal-build',
      goal: 'Add a --verbose flag that prints each file the demo CLI reads, with a test for it.',
      input: '',
      printed: ['Plan: 3 tasks'],
      absent: ['**Question**'],
      tasks: 3,
      summary: 'mock/goal-build committed a 3-task plan without asking',
    },
  ];
  for (const [i, s] of scenarios.entries()) {
    where = `3${'abcdefgh'[i]}`;
    const r = await ordewell(
      ['plan', '--goal', s.goal, '--runner', 'claude-code', '--workspace', workspace, '--port', String(daemonPort)],
      { env: { ORCHESTRATOR_MODEL: s.persona }, input: s.input, timeoutMs: 120_000 },
    );
    if (r.code !== 0) fail(describe(`\`plan\` (${s.persona})`, r));
    for (const text of s.printed) if (!r.stdout.includes(text)) fail(`\`plan\` (${s.persona}) did not print ${JSON.stringify(text)}\n${describe('`plan`', r)}`);
    for (const text of s.absent ?? []) if (r.stdout.includes(text)) fail(`\`plan\` (${s.persona}) printed ${JSON.stringify(text)}, which the scenario should not\n${describe('`plan`', r)}`);
    // The daemon's own account of it, not just the CLI's output.
    const listed = await ordewell(['status', '--json', '--workspace', workspace, '--port', String(daemonPort)], { timeoutMs: 30_000 });
    let sessions;
    try { sessions = JSON.parse(listed.stdout); } catch { fail(describe('`status --json`', listed)); }
    const session = Array.isArray(sessions) ? sessions.find((x) => x.goal === s.goal) : undefined;
    if (!session) fail(`the daemon holds no session for goal ${JSON.stringify(s.goal)}: ${tail(listed.stdout)}`);
    if (session.taskCount !== s.tasks) fail(`the daemon's session has ${session.taskCount} tasks, expected ${s.tasks}`);
    pass(s.summary);
  }

  // 4. stop
  where = '4';
  const stopped = await ordewell(['stop', '--server', '--port', String(daemonPort)], { timeoutMs: 30_000 });
  if (stopped.code !== 0 || !/Server stopped/.test(stopped.stdout)) fail(describe('`stop --server`', stopped));
  daemonStarted = false;
  await until(`port ${daemonPort} to be free`, 15_000, () => portFree(daemonPort));
  pass(`daemon stopped, port ${daemonPort} is free`);
}

let code = 0;
try {
  await main();
  console.log('PASS');
} catch (err) {
  code = 1;
  console.error(`FAIL step ${where}: ${err instanceof StepError ? err.message : (err?.stack ?? err)}`);
  try {
    // Gone with the temp folder a moment later, and often the only account of why the daemon misbehaved.
    if (daemonLog) console.error(`--- daemon log ---\n${tail(fs.readFileSync(daemonLog, 'utf8'), 3000)}`);
  } catch { /* the daemon never started */ }
} finally {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch (err) { console.error(`cleanup: ${err}`); }
  }
}
process.exit(code);
