import * as vscode from 'vscode';

import { HeadlessRunner, ITerminalSession, RunnerSpawnOptions } from '@ordewell/core';

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 30;
const OPEN_TIMEOUT_MS = 3000;

/** A terminal needs CRLF; PTY output already has it, piped output does not. */
function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

/**
 * Runs each task's agent as a child process this extension owns, and renders it
 * into a `Pseudoterminal` so the user still gets a terminal tab.
 *
 * The previous implementation was the other way round — VS Code owned the child
 * and the extension read its output back through `onDidWriteTerminalData`. That
 * is a proposed API, unresolvable in a Marketplace-installed extension, so
 * output was always empty there and `VerdictEngine` never saw a completion
 * marker. Owning the child means the output exists by construction.
 */
export class VsCodeTerminalRunner extends HeadlessRunner {
  protected override readonly defaultInteractive = true;

  private terminals = new Map<string, vscode.Terminal>();

  override async spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession> {
    const shortId = opts.taskId.slice(0, 8);
    const id = `ordewell-${shortId}`;
    const session = this.createSession(id, opts.taskId);
    const prepared = await this.prepareLaunch(opts);
    const cwd = opts.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();

    // Deferred so the agent inherits the tab's real dimensions: `script`
    // allocates its PTY at 0x0 off a pipe, and a TUI reads COLUMNS/LINES as its
    // fallback. `session.start` is idempotent, so the timeout below is a
    // no-op once `open` has fired.
    const start = (dimensions?: vscode.TerminalDimensions) => session.start(
      prepared.launch,
      cwd,
      prepared.resolvedPath,
      {
        ...prepared.env,
        COLUMNS: String(dimensions?.columns ?? DEFAULT_COLUMNS),
        LINES: String(dimensions?.rows ?? DEFAULT_ROWS),
      },
    );

    session.onOutput((text) => writeEmitter.fire(toCrlf(text)));
    session.onExit((code) => {
      if (code === 0) closeEmitter.fire(0);
      else writeEmitter.fire(`\r\n\x1b[33m[ordewell] ${opts.runner} exited with code ${code}\x1b[0m\r\n`);
    });

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: start,
      close: () => {
        this.terminals.delete(id);
        session.kill();
      },
      handleInput: (data) => session.write(data),
    };

    const terminal = vscode.window.createTerminal({
      name: `Ordewell: ${shortId}`,
      pty,
      iconPath: new vscode.ThemeIcon('rocket'),
      location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    });
    this.terminals.set(id, terminal);
    this.registerSession(id, session);
    terminal.show(false);

    // `open` only fires once VS Code renders the tab; if it never does, the task
    // would sit unstarted forever.
    const fallback = setTimeout(() => start(), OPEN_TIMEOUT_MS);
    session.onExit(() => clearTimeout(fallback));

    return session;
  }

  override stop(sessionId: string): void {
    super.stop(sessionId);
    this.disposeTerminal(sessionId);
  }

  override stopAll(): void {
    super.stopAll();
    for (const id of [...this.terminals.keys()]) this.disposeTerminal(id);
  }

  private disposeTerminal(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    try { terminal.dispose(); } catch { /* already gone */ }
  }
}
