import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { RunnerRegistry, StructuredRunner, TaskOrchestrator, createTask, type Task } from '@ordewell/core';
import { fakeConfig } from '@ordewell/core/testing';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { loginPlanner, type PlannerLoginDeps } from '../plan/PlannerLogin';

const PROBE_FILE = 'integration-probe.txt';
const REAL_AGENT_TIMEOUT_MS = 240_000;
const FAKE_AGENT_TIMEOUT_MS = 30_000;

// runTest.ts puts this folder first on the host's PATH, so Ordewell's own
// claude-code connector spawns the fake `claude` exactly as it would the real one.
const FAKE_CLAUDE_DIR = path.resolve(__dirname, '../../../bench/pipeline/fake-claude');

const scratchDirs: string[] = [];

/** Runs a plan to its end on the structured runner every host hands the orchestrator, and returns its execution log. */
async function runPlan(tasks: Task[], runner: string, timeoutMs: number) {
  const workspace = process.env.ORDEWELL_TEST_WORKSPACE!;
  const structured = new StructuredRunner();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ enabledRunners: [runner] }),
    notifications: { info: () => {}, warn: () => {}, error: () => {}, confirm: async () => undefined },
    runner: structured,
    registry: new RunnerRegistry(),
    workspaceRoot: () => workspace,
  });

  let complete = false;
  orchestrator.subscribe({ onExecutionComplete: () => { complete = true; } });
  orchestrator.loadPlan(tasks, [runner]);
  try {
    await orchestrator.approveReview();
    await waitFor(() => complete, timeoutMs, 'the plan to finish');
  } finally {
    structured.stopAll();
  }
  return orchestrator.storeInstance.getExecutionLog();
}

function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (predicate()) { clearInterval(tick); resolve(); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(tick); reject(new Error(`timed out waiting for ${what}`)); }
    }, 100);
  });
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** A POSIX stand-in login CLI. Every line is our own, never untrusted input. */
function writeFakeLogin(lines: string[]): string {
  const dir = scratchDir('ow-native-login-');
  const file = path.join(dir, 'fake-login');
  fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  return file;
}

interface PostedMessage { type: string; runner?: string; ok?: boolean; message?: string }

interface LoginRun {
  deps: PlannerLoginDeps;
  posted: PostedMessage[];
  ended: () => PostedMessage | undefined;
  terminal: () => vscode.Terminal | undefined;
  tempRoot: string;
  /** Leftover status dirs would mean the wrapper's temp files leaked. */
  statusDirs: () => string[];
  /** True once VS Code fired a close for this login's terminal. */
  closed: () => boolean;
  /** How many times the host called terminal.dispose(). */
  disposeCalls: () => number;
  disposeTerminal(): void;
}

/**
 * Drive the real `loginPlanner` against the real `vscode.window`, with a fake
 * agent on disk and fake probes. No real runner is launched and no account is
 * touched; `loginTempRoot` pins the status dir so cleanup can be observed.
 */
