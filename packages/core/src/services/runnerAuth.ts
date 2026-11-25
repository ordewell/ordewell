import { execFile } from 'child_process';
import { resolve } from 'path';
import { runnerCommand, type RunnerManifest, type RunnerAuthSpec, type RunnerAuthStatus } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';
import { planDirectLaunch, type LaunchDeps } from '../utils/launch';
import { BUILTIN_MANIFESTS } from '../plugins/builtin';
import { connectorFor } from './harness/connectors';
import { describeSignIn, signInOf, type RunnerSignIn, type SignInSyntax } from './signInHint';

/**
 * What a runner's own status command answered (ADR-0009). A surface flags a
 * planner on `signed-out` and never on `unknown`: only the runner can say its
 * user is signed out, and an unparseable or missing answer must not.
 */
export interface RunnerAuth {
  state: 'signed-in' | 'signed-out' | 'unknown';
  /**
   * The runner command plus its login args, so a surface runs the same login
   * the CLI would. Absent where the agent has no login of its own to run.
   */
  loginCommand?: string[];
  /** Every way into the agent, which each surface words with `describeSignIn` (ADR-0052). */
  signIn?: RunnerSignIn;
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
  const auth = await probeRunnerAuth(manifest, options);
  const signIn = runnerSignIn(manifest);
  return {
    ...auth,
    ...(signIn.login ? { loginCommand: [...signIn.login] } : {}),
    signIn,
  };
}

async function probeRunnerAuth(manifest: RunnerManifest, options: ReadRunnerAuthOptions): Promise<RunnerAuth> {
  const spec = manifest.auth;
  const command = runnerCommand(manifest);
  if (!spec?.statusArgs || command === undefined) return { state: 'unknown' };

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
    return { state: 'unknown' };
  }

  // `defaultExec` answers -1 when the child timed out, was signalled or could
  // not start. That is no exit status, so whatever it printed before dying is
  // not an answer: a slow status command must not be read as signed-out.
  if (answer.code < 0) return { state: 'unknown' };

  const output = `${answer.stdout}\n${answer.stderr}`;
  let state: 'signed-in' | 'signed-out' | null;
  try {
    state = verdictOf(spec, { ...answer, output, env, kind: 'status' });
  } catch {
    // A reader that cannot make sense of the output answered nothing.
    return { state: 'unknown' };
  }
  if (state === 'signed-in') return { state };
  if (state === 'signed-out') return { state, detail: 'not logged in' };
  return { state: 'unknown' };
}

/**
 * Every way into a runner: its manifest's login and by-hand route, and the key
 * its connector reads. A runner may be a plugin's, which has no connector.
 */
export function runnerSignIn(runner: RunnerManifest): RunnerSignIn;
export function runnerSignIn(runner: string): RunnerSignIn | undefined;
export function runnerSignIn(runner: RunnerManifest | string): RunnerSignIn | undefined {
  const manifest = typeof runner === 'string' ? BUILTIN_MANIFESTS.find((m) => m.name === runner) : runner;
  return manifest && signInOf(manifest, connectorFor(manifest.name)?.signInRoute);
}

/**
 * A message one surface worded, with each shipped runner's sign-in hint said
 * in another's syntax. The daemon words for the terminal UI, since it cannot
 * know who reads; a client without slash commands re-words what reaches it.
 */
export function rewordSignIn(message: string, from: SignInSyntax, to: SignInSyntax): string {
  let said = message;
  for (const manifest of BUILTIN_MANIFESTS) {
    const signIn = runnerSignIn(manifest);
    said = said.replaceAll(describeSignIn(signIn, from), describeSignIn(signIn, to));
  }
  return said;
}

/** A signed-out verdict always carries the ways in, so whatever reports it can name them. */
export type SignedOutAuth = RunnerAuth & { state: 'signed-out'; signIn: RunnerSignIn };

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
  return signedOutAuth(runnerSignIn(manifest));
}

