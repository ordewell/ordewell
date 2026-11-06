import { app, dialog, shell, type BrowserWindow } from 'electron';

/**
 * The one switch that keeps a test run of the app off the user's screen: with
 * it set to `hidden`, no window is shown or focused, the app never activates
 * (so macOS does not switch Space to it), and nothing the OS would draw over
 * the user's work (a dialog, a notification, a browser, the tray) appears.
 * Every place main would bring a window forward asks this module instead of
 * calling `show()`/`focus()` itself, so the policy has one home.
 *
 * Only an unpackaged app honours it, as only a source checkout honours a dev
 * URL: a packaged app that obeyed an environment variable could be left
 * running with no window anyone can reach.
 */
export const TEST_WINDOWS_ENV = 'ORDEWELL_DESKTOP_TEST_WINDOWS';

/** Pure for the tests: whether this environment asks for hidden windows. */
export function wantsHiddenWindows(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  return !packaged && env[TEST_WINDOWS_ENV] === 'hidden';
}

export function windowsHidden(): boolean {
  return wantsHiddenWindows(process.env, app.isPackaged);
}

/**
 * Before anything else runs: an accessory app has no Dock icon and never
 * becomes the active application, so even a stray activation cannot pull the
 * user to another Space. Called at module load because the Dock icon appears
 * as soon as the process does.
 */
export function quietTestApp(): void {
  if (!windowsHidden()) return;
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
}

/** Show a new window once it can paint, which a hidden test run never does. */
export function showWhenReady(win: BrowserWindow): void {
  if (windowsHidden()) return;
  win.once('ready-to-show', () => win.show());
}

/** Bring an existing window forward: from the tray, the Dock, a notification or a second launch. */
export function bringForward(win: BrowserWindow): void {
  if (windowsHidden()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Whether the OS may be shown a tray icon or a notification. */
export function osSurfacesAllowed(): boolean {
  return !windowsHidden();
}

/**
 * A native dialog or an OS hand-off (a browser, Finder) is drawn by the OS over
 * whatever the user is doing, and nothing in a test run can answer it. The specs
 * that expect one stub it themselves (their assignment replaces these); this is
 * what a path they did not foresee meets. A dialog is answered with its first
 * button, as the tour's stub does, or cancelled where there is no button.
 */
export function suppressOsSurfaces(): void {
  if (!windowsHidden()) return;
  const refuse = (what: string): void => { console.warn(`[test windows] ${what} suppressed: a hidden test run has no one to answer it.`); };
  dialog.showMessageBox = (async () => { refuse('a message box'); return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
  dialog.showMessageBoxSync = (() => { refuse('a message box'); return 0; }) as typeof dialog.showMessageBoxSync;
  dialog.showOpenDialog = (async () => { refuse('an open dialog'); return { canceled: true, filePaths: [] }; }) as typeof dialog.showOpenDialog;
  dialog.showSaveDialog = (async () => { refuse('a save dialog'); return { canceled: true, filePath: '' }; }) as typeof dialog.showSaveDialog;
  dialog.showErrorBox = () => { refuse('an error box'); };
  shell.openExternal = async () => { refuse('opening a link'); };
  shell.openPath = async () => { refuse('opening a path'); return ''; };
  shell.showItemInFolder = () => { refuse('revealing a file'); };
}