function loginRun(opts: {
  loginCommand: string[];
  recheckState?: 'signed-in' | 'signed-out' | 'unknown';
  timeoutMs?: number;
  pollMs?: number;
}): LoginRun {
  const workspace = process.env.ORDEWELL_TEST_WORKSPACE!;
  const tempRoot = scratchDir('ow-native-status-');
  const posted: PostedMessage[] = [];
  let rechecked = false;
  let closedCount = 0;
  let disposeCalls = 0;
  let terminal: vscode.Terminal | undefined;
  const registry = new RunnerRegistry();
  // Independent of the listener loginPlanner registers (and disposes in its
  // finally): VS Code fires the close a tick after dispose(), by which time the
  // host's own listener is gone. This one survives to observe it.
  const ownCloseSub = vscode.window.onDidCloseTerminal((t) => { if (t === terminal) closedCount += 1; });
  const deps = {
    runnerInstallation: {
      runnerUsability: async () => ({
        usable: true,
        auth: { state: rechecked ? (opts.recheckState ?? 'signed-in') : 'signed-out', loginCommand: opts.loginCommand },
      }),
      refresh: () => {},
      recheck: async () => { rechecked = true; return { usable: true }; },
    },
    runnerRegistry: registry,
    config: { aiProvider: 'cursor-agent' },
    workspaceRoot: () => workspace,
    env: async () => ({}),
    sendState: async () => {},
    post: (msg: PostedMessage) => { posted.push(msg); },
    notifications: { info: () => {}, warn: () => {} },
    window: {
      createTerminal: (o: vscode.TerminalOptions) => {
        const t = vscode.window.createTerminal(o);
        // Count the host's dispose() directly, so the timeout path is proven
        // without depending on VS Code's asynchronous close event.
        const realDispose = t.dispose.bind(t);
        (t as { dispose: () => void }).dispose = () => { disposeCalls += 1; return realDispose(); };
        terminal = t;
        return t;
      },
      onDidCloseTerminal: (cb: (t: vscode.Terminal) => void) => vscode.window.onDidCloseTerminal(cb),
    },
    launch: { resolvePath: async () => process.env.PATH ?? '' },
    loginTempRoot: () => tempRoot,
    pollMs: opts.pollMs ?? 150,
    timeoutMs: opts.timeoutMs ?? 20_000,
    log: (msg: string) => console.log(`    [login] ${msg}`),
  } as unknown as PlannerLoginDeps;
  return {
    deps,
    posted,
    ended: () => posted.filter((m) => m.type === 'plannerLoginEnded').at(-1),
    terminal: () => terminal,
    tempRoot,
    statusDirs: () => fs.readdirSync(tempRoot).filter((n) => n.startsWith('ordewell-login-')),
    closed: () => closedCount > 0,
    disposeCalls: () => disposeCalls,
    disposeTerminal: () => {
      ownCloseSub.dispose();
      if (terminal && vscode.window.terminals.includes(terminal)) terminal.dispose();
    },
  };
}

function assertNoLeak(run: LoginRun): void {
  assert.deepStrictEqual(run.statusDirs(), [], 'the login left a status dir behind');
}

/**
 * REPRODUCTION of the original defect (VS Code 0.14.14, #71's native check):
 * a login that prints an error and exits 3 was the terminal's own process, and
 * VS Code disposed that transient terminal on process exit — taking the error
 * output with it. This is the behaviour the wrapper replaces.
 */
async function unwrappedLoginLosesItsFailureOutput(): Promise<void> {
  const file = writeFakeLogin([`printf '%s\\n' 'ERROR: fake agent login failed (diagnostic line 42)'`, 'exit 3']);
  let closed = false;
  const sub = vscode.window.onDidCloseTerminal((t) => { if (t.name === 'ordewell-repro') closed = true; });
  const t = vscode.window.createTerminal({ name: 'ordewell-repro', shellPath: file, shellArgs: [], isTransient: true });
  t.show();
  try {
    await waitFor(() => t.exitStatus !== undefined, 10_000, 'the unwrapped login to exit');
    // VS Code closes a transient terminal a tick after its process exits; on a
    // loaded host that can be well past a fixed sleep. Wait for the real close
    // event, bounded so a host that never closes one fails instead of hanging.
    await waitFor(() => closed, 10_000, 'the unwrapped terminal close event');
    assert.strictEqual(t.exitStatus?.code, 3, 'the fake login did not exit 3');
    assert.strictEqual(closed, true, 'VS Code did not dispose the terminal on process exit');
    assert.ok(!vscode.window.terminals.includes(t), 'the terminal is still listed — the baseline did not reproduce the disappearance');
    console.log('  ✓ reproduced: exit 3 disposed the transient terminal, losing its error output');
  } finally {
    sub.dispose();
  }
}