/** The signed-out verdict for an agent whose ways in are `signIn`, as a refused start or turn records it. */
export function signedOutAuth(signIn: RunnerSignIn, detail = 'not logged in'): SignedOutAuth {
  return {
    state: 'signed-out',
    ...(signIn.login ? { loginCommand: [...signIn.login] } : {}),
    detail,
    signIn,
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
 * What a recorded verdict rests on (ADR-0052). `status` is the runner's own
 * status command, or no command at all, which answers `unknown`; `turn` is a
 * planner turn or a task, including an ACP session the agent refused or
 * opened as it started; `discovery` is model discovery's own ACP handshake or
 * credential hook. Only `status` can answer `unknown` over a verdict: a turn's
 * or a discovery's is evidence, and a status-less agent's probe is none.
 */
export type RunnerAuthSource = 'status' | 'turn' | 'discovery';

/** A recorded verdict with where it came from and when that evidence was asked for. */
export interface RunnerAuthEvidence {
  auth: RunnerAuth;
  source: RunnerAuthSource;
  /** The {@link runnerAuthClock} reading when the check began: a later one outranks it. */
  asOf: number;
}

export interface RecordRunnerAuthOptions {
  /** Defaults to `turn`: every caller but the status probe records what an agent answered in work. */
  source?: RunnerAuthSource;
  /**
   * When the check that produced it began, from {@link runnerAuthClock}. A
   * probe or discovery that overlapped a newer answer, or a user's recheck,
   * login or key since, is dropped rather than recorded over it. Defaults to
   * now, which is right for an answer that is already in.
   */
  asOf?: number;
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
const recorded = new Map<string, RunnerAuthEvidence>();
/** When a user's recheck or login last cleared each key, so an answer asked before it is not recorded after it. */
const clearedAt = new Map<string, number>();
/** When a saved key last cleared every signed-out verdict (ADR-0060, R9). */
let signedOutClearedAt = 0;
let clock = 0;

/** A monotonic reading to stamp a check with as it begins: what {@link RecordRunnerAuthOptions.asOf} takes. */
export function runnerAuthClock(): number {
  return ++clock;
}

function recordKey(runner: string, workspace?: string): string {
  // Resolved on both sides, since a request may name a relative workspace while
  // the installation it probed is keyed by the absolute one.
  return workspace ? `${resolve(workspace)}\u0000${runner}` : runner;
}

/**
 * Record `auth` unless the record already holds better evidence: an answer
 * asked before the one recorded, or before a user cleared it, is stale, and
 * a status probe's `unknown` never replaces what a turn or discovery said
 * (#46 F1: refresh and the TTL turned a refused Cursor back into a harmless
 * unknown, and the agent was offered and spawned again). Only a definitive
 * newer answer, a saved key, a finished login or an explicit recheck replace
 * such a verdict. Returns whether it was recorded.
 */
export function recordRunnerAuth(runner: string, auth: RunnerAuth, workspace?: string, options: RecordRunnerAuthOptions = {}): boolean {
  const key = recordKey(runner, workspace);
  const asOf = options.asOf ?? runnerAuthClock();
  const source = options.source ?? 'turn';
  if (asOf < (clearedAt.get(key) ?? 0)) return false;
  if (auth.state === 'signed-out' && asOf < signedOutClearedAt) return false;
  const held = recorded.get(key);
  if (held && asOf < held.asOf) return false;
  if (held && auth.state === 'unknown' && held.source !== 'status' && held.auth.state !== 'unknown') return false;
  recorded.set(key, { auth, source, asOf });
  return true;
}

export function recordedRunnerAuth(runner: string, workspace?: string): RunnerAuth | undefined {
  return recorded.get(recordKey(runner, workspace))?.auth;
}

/** The recorded verdict with its source, for a surface that words an agent's readiness (ADR-0052). */
export function recordedRunnerEvidence(runner: string, workspace?: string): RunnerAuthEvidence | undefined {
  return recorded.get(recordKey(runner, workspace));
}

/**
 * Forget one runner's verdict in one workspace, because its user asked to
 * look again: a login that finished, or an explicit recheck. What it said
 * before is no evidence about now, and an answer asked before this is not
 * recorded after it; the next probe, discovery or turn records its own. A
 * status-less agent then reads `unknown`, never signed in on a terminal's
 * exit alone.
 */
export function forgetRunnerAuth(runner: string, workspace?: string): void {
  const key = recordKey(runner, workspace);
  recorded.delete(key);
  clearedAt.set(key, runnerAuthClock());
}

/**
 * Forget every signed-out verdict, in every workspace. A provider key saved in
 * Ordewell can sign an agent in with no login of its own (ADR-0060, R9), so a
 * refusal recorded before it says nothing about the next start, which records
 * its own.
 */
export function forgetSignedOutRunnerAuth(): void {
  signedOutClearedAt = runnerAuthClock();
  for (const [key, held] of recorded) if (held.auth.state === 'signed-out') recorded.delete(key);
}

/** For tests: the record is process-wide, so one case's verdict must not decide the next's. */
export function resetRunnerAuth(): void {
  recorded.clear();
  clearedAt.clear();
  signedOutClearedAt = 0;
}
