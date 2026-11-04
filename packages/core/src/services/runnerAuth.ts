import { execFile } from 'child_process';
import { resolve } from 'path';
import type { RunnerManifest, RunnerAuthSpec, RunnerAuthStatus } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';
import { planDirectLaunch, type LaunchDeps } from '../utils/launch';

/**
 * What a runner's own status command answered (ADR-0009). A surface flags a
 * planner on `signed-out` and never on `unknown`: only the runner can say its
 * user is signed out, and an unparseable or missing answer must not.
 */
export interface RunnerAuth {
  state: 'signed-in' | 'signed-out' | 'unknown';
  /** The runner command plus its login args, so a surface runs the same login the CLI would. */
  loginCommand?: string[];
  /** A short, credential-free reason — the status command's own wording, never its output. */
  detail?: string;
}

/** A status command's answer. Unlike `exec`, a non-zero exit is data, not a rejection. */
export interface RunnerAuthExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunnerAuthExecOptions {
  timeout: number;
  env: NodeJS.ProcessEnv;
  /** The args are one cmd.exe command line already quoted, as `planDirectLaunch`'s batch route hands back. */
  verbatim?: boolean;
}

export type RunnerAuthExec = (
  command: string,
  args: string[],
  options: RunnerAuthExecOptions,
) => Promise<RunnerAuthExecResult>;

export interface ReadRunnerAuthOptions {
  exec?: RunnerAuthExec;
  /** The workspace's own variables (ADR-0016), merged over the daemon's for the probe. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** How the status command is located and started; a test pins the Windows routes from any host. */
  launch?: LaunchDeps;
}

const AUTH_TIMEOUT_MS = 8000;

/**
 * `execFile`'s own timeout sends SIGTERM and then waits for the child and its
 * pipes. A status command that ignores SIGTERM, or leaves a child holding the
 * pipes, would keep the probe pending past its budget and stall the runner
 * list and every turn that rechecks a signed-out planner. The hard timer
 * answers `unknown` on the budget's own edge and kills what is left.
 */
const defaultExec: RunnerAuthExec = (command, args, options) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: RunnerAuthExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = execFile(command, args, { timeout: options.timeout, env: options.env, encoding: 'utf8', windowsVerbatimArguments: options.verbatim }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      // A signal or a spawn failure has no numeric code; either way nothing
      // trustworthy came back, so it is not an exit status to read.
      const code = err ? (typeof raw === 'number' ? raw : -1) : 0;
      settle({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // A pipe held open by a grandchild would keep execFile's callback
      // waiting even after the kill, so close our ends and answer now.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ code: -1, stdout: '', stderr: '' });
    }, options.timeout);
    timer.unref?.();
  });

/**
 * Ask one runner whether its user is signed in. Never throws and never reads a
 * credential: it runs the manifest's status args with the same augmented PATH
 * and workspace environment a planner would use, and judges only that answer.
 */
export async function readRunnerAuth(manifest: RunnerManifest, options: ReadRunnerAuthOptions = {}): Promise<RunnerAuth> {
  const spec = manifest.auth;
  if (!spec) return { state: 'unknown' };
  const command = manifest.runner.command;
  const loginCommand = [command, ...spec.loginArgs];
  if (!spec.statusArgs) return { state: 'unknown', loginCommand };

  let answer: RunnerAuthExecResult;
  let env: NodeJS.ProcessEnv;
  try {
    env = withPath(process.env, await augmentedPath(), options.env ?? {});
    // Started the way the planner starts it (ADR-0010): a bare execFile finds
    // only a native .exe on Windows, so an npm-installed agent's .cmd shim was
    // ENOENT here and its login always read unknown, never signed out.
    const launch = await planDirectLaunch(command, spec.statusArgs, options.launch);
    answer = await (options.exec ?? defaultExec)(launch.file, launch.args, {
      timeout: options.timeoutMs ?? AUTH_TIMEOUT_MS,
      env,
      ...(launch.verbatim ? { verbatim: true } : {}),
    });
  } catch {
    return { state: 'unknown', loginCommand };
  }

  // `defaultExec` answers -1 when the child timed out, was signalled or could
  // not start. That is no exit status, so whatever it printed before dying is
  // not an answer: a slow status command must not be read as signed-out.
  if (answer.code < 0) return { state: 'unknown', loginCommand };

  const output = `${answer.stdout}\n${answer.stderr}`;
  let state: 'signed-in' | 'signed-out' | null;
  try {
    state = verdictOf(spec, { ...answer, output, env, kind: 'status' });
  } catch {
    // A reader that cannot make sense of the output answered nothing.
    return { state: 'unknown', loginCommand };
  }
  if (state === 'signed-in') return { state, loginCommand };
  if (state === 'signed-out') return { state, loginCommand, detail: 'not logged in' };
  return { state: 'unknown', loginCommand };
}