/** The fix: on a failed login the wrapper stays open (output accessible) and writes the real code to a status file. */
async function wrappedFailureKeepsOutputAndEndsTheSpinner(): Promise<void> {
  const file = writeFakeLogin([`printf '%s\\n' 'ERROR: fake agent login failed (diagnostic line 42)'`, 'exit 3']);
  const run = loginRun({ loginCommand: [file] });
  try {
    await loginPlanner(run.deps, 'cursor-agent');
    const ended = run.ended();
    assert.ok(ended, 'no plannerLoginEnded was posted — the spinner would never stop');
    assert.strictEqual(ended.ok, false, 'a failed login was reported as success');
    assert.ok(ended.message?.includes('exited with code 3'), `the status-file code was not reported: ${ended.message}`);
    assert.ok(ended.message?.includes('/login cursor-agent'), `no actionable retry: ${ended.message}`);
    // The wrapper shell is still alive, holding the error on screen: VS Code has
    // set no exitStatus and has not disposed the terminal, so its scrollback
    // (the failure output) remains accessible to the person.
    const t = run.terminal()!;
    assert.strictEqual(t.exitStatus, undefined, 'VS Code set an exitStatus while the wrapper is still open');
    assert.ok(vscode.window.terminals.includes(t), 'the failed login terminal was disposed — output lost');
    assertNoLeak(run);
    console.log('  ✓ failed login: status-file code 3, actionable failure posted, terminal still open with its output');
  } finally {
    run.disposeTerminal();
  }
}

/** A login that exits 0 earns a recheck; only that fresh verdict says signed-in. */
async function wrappedSuccessRechecks(): Promise<void> {
  const file = writeFakeLogin([`printf '%s\\n' 'fake login complete'`, 'exit 0']);
  const run = loginRun({ loginCommand: [file], recheckState: 'signed-in' });
  try {
    await loginPlanner(run.deps, 'cursor-agent');
    assert.deepStrictEqual(run.ended(), { type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });
    assertNoLeak(run);
    console.log('  ✓ successful login: exit 0 was rechecked and reported signed in');
  } finally {
    run.disposeTerminal();
  }
}

/** Interactive behaviour is preserved: the login sees a TTY and can read a pasted device code. */
async function interactiveLoginKeepsItsTty(): Promise<void> {
  const marker = path.join(scratchDir('ow-native-io-'), 'tty.txt');
  const input = path.join(scratchDir('ow-native-io-'), 'input.txt');
  const file = writeFakeLogin([
    `if [ -t 0 ]; then printf 'tty\\n' > "$1"; else printf 'no-tty\\n' > "$1"; fi`,
    `IFS= read -r entered || :`,
    `printf 'received:%s\\n' "$entered" > "$2"`,
    'exit 0',
  ]);
  const run = loginRun({ loginCommand: [file, marker, input], recheckState: 'signed-in' });
  try {
    const promise = loginPlanner(run.deps, 'cursor-agent');
    await waitFor(() => fs.existsSync(marker), 10_000, 'the fake login to reach its TTY check');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), 'tty', 'the login did not see a TTY');
    run.terminal()!.sendText('device-code-42', true);
    await promise;
    assert.strictEqual(fs.readFileSync(input, 'utf8').trim(), 'received:device-code-42', 'stdin did not reach the login');
    assert.deepStrictEqual(run.ended(), { type: 'plannerLoginEnded', runner: 'cursor-agent', ok: true });
    assertNoLeak(run);
    console.log('  ✓ interactive login: TTY present, pasted device code read through stdin');
  } finally {
    run.disposeTerminal();
  }
}

