import { execSync } from 'child_process';

/** One shared tmux session per daemon, scoped by port so multiple daemons never collide. */
export function tmuxSessionName(port: number): string {
  return `ordewell-${port}`;
}

/**
 * Each daemon gets its own tmux *server*, not just its own session name.
 *
 * A plain `tmux new-session` attaches to whatever server already owns the
 * default socket, and a session created on an existing server inherits that
 * **server's** environment — not the environment of the process that asked for
 * it (tmux only refreshes `update-environment` vars, and only on attach). So a
 * daemon started with, say, a particular provider API key would silently hand
 * its runners a stale key left behind by whoever started the server first,
 * possibly hours earlier under a different configuration entirely.
 *
 * A private socket makes the server a child of this daemon, so the runner
 * inherits the daemon's environment the way any child process would, and
 * `kill-server` at shutdown is authoritative — a runner cannot outlive the
 * daemon by hiding on a shared server. Users attaching by hand need the same
 * flag: `tmux -L ordewell-<port> attach -t ordewell-<port>`.
 */
export function tmuxSocketName(port: number): string {
  return `ordewell-${port}`;
}

const slug = (text: string) => text.replace(/[^a-zA-Z0-9]/g, '');

/**
 * tmux window targeting breaks on `:` and other punctuation, so ids are
 * slugged. Task ids are only unique within one plan ("task-1" is every
 * planner's favourite), so the window is also scoped by the plan session id —
 * without it, the second plan run in a daemon's lifetime would collide with
 * the first plan's still-open windows and pipe its output into the wrong one.
 */
export function tmuxWindowName(taskId: string, planSessionId?: string): string {
  const scope = planSessionId ? `${slug(planSessionId).slice(-6)}-` : '';
  return `t-${scope}${slug(taskId).slice(0, 16)}`;
}

export type ProbeFn = () => void;

const defaultProbe: ProbeFn = () => {
  execSync(process.platform === 'win32' ? 'where tmux' : 'which tmux', { stdio: 'ignore' });
};

/** Feature-detects tmux the same way `HeadlessRunner` detects `script`. */
export function hasTmux(probe: ProbeFn = defaultProbe): boolean {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}
