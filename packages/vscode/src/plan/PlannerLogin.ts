import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { augmentedPath, describeSignInWays, ExecutableNotFoundError, inProcessProvider, isExecutableResolved, planDirectLaunch, providerRunnerLoginNote, recheckRunnerSignIn, runnerForProvider, TERMINAL_UI_SIGN_IN, withPath, workspaceEnvOf, type INotification, type LaunchDeps, type ModelResolver, type PlannerBackendId, type RunnerInstallation, type RunnerRegistry } from '@ordewell/core';
import type { HostToWebview } from '@ordewell/ui/protocol';

const POLL_MS = 2_000;
/** Long enough for a browser OAuth or a device code, short enough to end a forgotten one. */
const TIMEOUT_MS = 5 * 60_000;

const CLOSED_MESSAGE = 'The terminal closed before sign-in finished.';
const TIMEOUT_MESSAGE = 'Sign-in did not finish in time.';
const TERMINAL_FAILED_MESSAGE = 'The login terminal could not be opened.';
const TERMINAL_LOST_MESSAGE = 'The login terminal stopped before sign-in finished.';
const PROBE_FAILED_MESSAGE = "The sign-in could not be checked: the agent's status probe failed.";

export interface PlannerLoginDeps {
  runnerInstallation: Pick<RunnerInstallation, 'runnerUsability' | 'refresh' | 'recheck'>;
  /** The workspace's catalog, whose ACP handshake rechecks an agent with no status command (ADR-0052). */
  modelResolver?: Pick<ModelResolver, 'rediscoverRunner'>;
  /** Only to name the agent and refuse an id the host does not know. */
  runnerRegistry: Pick<RunnerRegistry, 'getManifest'>;
  config: { readonly aiProvider: PlannerBackendId };
  workspaceRoot: () => string;
  /**
   * The workspace's own variables (ADR-0016), for the terminal the login runs
   * in. Injectable so a test needs no `.envrc` on disk.
   */
  env?: (root: string) => Promise<Record<string, string>>;
  /** Push the fresh planner list, so the pill and the empty state redraw without the flag. */
  sendState: () => Promise<void>;
  post: (msg: HostToWebview) => void;
  notifications: Pick<INotification, 'info' | 'warn'>;
  /** The terminal to run the login in, and the word that the user closed it. */
  window: Pick<typeof vscode.window, 'createTerminal' | 'onDidCloseTerminal'>;
  /** Awaited between polls; injectable so tests never wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the timeout is measured against; injectable with `sleep`. */
  now?: () => number;
  /** The poll interval and the budget, each overridable by a test. */
  pollMs?: number;
  timeoutMs?: number;
  /** The host OS, which picks how the login is started; a test pins either from any host. */
  platform?: NodeJS.Platform;
  /**
   * How the agent's file is found, as its probe and spawn find it; a test
   * points it at stand-ins. Off Windows, `exists` is whether a file may be run.
   */
  launch?: Omit<LaunchDeps, 'platform'>;
  log?: (msg: string) => void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the login terminal starts: the agent's own file and its arguments, with no shell between. */
interface LoginLaunch {
  shellPath: string;
  shellArgs: string[] | string;
  PATH: string;
}

/** The first file on `PATH` named `command`, as execvp picks it when the probe spawns the agent. */
function onPosixPath(command: string, PATH: string, runnable: (candidate: string) => boolean): string | undefined {
  if (command.includes('/')) return runnable(command) ? command : undefined;
  return PATH.split(path.posix.delimiter).map((d) => d.trim()).filter(Boolean)
    .map((dir) => path.posix.join(dir, command))
    .find(runnable);
}

/** A file execvp would start: there, and executable by this user. */
function runnableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The login as the terminal's own process (#62 F1). Typed into the user's
 * shell it was never seen to end, since the shell outlives it; and the shell
 * found the name again after its startup files ran, which may pick another
 * binary than the probe did (#62 F3). So the file is resolved here on the
 * probe's augmented PATH: absolute on POSIX, and on Windows by the same
 * routes a spawn takes (ADR-0010), so an npm `.cmd` shim starts its target and
 * a lone `.cmd` goes through cmd.exe, whose line is handed over verbatim.
 */
async function loginLaunch(argv: readonly string[], platform: NodeJS.Platform, launch: Omit<LaunchDeps, 'platform'>): Promise<LoginLaunch> {
  const [command, ...args] = argv;
  const PATH = await (launch.resolvePath ?? augmentedPath)();
  const deps: LaunchDeps = { ...launch, platform, resolvePath: async () => PATH };
  if (platform !== 'win32') {
    const file = onPosixPath(command, PATH, deps.exists ?? runnableFile);
    if (!file) throw new ExecutableNotFoundError(command, PATH);
    return { shellPath: file, shellArgs: args, PATH };
  }
  const plan = await planDirectLaunch(command, args, deps);
  if (!isExecutableResolved(command, plan, PATH, deps)) throw new ExecutableNotFoundError(command, PATH);
  // VS Code takes a string of arguments on Windows as one command line, as is.
  return { shellPath: plan.file, shellArgs: plan.verbatim ? plan.args.join(' ') : plan.args, PATH };
}

/**
 * Sign a coding agent in from the chat (ADR-0009): run the runner's own login
 * in an integrated terminal, because every one of them is interactive — a
 * browser, a device code, a pasted one — and none can run in the extension
 * host's stdio.
 *
 * The login belongs to an agent, not to the planner choice: a named runner is
 * signed in without switching to it, and no path writes `config.aiProvider`.
 * Only fresh evidence decides it worked: the agent's status command while it
 * runs, then once more, or its handshake where it has none, once the login
 * exits 0. Five minutes without an end closes the login, and every end other
 * than a confirmed sign-in is a failure the surface shows inline, never a
 * silent success.
 */
export async function loginPlanner(deps: PlannerLoginDeps, runnerId?: string): Promise<void> {
  const runner = runnerId ?? runnerForProvider(deps.config.aiProvider) ?? undefined;
  // A webview names a runner in free text: only one the registry holds is a
  // login Ordewell may run.
  const manifest = runner === undefined ? undefined : deps.runnerRegistry.getManifest(runner);
  if (!runner || !manifest) {
    if (runnerId !== undefined) {
      deps.log?.(`Ignored a login for the unknown coding agent "${runnerId}".`);
      return;
    }
    // The active planner is a vendor: `/login` has nothing to hand a terminal.
    const message = 'The active planner is not a coding agent; there is no login to run.';
    deps.post({ type: 'plannerLoginEnded', ok: false, message });
    deps.notifications.info(message);
    return;
  }

  const label = manifest.displayName;
  let usability: Awaited<ReturnType<PlannerLoginDeps['runnerInstallation']['runnerUsability']>>;
  try {
    usability = await deps.runnerInstallation.runnerUsability(runner);
  } catch (err) {
    // A webview clears its pending button only on `plannerLoginEnded`; a throw
    // here would leave it waiting until a reload.
    deps.log?.(`The ${label} status probe failed before login: ${err instanceof Error ? err.message : String(err)}`);
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message: PROBE_FAILED_MESSAGE });
    deps.notifications.warn(`Ordewell could not check the ${label} login. ${PROBE_FAILED_MESSAGE}`);
    return;
  }
  if (!usability.usable) {
    // The CLI exists but cannot be spawned (a Windows `.cmd` shim, for one).
    // Saying it has no login would be false: the reason is the real answer.
    const message = usability.reason ?? `${label} is not usable.`;
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.info(message);
    return;
  }
  // A provider runner is signed in by the key that lists it (ADR-0070), so the way to change it is the key.
  const provider = inProcessProvider(manifest);
  if (provider) {
    const message = providerRunnerLoginNote(provider);
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.info(message);
    return;
  }
  const command = usability.auth?.loginCommand ?? [];
  if (command.length === 0) {
    // Nothing to run: say so, with the ways in it does have, as the terminal
    // UI's /login does (ADR-0052), and still close the surface's pending state.
    const ways = usability.auth?.signIn ? describeSignInWays(usability.auth.signIn, TERMINAL_UI_SIGN_IN) : '';
    const message = ways ? `${label} has no login Ordewell can run. ${ways}` : `Ordewell has no login for ${label}.`;
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.info(message);
    return;
  }

