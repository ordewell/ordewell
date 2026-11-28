import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import {
  augmentedPath,
  DAEMON_CONTRACT,
  daemonLogPath,
  daemonPidFilePath,
  probeDaemon,
  readDaemonToken,
  readLiveHolder,
  resolveDaemonPort,
  stopDaemonAt,
  withPath,
} from '@ordewell/core/daemon-client';
import { EVENTS, type RecentWorkspace } from '../shared/bridge';
import { buildRequest, type RouteId, type RouteParams } from '../shared/routes';
import { DaemonManager } from './daemon/DaemonManager';
import { RENDERER_TIMING_SOURCE, rendererDelay } from './rendererTiming';
import { forkBundledDaemon, pidNamedIn } from './daemon/forkDaemon';
import { findLiveRuns, type LiveRun } from './daemon/liveRuns';
import { HolderConnections } from './daemon/holders';
import { DaemonProxy } from './daemon/proxy';
import { registerIpc } from './ipc';
import { TerminalChannel } from './terminal/TerminalChannel';
import { fileSystemPlacement } from './terminal/placement';
import { shellName } from './terminal/shellChoice';
import { TerminalHost, type PtySpawn } from './terminal/TerminalHost';
import { openWordLink } from './terminal/wordLink';
import { closePrompt, onLastWindowClosed, quitPrompt, restartPrompt, runsQuitStops, type QuitPrompt } from './lifecycle';
import { droppedFolder } from './droppedFolder';
import { launchAction, launchDataOf, OpenProjectsMemory, parseLaunchArgs, type LaunchData } from './launch';
import { menuTemplate } from './menu';
import { registerNewWindowEntries } from './osEntries';
import { ProjectOpener } from './projectOpener';
import { AttentionNotifier } from './notifications';
import { completeMacInstall } from './installCompletion';
import { StartupLog } from './startupLog';
import { PrefsStore } from './prefs';
import { RecentsStore } from './recents';
import { AUTO_UPDATE_ENABLED, UpdateController, autoUpdaterOf, type UpdaterPort } from './updater';
import { UpdateService } from './updates';
import { lockSession, lockWebContents, registerAppScheme, serveRenderer } from './security';
import { WindowManager } from './windows';
import { osSurfacesAllowed, quietTestApp, suppressOsSurfaces } from './testWindows';
import { APP_ORIGIN } from '../shared/csp';

// A dev URL is honoured only from a source checkout: a packaged app that read
// it from the environment could be pointed at any page with the bridge on.
const devUrl = !app.isPackaged ? process.env.ORDEWELL_DESKTOP_DEV_URL : undefined;
const devOrigin = devUrl ? new URL(devUrl).origin : undefined;

quietTestApp();
registerAppScheme();

