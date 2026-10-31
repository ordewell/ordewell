import { spawn } from 'child_process';
import { resolve } from 'path';
import { assertWorkspaceExists, augmentedPath, createSkillsService, EnvConfig, mintSessionId, planDirectLaunch, SettingsService, withPath, workspaceEnvOf } from '@ordewell/core';
import { ensureDaemonOwned, findFreePort, resolvePort, stopDaemon } from '../daemon';
import { ApiClient } from '../apiClient';
import { flag, saveLastSession } from '../utils';
import { findEnvFile, writeEnvVar } from '../utils/env';
import { createApp } from './app';
import { runEffect } from './effects';
import { registerSkillCommands } from './slash';
import { openTerminal } from './terminal';
import { startCliVersionCheck } from '../versionCheck';

/** Past the stop's own two-second check that the port's daemon is the one it means to signal. */
const DAEMON_STOP_GRACE_MS = 3000;

/** The one child-process seam a login needs, so a test drives it instead of starting an agent. */
export type LoginSpawn = typeof spawn;

/**
 * Run a runner's login command on this tty and settle when it exits. A missing
 * binary rejects, because nothing was started; a non-zero exit is an answer.
 * The launch plan is the same one every other agent spawn uses, so a Windows
 * `.cmd`/`.ps1` shim that `planDirectLaunch` knows how to start does not fail
 * here with an ENOENT the probe never reported.
 */
