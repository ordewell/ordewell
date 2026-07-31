import { execFile, execSync, spawn as nodeSpawn } from 'child_process';
import { promisify } from 'util';
import { hasTmux, tmuxSessionName, tmuxSocketName, tmuxWindowName } from '@ordewell/core';

export type SpawnFn = (command: string, args: string[]) => void;
export type ExecFileFn = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface TerminalLauncherDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hasTmuxImpl?: () => boolean;
  execFileImpl?: ExecFileFn;
  spawnImpl?: SpawnFn;
  which?: (bin: string) => boolean;
}

export interface OpenTerminalResult {
  ok: boolean;
  message: string;
}

const execFileAsync = promisify(execFile);
const defaultExecFile: ExecFileFn = async (command, args) => {
  const { stdout, stderr } = await execFileAsync(command, args);
  return { stdout: String(stdout), stderr: String(stderr) };
};
const defaultSpawn: SpawnFn = (command, args) => {
  nodeSpawn(command, args, { detached: true, stdio: 'ignore' }).unref();
};
const defaultWhich = (bin: string): boolean => {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Opens a real OS terminal window attached to a task's tmux window. This runs
 * entirely on the CLI's own machine — the daemon it talks to is always local
 * (`ensureDaemon` only ever binds 127.0.0.1) — so no server round trip is
 * needed to resolve the target; it's computed from `port` + `taskId` the same
 * way `TmuxRunner` names windows on the daemon side.
 */
export async function openTaskTerminal(
  port: number,
  planSessionId: string,
  taskId: string,
  deps: TerminalLauncherDeps = {},
): Promise<OpenTerminalResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const hasTmuxImpl = deps.hasTmuxImpl ?? hasTmux;
  const execFileImpl = deps.execFileImpl ?? defaultExecFile;
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const which = deps.which ?? defaultWhich;

  if (!hasTmuxImpl()) {
    return { ok: false, message: 'tmux is not installed — install it to get a real terminal per task.' };
  }

  const session = tmuxSessionName(port);
  // The daemon runs its tmux on a private socket, so every lookup and the
  // attach command the user ends up running must name it too — on the default
  // socket this daemon's session simply does not exist.
  const socket = tmuxSocketName(port);
  const base = tmuxWindowName(taskId, planSessionId);

  let windows: string[];
  try {
    const { stdout } = await execFileImpl('tmux', ['-L', socket, 'list-windows', '-t', session, '-F', '#{window_name}']);
    windows = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return { ok: false, message: 'No terminal session found for this daemon — is it still running?' };
  }

  const window = latestAttempt(windows, base);
  if (!window) {
    return { ok: false, message: "This task hasn't opened a terminal yet — it may still be pending." };
  }

  const manualHint = `tmux -L ${socket} attach -t ${session}:${window}`;
  // Each viewer gets its own *grouped* session linked to the daemon's session.
  // A grouped session shares the daemon's windows but keeps an independent
  // active-window, so opening a second terminal no longer yanks the first one
  // onto the new window. `destroy-unattached on` reaps the viewer session once
  // its terminal closes, so we don't leak one per ever-opened task.
  const viewer = `${session}-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const attachCmd =
    `tmux -L ${socket} new-session -d -s ${viewer} -t ${session} ` +
    `\\; set-option -t ${viewer} destroy-unattached on ` +
    `\\; select-window -t ${viewer}:${window} ` +
    `\\; attach-session -t ${viewer}`;
  const opened = launchTerminal(platform, env, which, spawnImpl, attachCmd);
  if (!opened) {
    return { ok: false, message: `Couldn't open a terminal window automatically — attach manually: ${manualHint}` };
  }
  return { ok: true, message: 'Opened a terminal for this task.' };
}

/**
 * Retries open fresh windows named `<base>-2`, `-3`, … and the user asking for
 * "the task's terminal" means the newest attempt, not the first failed one.
 */
function latestAttempt(windows: string[], base: string): string | null {
  let best: string | null = null;
  let bestAttempt = 0;
  for (const name of windows) {
    if (name === base && bestAttempt < 1) {
      best = name;
      bestAttempt = 1;
      continue;
    }
    const suffix = name.startsWith(`${base}-`) ? Number(name.slice(base.length + 1)) : NaN;
    if (Number.isInteger(suffix) && suffix > bestAttempt) {
      best = name;
      bestAttempt = suffix;
    }
  }
  return best;
}

function launchTerminal(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  which: (bin: string) => boolean,
  spawnImpl: SpawnFn,
  attachCmd: string,
): boolean {
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "${attachCmd.replace(/"/g, '\\"')}"`;
    spawnImpl('osascript', ['-e', script]);
    return true;
  }

  if (platform === 'win32') {
    if (which('wt.exe')) {
      spawnImpl('wt.exe', ['-w', '0', 'nt', 'bash', '-lc', attachCmd]);
      return true;
    }
    if (which('cmd.exe')) {
      spawnImpl('cmd.exe', ['/c', 'start', '""', 'bash', '-lc', attachCmd]);
      return true;
    }
    return false;
  }

  // Every other posix platform needs an actual display to pop a window into.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;

  const candidates: [string, string[]][] = [];
  if (env.TERMINAL) candidates.push([env.TERMINAL, ['-e', 'bash', '-lc', attachCmd]]);
  candidates.push(
    ['x-terminal-emulator', ['-e', 'bash', '-lc', attachCmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', attachCmd]],
    ['konsole', ['-e', 'bash', '-lc', attachCmd]],
    ['xfce4-terminal', ['-e', `bash -lc ${JSON.stringify(attachCmd)}`]],
    ['xterm', ['-e', 'bash', '-lc', attachCmd]],
  );

  for (const [bin, args] of candidates) {
    if (which(bin)) {
      spawnImpl(bin, args);
      return true;
    }
  }
  return false;
}
