import { ApiClient, ensureDaemonOwned, resolvePort, stopDaemon } from '../daemonClient';
import { flag } from '../utils';
import { findEnvFile, writeEnvVar } from '../utils/env';
import { createApp } from './app';
import { ConversationQueue, runEffect, type OrdewellApi } from './effects';
import { openTerminal } from './terminal';
import { openTaskTerminal } from './terminalLauncher';

/**
 * `ordewell tui` — the full-screen terminal client. It drives the same daemon
 * the VS Code extension and the web UI use, so a plan started here can be
 * picked up anywhere else.
 */
export async function handleTui(subArgs: string[]): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('The TUI needs an interactive terminal. Use `ordewell plan` for scripted runs.');
    process.exit(1);
  }

  const workspace = flag(subArgs, '--workspace') || process.cwd();
  const { port, owned: ownedAtLaunch } = await ensureDaemonOwned(resolvePort(subArgs), { detached: false });
  // Not const: a daemon we did not start can die and be replaced by one we
  // did, and only the one we started may be stopped on the way out.
  let owned = ownedAtLaunch;
  const api = new ApiClient(port) as unknown as OrdewellApi;
  const conversationQueue = new ConversationQueue();

  // eslint-disable-next-line prefer-const
  let terminal: ReturnType<typeof openTerminal> | undefined;

  // Mirror BaseConfig.autonomousMode so the badge starts truthful when
  // ORDEWELL_AUTONOMOUS_MODE is already set in the environment or .env.
  const autoMode = process.env.ORDEWELL_AUTONOMOUS_MODE;
  // Opt-in, and remembered across launches once opted in — see terminal.ts for
  // why capturing the mouse is not the default.
  const mouseCapture = process.env.ORDEWELL_TUI_MOUSE === 'true' || process.env.ORDEWELL_TUI_MOUSE === '1';

  const app = createApp({
    initial: { workspace, autonomous: autoMode !== 'false' && autoMode !== '0', mouseCapture },
    draw: (frame) => terminal?.draw(frame),
    perform: (effect) =>
      runEffect(effect, {
        api,
        workspace,
        conversationQueue,
        port,
        dispatch: (action) => app.dispatch(action),
        newSessionId: () => `session-${Date.now()}`,
        setEnvVar: (key, value) => {
          writeEnvVar(findEnvFile(), key, value);
          process.env[key] = value;
        },
        openTerminal: (sessionId, taskId) => openTaskTerminal(port, sessionId, taskId),
        setMouseCapture: (enabled) => terminal?.setMouse(enabled),
        reviveDaemon: async () => {
          // `quiet`, because this runs with the full-screen frame on the
          // terminal — the usual "Starting daemon..." lines would be painted
          // into it. `detached: false` matches launch, so the replacement dies
          // with this TUI exactly as the original would have.
          const { owned: freshlyOwned } = await ensureDaemonOwned(port, { detached: false, quiet: true });
          if (freshlyOwned) owned = true;
          return true;
        },
        exit: () => shutdown(0),
      }),
    onExit: () => shutdown(0),
  });

  terminal = openTerminal({
    mouse: mouseCapture,
    onKey: (key) => app.dispatch({ type: 'key', key }),
    onResize: (rows, cols) => app.dispatch({ type: 'resize', rows, cols }),
  });

  const { rows, cols } = terminal.size();
  app.dispatch({ type: 'resize', rows, cols });
  app.start();

  // A daemon this TUI spawned dies with it — tasks mid-flight are abandoned,
  // not reconciled; the next launch respawns a fresh daemon and reloads the
  // saved plan, which normalizes any still-'in_progress' task back to
  // 'pending' so the scheduler just reruns it from scratch.
  function shutdown(code: number): void {
    terminal?.close();
    if (owned) stopDaemon(port).catch(() => {});
    process.exit(code);
  }

  // Restore the terminal even if something below us throws, the shell kills
  // us, or the terminal itself closes (SIGHUP) — and either way, take our
  // daemon down with us.
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  process.on('uncaughtException', (err) => {
    console.error(`Fatal: ${err.message}`);
    shutdown(1);
  });

  // Hold the process open; the key listener drives everything from here.
  await new Promise<never>(() => {});
}