async function runLogin(
  start: LoginSpawn,
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const plan = await planDirectLaunch(command[0], command.slice(1));
  return new Promise((resolve, reject) => {
    const child = start(plan.file, plan.args, {
      stdio: 'inherit',
      cwd,
      env,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export interface HandleTuiOptions {
  /** Injected so a test drives the login without starting a real coding agent. */
  spawn?: LoginSpawn;
}

/**
 * `ordewell tui` — the full-screen terminal client. By default each launch
 * gets its own private daemon, so two terminals never share a session list.
 * Pass `--port`/`ORDEWELL_PORT` to instead drive the well-known daemon other
 * CLI invocations use, so a plan started here can be picked up from another
 * terminal. (The VS Code extension runs core's `Session` in-process; a plan
 * travels between it and the terminal through the saved-session store, not the
 * daemon.)
 */
export async function handleTui(subArgs: string[], options: HandleTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('The TUI needs an interactive terminal. Use `ordewell plan` for scripted runs.');
    process.exit(1);
  }

  // Resolved once: the daemon is started with this as its cwd, so a relative
  // `--workspace` sent on every request would be resolved again against it.
  const workspace = resolve(flag(subArgs, '--workspace') || process.cwd());
  try {
    assertWorkspaceExists(workspace);
  } catch {
    // A shell whose own cwd was deleted still reports the stale path here —
    // `process.cwd()` returns a string, not a live handle — so this is the
    // one place that catches it before it turns into a pile of unrelated
    // ENOENTs from every tool the TUI tries to use.
    console.error(
      `Workspace "${workspace}" does not exist.\n\n` +
      `cd into a directory that exists, or pass --workspace <path> naming one that does.`,
    );
    process.exit(1);
  }
  // Skills become slash commands for this run: completions, Tab, and dispatch
  // all read from the one registry in slash.ts (registerSkillCommands).
  const discoveredSkills = createSkillsService(workspace, new EnvConfig().workspaceRepos).listSkills();
  registerSkillCommands(discoveredSkills);
  // A user-only skill is still attachable by hand, so no userInvocable filter.
  const taskSkills = discoveredSkills
    .filter((s) => s.appliesTo === 'task')
    .map((s) => ({ name: s.name, description: s.description }));

  // Two `tui` instances that both defaulted to DEFAULT_PORT would share one
  // daemon's process-wide session map, so a task added in one shows up live
  // in the other. Each unflagged launch instead gets its own daemon on a
  // free port, private by construction; `--port`/`ORDEWELL_PORT` opts back
  // into the shared daemon (e.g. to pick up a plan from another CLI or TUI).
  const explicitPort = flag(subArgs, '--port') || process.env.ORDEWELL_PORT;
  const targetPort = explicitPort ? resolvePort(subArgs) : await findFreePort();
  const { port, owned: ownedAtLaunch } = await ensureDaemonOwned(targetPort, { detached: false, cwd: workspace });
  // Not const: a daemon we did not start can die and be replaced by one we
  // did, and only the one we started may be stopped on the way out.
  let owned = ownedAtLaunch;
  const api = new ApiClient(port, workspace);

  // eslint-disable-next-line prefer-const
  let terminal: ReturnType<typeof openTerminal> | undefined;
  // While a login's child runs it owns the tty, and the Ctrl-C that cancels the
  // login is the child's too: the parent must not exit on it.
  let loginRunning = false;
  const spawnLogin = options.spawn ?? spawn;

  // On unless explicitly refused. It used to be opt-in, but the opt-in was
  // persisted per workspace (`.env`), so the wheel died again in every other
  // project — a setting nobody can keep track of. `/mouse off` still hands the
  // mouse back for drag-select, and this env var makes that stick.
  const mouseCapture = process.env.ORDEWELL_TUI_MOUSE !== 'false' && process.env.ORDEWELL_TUI_MOUSE !== '0';

  // Started once the daemon is up, with nothing awaited between here and
  // `createApp`: the notice is synchronous and lands in the first frame, and an
  // update line, which only a later tick can bring, always finds the app.
  let versionCheckNotice = '';
  startCliVersionCheck({
    onNotice: (text) => { versionCheckNotice = text; },
    onUpdate: (line) => app.dispatch({ type: 'notice', message: line }),
  });

  const settings = new SettingsService();
  const app = createApp({
    // The level the daemon plans with: the saved one, unless the environment overrides it (ADR-0030).
    // The run settings are seeded from the same file because the first frame is
    // drawn before the daemon answers, and the welcome's autorun line is only
    // truthful once they are known. That holds only for a daemon this process
    // spawned, which inherits its settings path; an attached one may read a
    // different file (ORDEWELL_SETTINGS_PATH), and nothing it reports names that
    // file, so the welcome stays silent until its own settings arrive.
    initial: {
      workspace,
      autonomous: settings.autonomousMode(),
      ...(ownedAtLaunch ? { runSettings: settings.getRunSettings(), runSettingsKnown: true } : {}),
      mouseCapture,
      taskSkills,
      versionCheckNotice,
    },
    draw: (frame) => terminal?.draw(frame),
    perform: (effect) =>
      runEffect(effect, {
        api,
        workspace,
        port,
        dispatch: (action) => app.dispatch(action),
        newSessionId: () => mintSessionId(),
        setEnvVar: (key, value) => {
          writeEnvVar(findEnvFile(), key, value);
          process.env[key] = value;
        },
        saveAutonomy: (enabled) => {
          const settings = new SettingsService();
          settings.setAutonomousMode(enabled);
          return { overridden: settings.autonomousModeOverridden() };
        },
        setMouseCapture: (enabled) => terminal?.setMouse(enabled),
        // A login is the one effect that needs the tty itself: the runner's own
        // command prompts for credentials, and nothing here may read or keep
        // them. The workspace env is resolved before the hand-over so a slow
        // direnv does not leave the user looking at a blank screen; then
        // suspend so the child owns every byte, and resume in a `finally` so a
        // missing binary or a throw cannot leave the alt screen and raw mode
        // behind.
        login: async (command) => {
          let handedOver = false;
          try {
            // The same PATH the probe and the planner spawn with, so a runner
            // found in ~/.local/bin can also run its login here.
            const env = withPath(process.env, await augmentedPath(), await workspaceEnvOf(workspace));
            loginRunning = true;
            handedOver = true;
            terminal?.suspend();
            const { code, signal } = await runLogin(spawnLogin, command, workspace, env);
            if (code === 0) return { ok: true };
            return {
              ok: false,
              message: signal
                ? `${command[0]} stopped (${signal}) without finishing the login.`
                : `${command[0]} exited with status ${code} without finishing the login.`,
            };
          } catch (err) {
            return { ok: false, message: `Could not run ${command[0]}: ${err instanceof Error ? err.message : String(err)}` };
          } finally {
            loginRunning = false;
            if (handedOver) {
              terminal?.resume();
              if (terminal) app.dispatch({ type: 'resize', ...terminal.size() });
            }
          }
        },
        // The alt screen is up with the cursor hidden, so an OSC 52 write shows
        // nothing — the terminal reads it and answers by taking the clipboard.
        writeTerminal: (data) => process.stdout.write(data),
        reviveDaemon: async () => {
          // `quiet`, because this runs with the full-screen frame on the
          // terminal — the usual "Starting daemon..." lines would be painted
          // into it. `detached: false` matches launch, so the replacement dies
          // with this TUI exactly as the original would have.
          const { owned: freshlyOwned } = await ensureDaemonOwned(port, { detached: false, quiet: true, cwd: workspace });
          if (freshlyOwned) owned = true;
          return true;
        },
        exit: () => shutdown(0),
      }),
    onExit: () => shutdown(0),
    // The same pointer `ordewell plan` leaves, so `ordewell handoff`,
    // The one-shot commands act on the session this
    // TUI is showing instead of saying there is none.
    onSessionChange: (sessionId, state) => {
      try {
        saveLastSession(sessionId, state.goal, state.runners.filter((r) => r.enabled).map((r) => r.id), workspace);
      } catch {
        /* a read-only workspace only costs the CLI its default */
      }
    },
  });

  terminal = openTerminal({
    mouse: mouseCapture,
    onKey: (key) => app.dispatch({ type: 'key', key }),
    onResize: (rows, cols) => app.dispatch({ type: 'resize', rows, cols }),
    onRepaint: () => {
      if (terminal) app.dispatch({ type: 'resize', ...terminal.size() });
    },
  });

  // The runners and the allowlist are saved in a file the extension host and
  // other TUIs write too; without this a toggle made there would flag tasks
  // here, and tick the pickers, against the old list until the next /refresh.
  const watchingSettings = settings.watch(() => app.dispatch({ type: 'sharedSettingsChanged' }));

  const { rows, cols } = terminal.size();
  app.dispatch({ type: 'resize', rows, cols });
  app.start();

  // A daemon this TUI spawned dies with it — tasks mid-flight are abandoned,
  // not reconciled; the next launch respawns a fresh daemon and reloads the
  // saved plan, which fails any still-'in_progress' task as interrupted, so
  // the inbox lists it and a retry or Execute reruns it from scratch.
  // The stop is awaited: exiting in the same tick abandons it before its first
  // request, leaving the daemon to notice the parent is gone on its own. A
  // daemon that does not answer only gets the grace below, and a second
  // signal while it is out exits at once.
  let exiting = false;
  function shutdown(code: number): void {
    if (exiting) return process.exit(code);
    exiting = true;
    watchingSettings.dispose();
    terminal?.close();
    if (!owned) return process.exit(code);
    const grace = setTimeout(() => process.exit(code), DAEMON_STOP_GRACE_MS);
    void stopDaemon(port).catch(() => {}).finally(() => {
      clearTimeout(grace);
      process.exit(code);
    });
  }

  // Restore the terminal even if something below us throws, the shell kills
  // us, or the terminal itself closes (SIGHUP) — and either way, take our
  // daemon down with us.
  process.on('SIGINT', () => {
    // A login's Ctrl-C is the child's: the tty sent it to the whole foreground
    // group, and quitting here would take the TUI down with a login the user
    // only meant to cancel. The child exits and `/login` resumes the screen.
    if (loginRunning) return;
    shutdown(0);
  });
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  // Ctrl-Z then `fg`: the shell had the terminal in between and handed back a
  // plain one — main screen, cursor shown, none of our modes, and in particular
  // no mouse tracking, which is why the wheel died until `/mouse` was toggled.
  // `reset()` owns the escapes; this only has to ask for them and repaint.
  process.on('SIGCONT', () => {
    terminal?.reset();
    const { rows: r, cols: c } = terminal?.size() ?? { rows: 24, cols: 80 };
    app.dispatch({ type: 'resize', rows: r, cols: c });
  });
  process.on('uncaughtException', (err) => {
    // Printed on the alternate screen the message would be wiped by the
    // ALT_SCREEN_OFF that close() sends; leave the screen first.
    terminal?.close();
    console.error(`Fatal: ${err.message}`);
    shutdown(1);
  });

  // Hold the process open; the key listener drives everything from here.
  await new Promise<never>(() => {});
}
