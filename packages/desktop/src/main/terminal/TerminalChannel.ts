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
}

export interface Caller {
  /** The window's number: terminals are reachable by the window that opened them. */
  owner: number;
  /** The window's own workspace, never one the page named. */
  workspace: string;
  send(id: number, event: TerminalEvent): void;
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export class TerminalChannel {
  constructor(private readonly deps: TerminalChannelDeps) {}

  async open(caller: Caller, raw: unknown): Promise<TerminalOpenResult> {
    if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'open takes { id, repo, scope, cols, rows }.' };
    const { id, repo, scope, cols, rows } = raw as Record<string, unknown>;
    const size = validSize(cols, rows);
    if (!validNumber(id) || !size) return { ok: false, message: 'open takes { id, repo, scope, cols, rows }.' };

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
