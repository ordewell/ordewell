import { BrowserWindow, dialog, type WebContents } from 'electron';
import type { LiveWorkKind, OpenWorkspaceOptions } from '../shared/bridge';
import type { LiveRun } from './daemon/liveRuns';
import { liveWorkReasons, openProject, parseLiveWork, type SwitchPorts } from './projectSwitch';
import type { RecentsStore } from './recents';
import { bringForward } from './testWindows';
import { workspaceKey, type WindowManager } from './windows';

export interface ProjectOpenerDeps {
  windows: WindowManager;
  recents: RecentsStore;
  /** Every live run on the daemon, [] with none connected, undefined when it could not be checked. */
  liveRuns(): Promise<LiveRun[] | undefined>;
  /** How many of this page's terminals run a process. */
  busyTerminals(contentsId: number): number;
  /** The OS's own recents, the Dock's on macOS. */
  addRecentDocument?(path: string): void;
}

/**
 * Every way a folder is opened — the picker, a recent, a drop, the menu, the
 * Dock — goes through here, so each one focuses, switches or asks the same
 * way (projectSwitch.ts).
 */
export class ProjectOpener {
  private readonly reported = new Map<number, LiveWorkKind[]>();
  private readonly watched = new Set<number>();
  /** Windows with a picker up: the menu's Ctrl+O and the switcher's item would each open one. */
  private readonly picking = new Set<number>();
  private readonly ports: SwitchPorts<BrowserWindow>;

  constructor(private readonly deps: ProjectOpenerDeps) {
    const { windows, recents } = deps;
    this.ports = {
      keyOf: workspaceKey,
      workspaceOf: (win) => windows.workspaceOf(win),
      windowOf: (key) => windows.windowOf(key),
      focus: (win) => bringForward(win),
      openNew: (key) => { windows.openWorkspace(key, { closeWelcome: false }); },
      switchTo: (win, key) => { windows.switchWorkspace(win, key); },
      liveWork: async (win, workspace) => {
        const runs = await deps.liveRuns();
        return liveWorkReasons({
          reported: this.reported.get(win.webContents.id) ?? [],
          runs: runs?.filter((run) => workspaceKey(run.workspace) === workspace),
          busyTerminals: deps.busyTerminals(win.webContents.id),
        });
      },
      ask: async (win, prompt) => {
        const answer = await dialog.showMessageBox(win, {
          type: 'question',
          message: prompt.message,
          detail: prompt.detail,
          buttons: [prompt.confirmLabel, 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return answer.response === 0;
      },
      remember: (key) => {
        recents.touch(key);
        deps.addRecentDocument?.(key);
      },
    };
  }

  /** What a page has live now; it lasts until the page reports again or navigates away. */
  report(contents: WebContents, value: unknown): void {
    const id = contents.id;
    this.reported.set(id, parseLiveWork(value));
    if (this.watched.has(id)) return;
    this.watched.add(id);
    contents.on('destroyed', () => { this.reported.delete(id); this.watched.delete(id); });
    contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) this.reported.delete(id); });
  }

  /** The native folder picker, then `open`; undefined when the person cancelled either. */
  async pick(from: BrowserWindow | undefined, options: OpenWorkspaceOptions = {}): Promise<string | undefined> {
    const dialogOptions = { title: 'Open Folder', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const id = from?.id ?? 0;
    if (this.picking.has(id)) return undefined;
    this.picking.add(id);
    let chosen: string | undefined;
    try {
      const picked = from ? await dialog.showOpenDialog(from, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      chosen = picked.canceled ? undefined : picked.filePaths[0];
    } finally {
      this.picking.delete(id);
    }
    return chosen ? this.open(from, chosen, options) : undefined;
  }

  /** Open a folder the person chose in `from`; the key it opened, or undefined when they cancelled. */
  async open(from: BrowserWindow | undefined, path: string, options: OpenWorkspaceOptions = {}): Promise<string | undefined> {
    const live = from && !from.isDestroyed() ? from : undefined;
    const outcome = await openProject(this.ports, { from: live, path, newWindow: options.newWindow === true });
    if (outcome === 'cancelled') return undefined;
    // The welcome window is where a folder is chosen from, not a place to come back to.
    if (live && this.deps.windows.isWelcome(live)) live.close();
    return workspaceKey(path);
  }
}
