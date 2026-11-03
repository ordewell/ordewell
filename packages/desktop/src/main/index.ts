import { join } from 'node:path';
import { app, dialog, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import {
  augmentedPath,
  DAEMON_CONTRACT,
  daemonLogPath,
  probeDaemon,
  readDaemonToken,
  resolveDaemonPort,
  stopDaemonAt,
} from '@ordewell/core/daemon-client';
import { buildRequest, type RouteId, type RouteParams } from '../shared/routes';
import { DaemonManager } from './daemon/DaemonManager';
import { forkBundledDaemon } from './daemon/forkDaemon';
import { findLiveRuns, type LiveRun } from './daemon/liveRuns';
import { DaemonProxy } from './daemon/proxy';
import { registerIpc } from './ipc';
import { onLastWindowClosed, quitPrompt } from './lifecycle';
import { menuTemplate } from './menu';
import { PrefsStore } from './prefs';
import { RecentsStore } from './recents';
import { lockSession, lockWebContents, registerAppScheme, serveRenderer } from './security';
import { WindowManager } from './windows';
import { APP_ORIGIN } from '../shared/csp';

// A dev URL is honoured only from a source checkout: a packaged app that read
// it from the environment could be pointed at any page with the bridge on.
const devUrl = !app.isPackaged ? process.env.ORDEWELL_DESKTOP_DEV_URL : undefined;
const devOrigin = devUrl ? new URL(devUrl).origin : undefined;

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

  lockSession(devOrigin);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, !app.isPackaged, app.getName())));
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
  });
  late.windows = wm;
  nativeTheme.on('updated', () => wm.retheme());

  registerIpc({
    appVersion: app.getVersion(),
    contract: DAEMON_CONTRACT,
    devOrigin,
    windows: wm,
    daemon,
    proxy,
    recents,
    prefs,
  });

  /** Live runs, or [] when no daemon answers: nothing can be running that this app could lose. */
  const liveRuns = async (): Promise<LiveRun[] | undefined> => (daemon.isConnected() ? daemon.liveRuns() : []);

  let tray: Tray | undefined;
  const showTray = (): void => {
    if (tray) return;
    const icon = nativeImage.createFromPath(join(__dirname, '..', '..', 'resources', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Ordewell: a run is in progress');
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

  // ADR-0060 H5: a window closed during a run leaves the run, and the app
  // that can show it again, behind; the tray is how the user gets back.
  app.on('window-all-closed', () => {
    void liveRuns().then((live) => {
      const next = onLastWindowClosed(live, process.platform);
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
      const prompt = quitPrompt(live, daemon.owned);
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
      await daemon.shutdown();
      app.exit(0);
    })();
  });

  app.on('activate', () => wm.show());

  wm.openWelcome();
  await daemon.connect();
}