  const root = deps.workspaceRoot();
  const platform = deps.platform ?? process.platform;
  let launch: LoginLaunch;
  try {
    launch = await loginLaunch(command, platform, deps.launch ?? {});
  } catch (err) {
    // Not found, or a Windows shim that cannot carry the arguments: nothing
    // started, so the reason is the answer. Only its first line: the rest
    // lists every PATH folder searched, which is the log's to keep.
    const why = err instanceof Error ? err.message : String(err);
    deps.log?.(`Could not start the ${label} login: ${why}`);
    const message = `The ${label} login could not be started. ${why.split('\n')[0]}`;
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.warn(message);
    return;
  }
  let terminal: vscode.Terminal;
  try {
    terminal = deps.window.createTerminal({
      name: `${label} login`,
      cwd: root,
      shellPath: launch.shellPath,
      shellArgs: launch.shellArgs,
      // The agent's own account is chosen by the workspace environment
      // (ADR-0016), so the login must see the same one a spawn would, on the
      // PATH its file was found on: an agent run by `env node` finds that too.
      env: withPath({}, launch.PATH, await (deps.env ?? workspaceEnvOf)(root)),
      // A login that ended has nothing to come back to after a reload.
      isTransient: true,
    });
  } catch (err) {
    // The one failure the row cannot explain by itself: nothing opened to run
    // the login in, so the reason is the host's to say.
    deps.log?.(`Could not open a ${label} login terminal: ${err instanceof Error ? err.message : String(err)}`);
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message: TERMINAL_FAILED_MESSAGE });
    deps.notifications.info(`Could not open a terminal to sign in to ${label}.`);
    return;
  }
  let closed = false;
  const closedListener = deps.window.onDidCloseTerminal((t) => {
    if (t === terminal) closed = true;
  });
  // VS Code sets the exit status when the terminal's process ends, which is
  // now the login itself, then fires the close.
  const ended = (): boolean => closed || terminal.exitStatus !== undefined;

  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = now() + (deps.timeoutMs ?? TIMEOUT_MS);
  // Only a status command can confirm a login still running; an agent with
  // none answers nothing a poll could read, so its exit is what is waited for.
  const polls = (manifest.auth?.statusArgs?.length ?? 0) > 0;

  const end = async (ok: boolean, message?: string): Promise<void> => {
    if (ok) {
      // The probe cached its verdict; the login just changed it.
      deps.runnerInstallation.refresh();
      try {
        await deps.sendState();
      } catch (err) {
        // The login itself worked: reporting it as failed would be a lie. The
        // next state push redraws the pill.
        deps.log?.(`Planner state refresh after signing in to ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      deps.post({ type: 'plannerLoginEnded', runner, ok: true });
      deps.notifications.info(`Signed in to ${label}.`);
      return;
    }
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, ...(message ? { message } : {}) });
    deps.notifications.warn(`Ordewell could not confirm the ${label} login. ${message ?? 'It ended without an answer.'}`);
  };

  let outcome: { ok: boolean; message?: string };
  try {
    // In view and focused: the login's prompts, device code or browser link
    // are the user's to read and answer.
    terminal.show();

    let signedIn = false;
    let probeFailed = false;
    while (!ended() && now() < deadline) {
      await sleep(pollMs);
      // Ended while we waited: polling a login that is over would only delay the answer.
      if (ended()) break;
      if (!polls) continue;
      // Refresh before every look: a cached verdict would hide a login that
      // finished within the last half minute.
      deps.runnerInstallation.refresh();
      try {
        if ((await deps.runnerInstallation.runnerUsability(runner)).auth?.state === 'signed-in') {
          signedIn = true;
          break;
        }
      } catch (err) {
        // The login is still running; only the status probe failed.
        deps.log?.(`The ${label} status probe failed during login: ${err instanceof Error ? err.message : String(err)}`);
        probeFailed = true;
        break;
      }
    }
    if (signedIn) outcome = { ok: true };
    else if (probeFailed) outcome = { ok: false, message: PROBE_FAILED_MESSAGE };
    else if (!ended()) {
      // A login left waiting is ended with its terminal, so nothing outlives
      // the attempt that started it.
      terminal.dispose();
      outcome = { ok: false, message: TIMEOUT_MESSAGE };
    } else {
      const code = terminal.exitStatus?.code;
      // Only a login that finished is a recheck (ADR-0052): one that failed or
      // was closed keeps the blocker it was started to clear.
      outcome = code === 0 ? await recheckAfterLogin(deps, runner, label)
        : { ok: false, message: code === undefined ? CLOSED_MESSAGE : `The ${label} login exited with code ${code}.` };
    }
  } catch (err) {
    // A terminal disposed between create and show must still end the attempt:
    // the webview clears its pending button only on `plannerLoginEnded`, and
    // would leave it disabled until a reload.
    deps.log?.(`The ${label} login terminal failed: ${err instanceof Error ? err.message : String(err)}`);
    outcome = { ok: false, message: TERMINAL_LOST_MESSAGE };
  } finally {
    closedListener.dispose();
  }
  await end(outcome.ok, outcome.message);
}

/**
 * The login process exited 0: ask for fresh evidence, and only that answer is
 * the verdict (ADR-0052, #46 F7), since a login can print success and persist
 * nothing. What was recorded is forgotten, then a status command answers for
 * itself and an agent with none is asked by its own handshake, whose refusal
 * records the blocker again.
 */
async function recheckAfterLogin(deps: PlannerLoginDeps, runner: string, label: string): Promise<{ ok: boolean; message?: string }> {
  const installation = deps.runnerInstallation;
  let state: string | undefined;
  try {
    state = (await recheckRunnerSignIn(runner, {
      installation: { refresh: () => installation.refresh(), recheck: (r) => installation.recheck(r), runnerUsability: (r) => installation.runnerUsability(r) },
      ...(deps.modelResolver ? { resolver: deps.modelResolver } : {}),
      manifests: deps.runnerRegistry,
    })).auth?.state;
  } catch (err) {
    deps.log?.(`The ${label} recheck after login failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, message: PROBE_FAILED_MESSAGE };
  }
  if (state === 'signed-in') return { ok: true };
  // What the recheck recorded changed what both roles show, signed in or not.
  try {
    await deps.sendState();
  } catch (err) {
    deps.log?.(`Planner state refresh after the ${label} recheck failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return state === 'signed-out'
    ? { ok: false, message: `${label} still reports not logged in.` }
    : { ok: false, message: `The login finished, but ${label} cannot say whether it is signed in. Send again to try it.` };
}
