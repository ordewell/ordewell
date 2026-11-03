import { describe, expect, it, vi } from 'vitest';
import { AUTO_UPDATE_ENABLED, UpdateController, type UpdaterPort } from '../updater';

const port = (overrides: Partial<UpdaterPort> = {}): UpdaterPort => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowDowngrade: true,
  allowPrerelease: true,
  checkForUpdates: vi.fn(async () => undefined),
  ...overrides,
});

describe('auto-update gate', () => {
  it('is closed in this build: nothing is signed yet', () => {
    expect(AUTO_UPDATE_ENABLED).toBe(false);
  });

  it('never loads electron-updater or asks for a release while disabled', async () => {
    const load = vi.fn(() => port());
    const controller = new UpdateController({ enabled: AUTO_UPDATE_ENABLED, packaged: true, load, log: vi.fn() });
    await controller.start();
    expect(load).not.toHaveBeenCalled();
    expect(controller.state()).toBe('disabled');
  });
});

describe('UpdateController when enabled', () => {
  it('does nothing in an unpackaged app, which has no update feed', async () => {
    const load = vi.fn(() => port());
    await new UpdateController({ enabled: true, packaged: false, load, log: vi.fn() }).start();
    expect(load).not.toHaveBeenCalled();
  });

  it('checks once and leaves the download and the restart to the person', async () => {
    const updater = port();
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    await controller.start();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false });
  });

  it('logs a failed check instead of throwing, and reports disabled again', async () => {
    const log = vi.fn();
    const updater = port({ checkForUpdates: vi.fn(async () => { throw new Error('offline'); }) });
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log });
    await expect(controller.start()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('Update check failed: offline');
    expect(controller.state()).toBe('disabled');
  });

  it('reports checking while the check is in flight', async () => {
    let finish: () => void = () => undefined;
    const updater = port({ checkForUpdates: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
    const controller = new UpdateController({ enabled: true, packaged: true, load: () => updater, log: vi.fn() });
    const started = controller.start();
    await vi.waitFor(() => expect(controller.state()).toBe('checking'));
    finish();
    await started;
    expect(controller.state()).toBe('disabled');
  });
});
