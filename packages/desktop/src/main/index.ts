import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, Tray } from 'electron';
import {
  augmentedPath,
  DAEMON_CONTRACT,
  daemonLogPath,
  probeDaemon,
  readDaemonToken,
  readLiveHolder,
  resolveDaemonPort,
  stopDaemonAt,
  withPath,
} from '@ordewell/core/daemon-client';
import { EVENTS } from '../shared/bridge';
import { buildRequest, type RouteId, type RouteParams } from '../shared/routes';
import { DaemonManager } from './daemon/DaemonManager';
import { forkBundledDaemon } from './daemon/forkDaemon';
import { findLiveRuns, type LiveRun } from './daemon/liveRuns';
import { HolderConnections } from './daemon/holders';
import { DaemonProxy } from './daemon/proxy';
import { registerIpc } from './ipc';
import { TerminalChannel } from './terminal/TerminalChannel';
import { fileSystemPlacement } from './terminal/placement';
import { shellName } from './terminal/shellChoice';
import { TerminalHost, type PtySpawn } from './terminal/TerminalHost';
import { closePrompt, onLastWindowClosed, quitPrompt } from './lifecycle';
import { menuTemplate } from './menu';
import { AttentionNotifier } from './notifications';
import { PrefsStore } from './prefs';
import { RecentsStore } from './recents';
import { AUTO_UPDATE_ENABLED, UpdateController, type UpdaterPort } from './updater';
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

if (!app.requestSingleInstanceLock()) {
  // One app per user, so one window per workspace holds across launches (H6).
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  // Filled in once each exists: the handlers wired before then find nothing to do.
  const late: { windows?: WindowManager; daemon?: DaemonManager } = {};
  app.on('second-instance', () => late.windows?.show());

  // A GUI launch inherits launchd's or the desktop's PATH, which finds none of
  // the runners; the daemon this app forks inherits whatever is set here.
  process.env.PATH = await augmentedPath();
  await app.whenReady();
  suppressOsSurfaces();

  lockSession(devOrigin);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, !app.isPackaged, app.getName(), (command) => {
    BrowserWindow.getFocusedWindow()?.webContents.send(EVENTS.menuCommand, command);
  })));
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
  });
  late.daemon = daemon;

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
  });
  late.windows = wm;
  nativeTheme.on('updated', () => wm.retheme());

  const updates = new UpdateController({
    enabled: AUTO_UPDATE_ENABLED,
    packaged: app.isPackaged,
    // Imported here, not at the top: a build with updates off never
    // evaluates the module. It reads the GitHub feed electron-builder wrote
    // into app-update.yml (publish in electron-builder.yml).
    load: async (): Promise<UpdaterPort> => (await import('electron-updater')).autoUpdater,
    log: (message) => console.warn(message),
  });

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

  registerIpc({
    appVersion: app.getVersion(),
    contract: DAEMON_CONTRACT,
    devOrigin,
    windows: wm,
    daemon,
    proxy,
    holders,
    recents,
    prefs,
    updates,
    notifications,
    terminals: { channel: terminalChannel, host: terminalHost },
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

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      const live = await liveRuns();
      const prompt = quitPrompt(live, daemon.owned, terminalHost.busy(shellName));
      if (prompt) {
        const answer = await dialog.showMessageBox({
          type: 'warning',
          message: prompt.message,
          detail: prompt.detail,
          buttons: [prompt.confirmLabel, 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response !== 0) return;
      }
      quitting = true;
      // An owned daemon's runs are stopped through the daemon before it goes,
      // so each records a stop rather than a crash; an attached daemon's runs
      // go on (H5).
      if (daemon.owned && live) {
        for (const run of live) {
          const built = buildRequest('plans.stop', { sessionId: run.sessionId });
          if (built.ok) await proxy.call(built.request);
        }
      }
      hideTray();
      terminalHost.killAll();
      await daemon.shutdown();
      app.exit(0);
    })();
  });

  app.on('activate', () => wm.show());

  wm.openWelcome();
  void updates.start();
  await daemon.connect();
}
