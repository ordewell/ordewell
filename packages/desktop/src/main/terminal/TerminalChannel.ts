import { planDirectLaunch, runnerSignIn, workspaceEnvOf } from '@ordewell/core';
import type { TerminalEvent, TerminalOpenResult } from '../../shared/bridge';
import { TerminalHost, validSize } from './TerminalHost';
import { placeTerminal, type PlacementDeps } from './placement';
import { shellFor, shellName, terminalEnv } from './shellChoice';

/**
 * The narrow channel behind `window.ordewell.terminal` (ADR-0062 G11): the four
 * calls a page may make about terminals, each re-checked, and the one thing
 * main sends back, tagged with the terminal's number. It holds no Electron
 * object; `ipc.ts` supplies the caller's window number, workspace and a way to
 * send, so these rules run under a plain test.
 */

export interface TerminalChannelDeps {
  host: TerminalHost;
  placement: PlacementDeps;
  platform: NodeJS.Platform;
  /** The environment a terminal inherits, with the PATH main resolved at start. */
  env(): Promise<NodeJS.ProcessEnv>;
  /** Where a login runs when the window has no checkout: the launcher's window. */
  home: string;
}

export interface Caller {
  /** The window's number: terminals are reachable by the window that opened them. */
  owner: number;
  /** The window's own workspace, never one the page named; absent for the launcher window. */
  workspace?: string;
  send(id: number, event: TerminalEvent): void;
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function loginOf(raw: Record<string, unknown>): { runner: string } | null {
  const login = raw.login;
  if (typeof login !== 'object' || login === null) return null;
  const runner = Reflect.get(login, 'runner');
  return typeof runner === 'string' && runner !== '' && runner.length < 128 ? { runner } : null;
}

export class TerminalChannel {
  constructor(private readonly deps: TerminalChannelDeps) {}

  async open(caller: Caller, raw: unknown): Promise<TerminalOpenResult> {
    if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'open takes { id, repo, scope, cols, rows }.' };
    const { id, repo, scope, cols, rows } = raw as Record<string, unknown>;
    const size = validSize(cols, rows);
    if (!validNumber(id) || !size) return { ok: false, message: 'open takes { id, repo, scope, cols, rows }.' };

    const login = (raw as Record<string, unknown>).login === undefined ? null : loginOf(raw as Record<string, unknown>);
    if ((raw as Record<string, unknown>).login !== undefined && !login) return { ok: false, message: 'login takes { runner }.' };
    if (login) return this.openLogin(caller, login.runner, repo, size, id);
    // A shell needs a checkout: the launcher may only open a login, in home.
    if (!caller.workspace) return { ok: false, message: 'Refused: this window has no workspace.' };

    const placed = await placeTerminal(this.deps.placement, caller.workspace, repo, scope);
    if (!placed.ok) return placed;

    const env = await this.deps.env();
    const shell = shellFor(this.deps.platform, env);
    try {
      this.deps.host.start({
        id,
        owner: caller.owner,
        file: shell.file,
        args: shell.args,
        cwd: placed.cwd,
        env: terminalEnv(env),
        ...size,
        send: caller.send,
      });
    } catch (err) {
      return { ok: false, message: `Could not start ${shellName(shell.file)}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, id, cwd: placed.cwd, shell: shellName(shell.file) };
  }

  /**
   * A coding agent's own login (ADR-0052): the argv core declares for it, run
   * directly rather than through a shell, in the window's checkout or, for the
   * launcher, in home. Every login flow is interactive, so the pty is the UI.
   */
  private async openLogin(caller: Caller, runner: string, repo: unknown, size: { cols: number; rows: number }, id: number): Promise<TerminalOpenResult> {
    const argv = runnerSignIn(runner)?.login;
    if (!argv || argv.length === 0) return { ok: false, message: `Ordewell has no login to run for ${runner}.` };

    let cwd = this.deps.home;
    if (caller.workspace) {
      const placed = await placeTerminal(this.deps.placement, caller.workspace, repo, { kind: 'checkout' });
      if (!placed.ok) return placed;
      cwd = placed.cwd;
    }

    let plan;
    try {
      plan = await planDirectLaunch(argv[0], argv.slice(1));
    } catch (err) {
      return { ok: false, message: `Could not start ${argv[0]}: ${err instanceof Error ? err.message : String(err)}` };
    }
    // The directory's own variables choose the account a runner signs in to
    // (ADR-0016), exactly as its status probe and spawn do.
    let workspaceEnv: Record<string, string> = {};
    try {
      workspaceEnv = await workspaceEnvOf(cwd);
    } catch {
      // An unreadable environment is no reason to refuse the login.
    }
    try {
      this.deps.host.start({
        id,
        owner: caller.owner,
        file: plan.file,
        args: plan.args,
        cwd,
        env: terminalEnv({ ...(await this.deps.env()), ...workspaceEnv }),
        ...size,
        send: caller.send,
      });
    } catch (err) {
      return { ok: false, message: `Could not start ${argv[0]}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, id, cwd, shell: argv[0] };
  }

  write(caller: Caller, id: unknown, data: unknown): void {
    this.deps.host.write(caller.owner, id, data);
  }

  resize(caller: Caller, id: unknown, cols: unknown, rows: unknown): void {
    this.deps.host.resize(caller.owner, id, cols, rows);
  }

  close(caller: Caller, id: unknown): void {
    this.deps.host.close(caller.owner, id);
  }
}