/** Closing the terminal mid-login ends the attempt as a failure, with no recheck. */
async function closeDuringLoginEndsAsFailure(): Promise<void> {
  const file = writeFakeLogin([`printf 'Enter a code: '`, `IFS= read -r _`, 'exit 0']);
  const run = loginRun({ loginCommand: [file] });
  try {
    const promise = loginPlanner(run.deps, 'cursor-agent');
    await waitFor(() => run.terminal() !== undefined, 10_000, 'the login terminal');
    await sleepReal(700);
    run.disposeTerminal();
    await promise;
    const ended = run.ended();
    assert.ok(ended && ended.ok === false, 'closing the terminal did not end the attempt as a failure');
    assert.ok(ended.message, 'no reason was given for the closed login');
    assertNoLeak(run);
    console.log(`  ✓ close during login: ended as a failure — ${ended.message}`);
  } finally {
    run.disposeTerminal();
  }
}

/** A login left waiting is ended with its terminal after the time limit. */
async function timeoutEndsTheLogin(): Promise<void> {
  const file = writeFakeLogin([`printf 'Enter a code: '`, `IFS= read -r _`, 'exit 0']);
  const run = loginRun({ loginCommand: [file], timeoutMs: 1_500, pollMs: 200 });
  try {
    await loginPlanner(run.deps, 'cursor-agent');
    assert.deepStrictEqual(run.ended(), {
      type: 'plannerLoginEnded', runner: 'cursor-agent', ok: false, message: 'Sign-in did not finish in time.',
    });
    // The timeout disposed the terminal (the host's own dispose() call), and
    // VS Code then fires a close for it a tick later.
    assert.ok(run.disposeCalls() > 0, 'the timeout did not dispose the login terminal');
    await waitFor(() => run.closed(), 5_000, 'the timed-out terminal close event');
    assertNoLeak(run);
    console.log('  ✓ timeout: the terminal was disposed and the attempt ended with the reason inline');
  } finally {
    run.disposeTerminal();
  }
}

/**
 * The notify command is read from the user's own setting alone (ADR-0053): the
 * workspace this window opened must not be able to name a program that runs.
 * Only a real host can say what `inspect().globalValue` and an application-scoped
 * key do with a workspace write, so a unit test with a stand-in cannot.
 */