// A second launch hands its own argv and directory over: Chromium may reorder
// or add to the argv `second-instance` carries.
const thisLaunch: LaunchData = { argv: [...process.argv], cwd: process.cwd() };
if (!app.requestSingleInstanceLock(thisLaunch)) {
  // One app per user, so one window per workspace holds across launches (H6).
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  const startupLog = new StartupLog(join(app.getPath('userData'), 'startup.log'));
  startupLog.record('launch', { version: app.getVersion(), arch: process.arch, packaged: app.isPackaged });
  app.on('browser-window-created', (_event, win) => {
    startupLog.record('window.created', { window: win.id });
    win.once('ready-to-show', () => startupLog.record('window.ready', { window: win.id }));
    win.webContents.on('did-finish-load', () => {
      startupLog.record('window.loaded', { window: win.id });
      void win.webContents.executeJavaScript(RENDERER_TIMING_SOURCE).catch(() => {});
    });
    win.webContents.on('console-message', (event) => {
      const delayMs = rendererDelay(event.message);
      if (delayMs !== undefined) startupLog.record('renderer.delayed', { window: win.id, delayMs });
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      startupLog.record('renderer.gone', { window: win.id, reason: details.reason, exitCode: details.exitCode });
    });
    win.on('unresponsive', () => startupLog.record('window.unresponsive', { window: win.id }));
    win.on('responsive', () => startupLog.record('window.responsive', { window: win.id }));
  });
  let lastTick = performance.now();
  const responsiveness = setInterval(() => {
    const now = performance.now();
    const delayMs = Math.round(now - lastTick - 1000);
    lastTick = now;
    if (delayMs >= 1000) startupLog.record('main.delayed', { delayMs });
  }, 1000);
  responsiveness.unref();
  // Filled in once each exists: the handlers wired before then find nothing to do.
  const late: { windows?: WindowManager; daemon?: DaemonManager; launch?: (data: LaunchData) => void; open?: (path: string) => void } = {};
  // A launch like `code <folder>`: before the app can open one, it is brought forward.
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    const data = launchDataOf(additionalData) ?? { argv, cwd: workingDirectory };
    if (late.launch) late.launch(data);
    else late.windows?.show();
  });
  // A folder from the Dock's recents, dropped on its icon or named to `open -a`:
  // it opens as one chosen in the menu would. Listened for at once, since a
  // cold start delivers it before the app is ready; until then it is held for
  // the first launch to open.
  const heldFolders: string[] = [];
  app.on('open-file', (event, path) => {
    event.preventDefault();
    const dropped = droppedFolder(path);
    if (!dropped.ok) return;
    if (late.open) late.open(dropped.path);
    else heldFolders.push(dropped.path);
  });

  // A GUI launch inherits launchd's or the desktop's PATH, which finds none of
  // the runners; the daemon this app forks inherits whatever is set here.
  startupLog.record('shell-path.started');
  const resolvedPath = augmentedPath().then((path) => {
    startupLog.record('shell-path.finished');
    return path;
  });
  await app.whenReady();
  startupLog.record('app.ready');
  suppressOsSurfaces();

  lockSession(devOrigin);
  lockWebContents();
  if (!devUrl) serveRenderer(join(__dirname, '..', 'renderer'));

  const userData = app.getPath('userData');
  const prefs = new PrefsStore(join(userData, 'prefs.json'));
  const recents = new RecentsStore(join(userData, 'recents.json'));
  nativeTheme.themeSource = prefs.get().theme;

  const port = resolveDaemonPort();
  const proxy = new DaemonProxy({
    port: () => port,
    token: () => readDaemonToken(port),
    onUnreachable: () => late.daemon?.noteUnreachable(),
  });
  // A session another Ordewell daemon holds is joined there (ADR-0063 H8).
  const holders = new HolderConnections({
    contract: DAEMON_CONTRACT,
    ownPort: () => port,
    readHolder: (sessionId, workspace) => readLiveHolder(sessionId, workspace),
    readToken: (p) => readDaemonToken(p),
    probe: (p) => probeDaemon(p),
    connect: (p, token) => new DaemonProxy({ port: () => p, token }),
  });
  const get = async (routeId: RouteId, params?: RouteParams): Promise<{ ok: boolean; data?: unknown }> => {
    const built = buildRequest(routeId, params);
    return built.ok ? proxy.call(built.request) : { ok: false };
  };
  const daemon = new DaemonManager({
    port,
    app: { version: app.getVersion(), contract: DAEMON_CONTRACT },
    probe: (p) => probeDaemon(p),
    fork: forkBundledDaemon,
    stopExternal: stopDaemonAt,
    liveRuns: () => findLiveRuns(get),
    logPath: daemonLogPath(),
    // The file forkBundledDaemon names with --pid-file, which the daemon writes once it listens.
    pidFileOwner: (p) => pidNamedIn(daemonPidFilePath(p)),
  });
  late.daemon = daemon;
  daemon.onStatus((status) => startupLog.record('daemon.status', { state: status.state }));

  const openProjects = new OpenProjectsMemory();
  const wm = new WindowManager({
    preloadPath: join(__dirname, '..', 'preload', 'index.js'),
    pageUrl: devUrl ?? `${APP_ORIGIN}/index.html`,
    devTools: !app.isPackaged,
    dark: () => nativeTheme.shouldUseDarkColors,
    // Closing a window ends its terminals (ADR-0062 G11), so a busy one is
    // asked about as quitting asks. Quitting itself exits without closing
    // windows one by one, so it never asks twice.
    confirmClose: (win) => {
      const prompt = closePrompt(terminalHost.busy(shellName, win.webContents.id));
      if (!prompt) return undefined;
      return dialog.showMessageBox(win, {
        type: 'warning',
        message: prompt.message,
        detail: prompt.detail,
        buttons: [prompt.confirmLabel, 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }).then((answer) => answer.response === 0);
    },
    onWorkspacesChanged: (open, windowsLeft) => openProjects.changed(open, windowsLeft),
  });
  late.windows = wm;
  nativeTheme.on('updated', () => wm.retheme());

  const updater = new UpdateController({
    enabled: AUTO_UPDATE_ENABLED,
    packaged: app.isPackaged,
    // Imported here, not at the top: a build with updates off never
    // evaluates the module. It reads the GitHub feed electron-builder wrote
    // into app-update.yml (publish in electron-builder.yml).
    load: async (): Promise<UpdaterPort> => autoUpdaterOf(await import('electron-updater')),
    log: (message) => console.warn(message),
  });
  // Started once the first windows are up, so the version check's notice and
  // answer have a window to show them in (ADR-0048).
  const updates = new UpdateService({ version: app.getVersion(), updater, versionCheck: prefs.get().versionCheck });

  // node-pty is a native addon: it loads on the first terminal, so a build
  // where it is missing still opens windows and only that terminal fails.
  const nodeRequire = createRequire(__filename);
  const spawnPty: PtySpawn = (file, args, options) => (nodeRequire('node-pty') as typeof import('node-pty')).spawn(file, args, options);
  const terminalHost = new TerminalHost(spawnPty);
  // Whatever ends this process, no shell outlives it.
  process.on('exit', () => terminalHost.killAll());
  const terminalChannel = new TerminalChannel({
    host: terminalHost,
    placement: { ...fileSystemPlacement, call: get },
    platform: process.platform,
    // A login from the launcher runs in home, as the daemon itself does.
    home: app.getPath('home'),
    // The same PATH the daemon and its runners get, not the GUI launch's.
    env: async () => withPath(process.env, await augmentedPath()),
    words: (file, env) => openWordLink(process.platform, file, env),
  });

  // A red disc drawn over a taskbar button on Windows, where no numeric badge exists.
  const attentionIcon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGNgoAU4aWP+HxsmWyNRBhGrGachFBlAqmYMQ0YNoIIBA58OqJKUiTGIoEZyAAADr23cbXlsxQAAAABJRU5ErkJggg==',
  );
  const notifications = new AttentionNotifier({
    muted: () => !prefs.get().notifications,
    present: (title, body, onClick) => {
      if (!osSurfacesAllowed() || !Notification.isSupported()) return;
      const item = new Notification({ title, body });
      item.on('click', onClick);
      item.show();
    },
    // The Dock and the Linux launcher take a count; Windows takes a mark, and the count lives in its description.
    badge: (count) => {
      app.setBadgeCount(count);
      app.dock?.setBadge(count > 0 ? String(count) : '');
      if (process.platform !== 'win32') return;
      for (const win of wm.all()) {
        win.setOverlayIcon(count > 0 ? attentionIcon : null, count > 0 ? `${count} need${count === 1 ? 's' : ''} you` : '');
      }
    },
  });

  const mac = process.platform === 'darwin';
  const projects = new ProjectOpener({
    windows: wm,
    recents,
    liveRuns: () => liveRuns(),
    busyTerminals: (contentsId) => terminalHost.busy(shellName, contentsId),
    // A test run keeps out of the user's own Dock recents, as it keeps out of their screen.
    ...(mac && osSurfacesAllowed() ? { addRecentDocument: (path: string) => app.addRecentDocument(path) } : {}),
  });
  const focused = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? undefined;
  const setMenu = (list: RecentWorkspace[]): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({
      platform: process.platform,
      dev: !app.isPackaged,
      appName: app.getName(),
      recents: list,
      actions: {
        command: (command) => { focused()?.webContents.send(EVENTS.menuCommand, command); },
        openFolder: () => { void projects.pick(focused()); },
        openRecent: (path) => { void projects.open(focused(), path); },
        clearRecents: () => {
          recents.clear();
          if (mac && osSurfacesAllowed()) app.clearRecentDocuments();
        },
        newWindow: () => { wm.openWelcome(); },
      },
    })));
  };
  setMenu(recents.list());
  registerNewWindowEntries({
    app,
    platform: process.platform,
    packaged: app.isPackaged,
    allowed: osSurfacesAllowed(),
    execPath: process.execPath,
    buildMenu: (template) => Menu.buildFromTemplate(template),
    newWindow: () => { wm.openWelcome(); },
  });
  recents.onChange((list) => {
    setMenu(list);
    wm.broadcast(EVENTS.recentsChanged, undefined);
  });
  late.open = (path) => { void projects.open(focused(), path); };

  registerIpc({
    appVersion: app.getVersion(),
    contract: DAEMON_CONTRACT,
    devOrigin,
    windows: wm,
    daemon,
    proxy,
    holders,
    recents,
    projects,
    prefs,
    updates,
    restartToUpdate: () => restartToUpdate(),
    notifications,
    terminals: { channel: terminalChannel, host: terminalHost },
    onDaemonRead: (route) => startupLog.request(route),
  });

  /** Live runs, or [] when no daemon answers: nothing can be running that this app could lose. */
  const liveRuns = async (): Promise<LiveRun[] | undefined> => (daemon.isConnected() ? daemon.liveRuns() : []);

  let tray: Tray | undefined;
  const showTray = (): void => {
    if (tray || !osSurfacesAllowed()) return;
    const icon = nativeImage.createFromPath(join(__dirname, '..', '..', 'resources', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Ordewell');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Ordewell', click: () => wm.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', () => wm.show());
  };
  const hideTray = (): void => {
    tray?.destroy();
    tray = undefined;
  };
  app.on('browser-window-created', hideTray);

  // ADR-0063 H5: a window closed during a run leaves the run, and the app
  // that can show it again, behind; the tray is how the user gets back.
  app.on('window-all-closed', () => {
    void liveRuns().then((live) => {
      const next = onLastWindowClosed(live, process.platform, prefs.get().keepRunningInTray);
      if (next === 'tray') showTray();
      else if (next === 'quit') app.quit();
    });
  });

  const ask = async (prompt: QuitPrompt): Promise<boolean> => {
    const answer = await dialog.showMessageBox({
      type: 'warning',
      message: prompt.message,
      detail: prompt.detail,
      buttons: [prompt.confirmLabel, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return answer.response === 0;
  };

  /** What quitting does once the user has agreed: stop what the app owns, so each run records a stop rather than a crash. */
  const shutDown = async (live: LiveRun[] | undefined): Promise<void> => {
    startupLog.record('quit.started');
    try {
      prefs.set({ openProjects: openProjects.list() });
    } catch (error) {
      console.warn(`[quit] could not remember the open projects: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Named with its workspace: an id names a session only within one.
    for (const run of runsQuitStops(live, daemon.owned)) {
      const built = buildRequest('plans.stop', { sessionId: run.sessionId, workspace: run.workspace });
      if (built.ok) await proxy.call(built.request);
    }
    hideTray();
    terminalHost.killAll();
    updates.stop();
    await daemon.shutdown();
    startupLog.record('quit.finished');
    // The log is best effort even on a disk that stopped answering.
    await Promise.race([startupLog.flush(), new Promise<void>((resolve) => setTimeout(resolve, 100))]);
  };

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      const live = await liveRuns();
      const prompt = quitPrompt(live, daemon.owned, terminalHost.busy(shellName));
      if (prompt && !(await ask(prompt))) return;
      quitting = true;
      await shutDown(live);
      app.exit(0);
    })();
  });

  /**
   * [Restart to update] (ADR-0063 H9): asks as quitting does, naming the runs
   * whose running tasks stop, then shuts down as quitting does and hands over
   * to the installer. `quitting` is set first, so the quit the installer
   * starts passes the before-quit handler instead of asking again.
   */
  const restartToUpdate = async (): Promise<boolean> => {
    if (quitting || updates.state().updater.phase !== 'ready') return false;
    const live = await liveRuns();
    const prompt = restartPrompt(live, daemon.owned, terminalHost.busy(shellName));
    if (prompt && !(await ask(prompt))) return false;
    quitting = true;
    await shutDown(live);
    // The daemon is already down: an app left open on a failed hand-over would be a shell of itself.
    if (!(await updates.install())) app.exit(0);
    return true;
  };

  app.on('activate', () => wm.show());

  /** Open what a launch asked for: its folders, the welcome window, last session's projects, or the window last used. */
  const launch = async (data: LaunchData, first: boolean): Promise<void> => {
    const request = parseLaunchArgs({ argv: data.argv, cwd: data.cwd, defaultApp: process.defaultApp === true });
    if (request.ignored.length > 0) console.warn(`[launch] not a folder, so not opened: ${request.ignored.join(', ')}`);
    if (first) request.folders.push(...heldFolders.splice(0));
    const { reopenProjects, openProjects: remembered } = prefs.get();
    // A hidden test run opens only what it names, never a desk left by an earlier launch.
    const action = launchAction({ request, first, reopen: reopenProjects && osSurfacesAllowed(), remembered });
    if (action.kind === 'show') wm.show();
    else if (action.kind === 'welcome') wm.openWelcome();
    else {
      // One at a time, in order, so the last opened is the one in front.
      for (const folder of action.folders) {
        await projects.open(undefined, folder).catch((error: unknown) => {
          console.warn(`[launch] could not open ${folder}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (first && wm.all().length === 0) wm.openWelcome();
    }
  };
  late.launch = (data) => { void launch(data, false); };

  await launch(thisLaunch, true);
  if (mac && app.isPackaged && osSurfacesAllowed() && app.isInApplicationsFolder()) {
    void completeMacInstall({
      bundle: dirname(dirname(dirname(app.getPath('exe')))),
      receipt: join(userData, 'install-completion.json'),
      show: async (options) => (await dialog.showMessageBox(options)).response,
      trash: (path) => shell.trashItem(path),
    }).catch((error: unknown) => { console.warn(`[install] ${error instanceof Error ? error.message : String(error)}`); });
  }
  // The welcome window can paint while the user's login profile resolves.
  // Only the daemon and its runners need the resulting PATH.
  process.env.PATH = await resolvedPath;
  updates.start();
  await daemon.connect();
}
