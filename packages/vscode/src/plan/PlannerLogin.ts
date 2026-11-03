import type * as vscode from 'vscode';
import { augmentedPath, runnerForProvider, withPath, workspaceEnvOf, type INotification, type PlannerBackendId, type RunnerInstallation, type RunnerRegistry } from '@ordewell/core';
import type { HostToWebview } from '../shared/protocol';

const POLL_MS = 2_000;
/** Long enough for a browser OAuth or a device code, short enough to end a forgotten one. */
const TIMEOUT_MS = 5 * 60_000;

const CLOSED_MESSAGE = 'The terminal closed before sign-in finished.';
const TIMEOUT_MESSAGE = 'Sign-in did not finish in time.';
const TERMINAL_FAILED_MESSAGE = 'The login terminal could not be opened.';
const TERMINAL_LOST_MESSAGE = 'The login terminal stopped before sign-in finished.';
const PROBE_FAILED_MESSAGE = "The sign-in could not be checked: the agent's status probe failed.";

export interface PlannerLoginDeps {
  runnerInstallation: Pick<RunnerInstallation, 'plannerUsability' | 'refresh'>;
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
  /** The host OS, which picks the login terminal's shell; a test pins either from any host. */
  platform?: NodeJS.Platform;
  log?: (msg: string) => void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One argv item as the login terminal's shell reads it. The argv comes from the
 * runner's manifest, never from the webview, so this is about spaces rather
 * than an injection: cmd.exe takes a double-quoted run, a POSIX shell a
 * closed-then-escaped single quote.
 */
function shellQuote(arg: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  if (platform === 'win32') return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The manifest's login as one line for the login terminal's shell. */
export function commandLine(argv: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return argv.map((arg) => shellQuote(arg, platform)).join(' ');
}

/**
 * On Windows the login runs in cmd.exe whatever the user's default terminal
 * is. Windows PowerShell prefers an npm-installed agent's `.ps1` shim to the
 * `.cmd` beside it and, under the default Restricted execution policy, refuses
 * to run it, so the login died before the agent started. cmd.exe reaches the
 * `.cmd` or a native `.exe` through PATHEXT and has no execution policy.
 */
function loginShell(platform: NodeJS.Platform): { shellPath?: string } {
  return platform === 'win32' ? { shellPath: process.env.ComSpec || 'cmd.exe' } : {};
}

/**
 * Sign a coding agent in from the chat (ADR-0009): run the runner's own login
 * in an integrated terminal, because every one of them is interactive — a
 * browser, a device code, a pasted one — and none can run in the extension
 * host's stdio.
 *
 * The login belongs to an agent, not to the planner choice: a named runner is
 * signed in without switching to it, and no path writes `config.aiProvider`.
 * Only the agent's own status command decides it worked; a terminal that closes
 * or five minutes of polling ends the attempt as a failure the surface shows
 * inline, never as a silent success.
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
  let usability: Awaited<ReturnType<PlannerLoginDeps['runnerInstallation']['plannerUsability']>>;
  try {
    usability = await deps.runnerInstallation.plannerUsability(runner);
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
    const message = usability.reason ?? `${label} is not usable as a planner.`;
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.info(message);
    return;
  }
  const command = usability.auth?.loginCommand ?? [];
  if (command.length === 0) {
    // Nothing to run: say so, and still close the surface's pending state.
    const message = `Ordewell has no login for ${label}.`;
    deps.post({ type: 'plannerLoginEnded', runner, ok: false, message });
    deps.notifications.info(message);
    return;
  }

  const root = deps.workspaceRoot();
  const platform = deps.platform ?? process.platform;
  let terminal: vscode.Terminal;
  try {
    terminal = deps.window.createTerminal({
      name: `${label} login`,
      cwd: root,
      ...loginShell(platform),
      // The agent's own account is chosen by the workspace environment
      // (ADR-0016), so the terminal that logs in must see the same one a spawn
      // would. The PATH is the probe's augmented one too: a GUI-launched host
      // can find the agent with it and still not find it in a bare terminal.
      env: withPath({}, await augmentedPath(), await (deps.env ?? workspaceEnvOf)(root)),
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

  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = now() + (deps.timeoutMs ?? TIMEOUT_MS);

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
    terminal.show();
    terminal.sendText(commandLine(command, platform));

    let signedIn = false;
    let probeFailed = false;
    while (!closed && terminal.exitStatus === undefined && now() < deadline) {
      await sleep(pollMs);
      // Closed while we waited: the attempt is over, and polling a terminal
      // that is gone would only delay the answer.
      if (closed || terminal.exitStatus !== undefined) break;
      // Refresh before every look: a cached verdict would hide a login that
      // finished within the last half minute.
      deps.runnerInstallation.refresh();
      try {
        if ((await deps.runnerInstallation.plannerUsability(runner)).auth?.state === 'signed-in') {
          signedIn = true;
          break;
        }
      } catch (err) {
        // The terminal is still open; only the status probe failed.
        deps.log?.(`The ${label} status probe failed during login: ${err instanceof Error ? err.message : String(err)}`);
        probeFailed = true;
        break;
      }
    }
    outcome = signedIn
      ? { ok: true }
      : probeFailed
        ? { ok: false, message: PROBE_FAILED_MESSAGE }
        : { ok: false, message: closed || terminal.exitStatus !== undefined ? CLOSED_MESSAGE : TIMEOUT_MESSAGE };
  } catch (err) {
    // A terminal disposed between create and send must still end the attempt:
    // the webview clears its pending button only on `plannerLoginEnded`, and
    // would leave it disabled until a reload.
    deps.log?.(`The ${label} login terminal failed: ${err instanceof Error ? err.message : String(err)}`);
    outcome = { ok: false, message: TERMINAL_LOST_MESSAGE };
  } finally {
    closedListener.dispose();
  }
  await end(outcome.ok, outcome.message);
}