/** A signed-out verdict always carries the command that fixes it; a failure fallback leans on that. */
export type SignedOutAuth = RunnerAuth & { state: 'signed-out'; loginCommand: string[] };

/**
 * A failed turn's own words as the runner's signed-out verdict. Only a phrase
 * the manifest declares — its `signedOut` line, or a reader that can judge the
 * message — so an unrelated failure is never turned into a login wall. The
 * reader judges first, with `env`, the environment the probe and the planner
 * use for this workspace (ADR-0016): the runner's own config under a custom
 * `CODEX_HOME`/`HOME` can make its "Not logged in" line not this user's
 * answer. The regex is the fallback only where there is no reader to judge.
 * It asks nothing: the turn has already told us.
 */
export function signedOutFromFailure(manifest: RunnerManifest, message: string, env: NodeJS.ProcessEnv = process.env): SignedOutAuth | undefined {
  const spec = manifest.auth;
  if (!spec) return undefined;
  let state: 'signed-in' | 'signed-out' | null;
  try {
    state = verdictOf(spec, {
      code: 1, stdout: message, stderr: '', output: message, env, kind: 'turn',
    });
  } catch {
    return undefined;
  }
  if (state !== 'signed-out') return undefined;
  return {
    state,
    loginCommand: [manifest.runner.command, ...spec.loginArgs],
    detail: 'not logged in',
  };
}

function verdictOf(spec: RunnerAuthSpec, answer: RunnerAuthStatus): 'signed-in' | 'signed-out' | null {
  if (spec.read) return spec.read(answer);
  return verdictFromExit(spec, answer.output, answer.code);
}

function verdictFromExit(spec: RunnerAuthSpec, output: string, code: number): 'signed-in' | 'signed-out' | null {
  if (code === 0) return 'signed-in';
  return spec.signedOut?.test(output) ? 'signed-out' : null;
}

/**
 * The latest verdict per runner and workspace, because a planner readiness
 * check is synchronous and cannot await a probe, and because one daemon can
 * serve several workspaces whose accounts differ (ADR-0016). Follows
 * `services/InstalledPlanner.ts`: a host probes when it builds or refreshes its
 * runner list, and every later sync check reads that workspace's answer here.
 * A caller with no workspace — a test, or a host that only ever plans in its
 * own cwd — reads and writes the unscoped entry.
 */
const recorded = new Map<string, RunnerAuth>();

function recordKey(runner: string, workspace?: string): string {
  // Resolved on both sides, since a request may name a relative workspace while
  // the installation it probed is keyed by the absolute one.
  return workspace ? `${resolve(workspace)}\u0000${runner}` : runner;
}

export function recordRunnerAuth(runner: string, auth: RunnerAuth, workspace?: string): void {
  recorded.set(recordKey(runner, workspace), auth);
}

export function recordedRunnerAuth(runner: string, workspace?: string): RunnerAuth | undefined {
  return recorded.get(recordKey(runner, workspace));
}

/** For tests: the record is process-wide, so one case's verdict must not decide the next's. */
export function resetRunnerAuth(): void {
  recorded.clear();
}