async function notifyCommandIsTheUsersAlone(): Promise<void> {
  const settings = vscode.workspace.getConfiguration('ordewell');
  const theirs = ['sh', '-c', 'true'];
  try {
    await settings.update('notifyCommand', theirs, vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(new VsCodeConfig().notifyCommand, theirs, 'the user setting was not read');

    // The manifest scopes the key to the application, which refuses a workspace write; whether it does or a
    // host that took it would, the user's value is what is read.
    await Promise.resolve(settings.update('notifyCommand', ['sh', '-c', 'false'], vscode.ConfigurationTarget.Workspace)).catch(() => undefined);
    assert.deepStrictEqual(new VsCodeConfig().notifyCommand, theirs, "the workspace's value was read in place of the user's");

    // A string is not split: that is a shell's job and there is none.
    await settings.update('notifyCommand', 'notify-send done', vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(new VsCodeConfig().notifyCommand, [], 'a string setting was taken as a command');
    console.log('  ✓ the notify command is the user setting\'s alone, and a string is no command');
  } finally {
    await settings.update('notifyCommand', undefined, vscode.ConfigurationTarget.Global);
  }
}

async function fakeClaudeCompletesThroughTheTool(): Promise<void> {
  const first = process.env.PATH?.split(path.delimiter)[0];
  // path.relative, not ===: Windows names the same drive f:\ in the extension
  // host and F:\ in the runner that built this PATH.
  assert.ok(
    first !== undefined && path.relative(first, FAKE_CLAUDE_DIR) === '',
    `${FAKE_CLAUDE_DIR} is not first on the host's PATH; the real claude would run`,
  );

  const task = createTask({
    title: 'Integration probe (fake claude)',
    prompt: `Create a file called ${PROBE_FILE}.<fake-claude>${JSON.stringify({ write: { [PROBE_FILE]: 'ok' } })}</fake-claude>`,
    assignedRunner: 'claude-code',
    assignedModel: { modelId: 'fake-claude', modelLabel: 'Fake Claude' },
    taskMode: 'build',
  });

  const log = await runPlan([task], 'claude-code', FAKE_AGENT_TIMEOUT_MS);
  const verdict = log.find((entry) => entry.id === task.id)?.verdict;
  assert.strictEqual(verdict?.outcome, 'pass', `expected a pass verdict, got: ${JSON.stringify(verdict)}`);
  assert.ok(verdict?.reason.includes('task_complete'), `the pass did not come from task_complete: ${verdict?.reason}`);
  assert.ok(fs.existsSync(path.join(process.env.ORDEWELL_TEST_WORKSPACE!, PROBE_FILE)), `${PROBE_FILE} was never created`);
  console.log(`  ✓ fake claude did the work and the tool call reached a pass verdict — ${verdict?.reason}`);
}

async function realAgentReachesAPassVerdict(): Promise<void> {
  const model = process.env.ORDEWELL_TEST_MODEL;
  if (!model || !process.env.OPENROUTER_API_KEY) {
    console.log('  – skipped (no ORDEWELL_TEST_MODEL / OPENROUTER_API_KEY)');
    return;
  }

  const task = createTask({
    title: 'Integration probe',
    prompt: `Create a file called ${PROBE_FILE} containing the single word "ok". Do not ask any questions.`,
    assignedRunner: 'opencode',
    assignedModel: { modelId: model, modelLabel: model },
    taskMode: 'build',
  });

  const log = await runPlan([task], 'opencode', REAL_AGENT_TIMEOUT_MS);
  const verdict = log.find((entry) => entry.id === task.id)?.verdict;
  assert.strictEqual(verdict?.outcome, 'pass', `expected a pass verdict, got: ${JSON.stringify(verdict)}`);
  assert.ok(fs.existsSync(path.join(process.env.ORDEWELL_TEST_WORKSPACE!, PROBE_FILE)), `${PROBE_FILE} was never created — the verdict did not come from the agent's work`);
  console.log(`  ✓ real agent did the work and reached a pass verdict — ${verdict?.reason}`);
}

export async function run(): Promise<void> {
  // These six proofs drive the POSIX wrapper with fake POSIX shell agents. On a
  // Windows host loginPlanner would pick the cmd.exe wrapper and /bin/sh does
  // not exist, so they are POSIX-only; Windows launch/retention is proven by
  // loginTerminal.test.ts (npm shim, .cmd, .ps1, native exe) instead. The
  // remaining scenarios below run on every platform, as they always did.
  const posixWrapperProofs: Array<[string, () => Promise<void>]> = process.platform === 'win32' ? [] : [
    ['reproduce the exit-3 terminal disappearance (baseline, no wrapper)', unwrappedLoginLosesItsFailureOutput],
    ['a failed login keeps its output and ends the spinner (status-file exit 3)', wrappedFailureKeepsOutputAndEndsTheSpinner],
    ['a successful login is rechecked (status-file exit 0)', wrappedSuccessRechecks],
    ['an interactive login keeps its TTY and stdin', interactiveLoginKeepsItsTty],
    ['closing the terminal mid-login ends as a failure', closeDuringLoginEndsAsFailure],
    ['a login left waiting times out and is disposed', timeoutEndsTheLogin],
  ];
  if (process.platform === 'win32') {
    console.log('  – skipped 6 POSIX wrapper native scenarios (Windows retention is unit-tested)');
  }

  const scenarios: Array<[string, () => Promise<void>]> = [
    ...posixWrapperProofs,
    ['a fake claude on PATH completes through task_complete', fakeClaudeCompletesThroughTheTool],
    ['the notify command is read from the user setting alone', notifyCommandIsTheUsersAlone],
    ['a real agent reaches a pass verdict', realAgentReachesAPassVerdict],
  ];

  try {
    for (const [name, scenario] of scenarios) {
      console.log(`\n=== ${name} ===`);
      await scenario();
    }
    console.log('\nall integration scenarios passed');
  } finally {
    for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
