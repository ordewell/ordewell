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
 *
 * The agent's PTY is `script`'s, allocated off a pipe, so its window size is
 * whatever `stty` set before the agent started. That size comes from the tab's
 * own dimensions at `open` — a TUI told it is 0x0 (the pipe default) renders as
 * garbage. Later resizes flow through `script`'s control channel (fd 3): the
 * wrapper's watcher calls `stty` on the PTY slave, which reflows the TUI just
 * as a real terminal resize would.
 */
export class VsCodeTerminalRunner extends HeadlessRunner {
  protected override readonly defaultInteractive = true;

  private terminals = new Map<string, vscode.Terminal>();

  override async spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession> {
    const shortId = opts.taskId.slice(0, 8);
    const id = `ordewell-${shortId}`;
    const session = this.createSession(id, opts.taskId);
    // Resolve and validate now — an unknown runner or an unlaunchable command
    // must hold the task (TaskOrchestrator.startTask) rather than throw from
    // inside `open`, which nothing can catch.
    await this.prepareLaunch(opts);

    const cwd = opts.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();

    // Deferred so the agent inherits the tab's real dimensions: `script`
    // allocates its PTY at 0x0 off a pipe, and a TUI reads COLUMNS/LINES as its
    // fallback. `session.start` is idempotent, so the timeout below is a
    // no-op once `open` has fired.
    const start = async (dimensions?: vscode.TerminalDimensions) => {
      try {
        const cols = dimensions?.columns ?? DEFAULT_COLUMNS;
        const rows = dimensions?.rows ?? DEFAULT_ROWS;
        const prepared = await this.prepareLaunch(opts, {
          size: { cols, rows },
          // Only meaningful when script is present; wrapWithPty ignores it otherwise.
          controlChannel: true,
        });
        session.start(
          prepared.launch,
          cwd,
          prepared.resolvedPath,
          {
            ...prepared.env,
            COLUMNS: String(cols),
            LINES: String(rows),
          },
          prepared.pty ? { controlChannel: true } : undefined,
        );
      } catch (err) {
        // The validation call above makes this unreachable for the usual
        // failures (unknown runner, overlong command). A transient error must
        // not leave the task hanging silently inside `open` — nothing can catch
        // a rejection from there, so surface it and close the tab.
        clearTimeout(fallback);
        writeEmitter.fire(`\r\n\x1b[31m[ordewell] failed to start ${opts.runner}: ${(err as Error).message}\x1b[0m\r\n`);
        closeEmitter.fire(1);
      }
    };

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
      // Fired whenever the panel's rows/columns change (resize, font size, …).
      // Forwarded to the wrapper's watcher, which runs `stty` on the PTY slave —
      // that sends SIGWINCH to the agent's foreground group, so the TUI reflows
      // exactly like a native terminal.
      setDimensions: (d) => session.writeControl?.(`${d.columns} ${d.rows}\n`),
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
