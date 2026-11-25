import * as vscode from 'vscode';

/**
 * The one place the extension reads which project the window holds: the first
 * open folder, as every surface reads a multi-root workspace (ADR-0014), read
 * live. Undefined in an empty window, one with only a loose file open, and a
 * workspace whose last folder was removed. Never the extension host's cwd:
 * VS Code started from the Dock or Finder has `/` there, and every window
 * shares it (task #47).
 */
export function workspaceFolderRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export const NO_WORKSPACE_FOLDER = 'Ordewell needs an open folder to plan in. Open a folder, then send your message again.';
const OPEN_FOLDER = 'Open Folder';

/**
 * Admit an operation that creates or resumes a project-backed session (a
 * planner turn, a load, an Execute) only with a folder open. Refused, the user
 * is told once and offered VS Code's own Open Folder; nothing is written and
 * no session, lease or planner is touched. Not awaited: the caller goes on to
 * hand the draft back while the notification stays up.
 */
export function admitWorkspaceFolder(): boolean {
  return requireWorkspaceFolder() !== undefined;
}

/** {@link admitWorkspaceFolder} for a caller that reads the project itself: its root, or undefined once refused. */
export function requireWorkspaceFolder(): string | undefined {
  const root = workspaceFolderRoot();
  if (root !== undefined) return root;
  void Promise.resolve(vscode.window.showWarningMessage(NO_WORKSPACE_FOLDER, OPEN_FOLDER)).then((picked) => {
    if (picked === OPEN_FOLDER) return vscode.commands.executeCommand('vscode.openFolder');
    return undefined;
  });
  return undefined;
}
