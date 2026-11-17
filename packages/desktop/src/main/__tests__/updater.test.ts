import { describe, expect, it, vi } from 'vitest';
import { autoUpdateDefine } from '../../../tsup.config';
import { AUTO_UPDATE_ENABLED, UpdateController, type UpdaterPort } from '../updater';

type Port = UpdaterPort & { progress(percent: number): void };

/** electron-updater's autoUpdater as far as the app drives it: a feed that has `latest`, or nothing newer. */
const port = (overrides: Partial<UpdaterPort> = {}, latest?: string): Port => {
  const listeners: Array<(progress: { percent: number }) => void> = [];
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    checkForUpdates: vi.fn(async () => (latest ? { isUpdateAvailable: true, updateInfo: { version: latest } } : null)),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    on: vi.fn((_event: 'download-progress', listener: (progress: { percent: number }) => void) => { listeners.push(listener); }),
    progress: (percent) => { for (const listener of listeners) listener({ percent }); },
    ...overrides,
  };
};

describe('auto-update gate', () => {
  it('is closed in a build that did not decide, as this one did not', () => {
    expect(AUTO_UPDATE_ENABLED).toBe(false);
  });

  it('is baked open only when the packaging plan says on', () => {
    expect(autoUpdateDefine({ ORDEWELL_DESKTOP_AUTO_UPDATE: 'on' })).toEqual({ __ORDEWELL_AUTO_UPDATE__: 'true' });
    for (const value of ['off', 'true', '1', 'ON', '', undefined]) {
      expect(autoUpdateDefine({ ORDEWELL_DESKTOP_AUTO_UPDATE: value })).toEqual({ __ORDEWELL_AUTO_UPDATE__: 'false' });
    }
  });

  it('never loads electron-updater or asks for a release while disabled', async () => {
    const load = vi.fn(() => port());
    const controller = new UpdateController({ enabled: AUTO_UPDATE_ENABLED, packaged: true, load, log: vi.fn() });
    expect(controller.enabled).toBe(false);
    await controller.check();
    await controller.download();
    expect(await controller.install()).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(controller.status()).toEqual({ phase: 'idle' });
  });
});

describe('UpdateController when enabled', () => {
  it('asks for a release only when the person does: nothing on its own, then one check per ask', async () => {
    const updater = port();
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    await Promise.resolve();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('does nothing in an unpackaged app, which has no update feed', async () => {
    const load = vi.fn(() => port());
    const controller = new UpdateController({ enabled: true, packaged: false, load, log: vi.fn() });
    expect(controller.enabled).toBe(false);
    await controller.check();
    expect(load).not.toHaveBeenCalled();
  });

  it('reports the release the feed names, and leaves the download to the person', async () => {
    const updater = port({}, '1.4.0');
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    expect(await controller.check()).toEqual({ phase: 'available', version: '1.4.0' });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false });
  });

  it('says up to date when the feed has nothing newer', async () => {
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => port(), log: vi.fn() });
    expect(await controller.check()).toEqual({ phase: 'up-to-date' });
  });

  it('logs a failed check instead of throwing, and reports the failure', async () => {
    const log = vi.fn();
    const updater = port({ checkForUpdates: vi.fn(async () => { throw new Error('offline'); }) });
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log });
    expect(await controller.check()).toEqual({ phase: 'error', message: 'offline' });
    expect(log).toHaveBeenCalledWith('Update check failed: offline');
  });

  it('reports checking while the check is in flight', async () => {
    let finish: () => void = () => undefined;
    const updater = port({ checkForUpdates: vi.fn(() => new Promise<null>((resolve) => { finish = () => resolve(null); })) });
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    const checked = controller.check();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalled());
    expect(controller.status()).toEqual({ phase: 'checking' });
    finish();
    await checked;
    expect(controller.status()).toEqual({ phase: 'up-to-date' });
  });

  it('downloads on Update, checking first, with its progress, then installs on quit once it is downloaded', async () => {
    let finish: () => void = () => undefined;
    const updater = port({ downloadUpdate: vi.fn(() => new Promise<unknown>((resolve) => { finish = () => resolve([]); })) }, '1.4.0');
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    const seen: string[] = [];
    controller.onChange((status) => seen.push(status.phase === 'downloading' ? `downloading ${status.percent}` : status.phase));
    const downloaded = controller.download();
    await vi.waitFor(() => expect(controller.status()).toEqual({ phase: 'downloading', version: '1.4.0', percent: 0 }));
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    updater.progress(41.7);
    expect(controller.status()).toEqual({ phase: 'downloading', version: '1.4.0', percent: 41 });
    finish();
    await downloaded;
    expect(controller.status()).toEqual({ phase: 'ready', version: '1.4.0' });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(seen).toEqual(['checking', 'available', 'downloading 0', 'downloading 41', 'ready']);
  });

  it('restarts into the update only once it is downloaded', async () => {
    const updater = port({}, '1.4.0');
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    expect(await controller.install()).toBe(false);
    await controller.download();
    expect(await controller.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('reports a failed download, and lets Update try again', async () => {
    const log = vi.fn();
    const downloadUpdate = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue([]);
    const updater = port({ downloadUpdate }, '1.4.0');
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log });
    await controller.download();
    expect(controller.status()).toEqual({ phase: 'error', message: 'disk full' });
    expect(log).toHaveBeenCalledWith('Update download failed: disk full');
    await controller.download();
    expect(controller.status()).toEqual({ phase: 'ready', version: '1.4.0' });
  });
});
