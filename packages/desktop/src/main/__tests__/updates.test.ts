import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PingFetch } from '@ordewell/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../shared/bridge';
import { UpdateController, type UpdaterPort } from '../updater';
import { UpdateService } from '../updates';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (ms: number): string => new Date(ms).toISOString();

let dir: string;
let services: UpdateService[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ow-updates-'));
});

afterEach(() => {
  for (const service of services) service.stop();
  services = [];
  rmSync(dir, { recursive: true, force: true });
});

const stateFile = (): string => join(dir, 'version-check.json');

/** A machine where the notice was shown long ago and an install ID is current. */
function remember(fields: Record<string, string>): void {
  writeFileSync(stateFile(), JSON.stringify({
    installId: 'c0ffee00-0000-4000-8000-000000000000',
    installIdAt: at(NOW - DAY),
    noticeShownAt: at(NOW - 10 * DAY),
    ...fields,
  }));
}

/** The ping's server: answers each request with the version it is given, and records the URLs. */
function server(latest: string | null): PingFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetch: PingFetch = async (url) => {
    urls.push(url);
    return latest === null
      ? { status: 204, text: async () => '' }
      : { status: 200, text: async () => JSON.stringify({ latest }) };
  };
  return Object.assign(fetch, { urls });
}

function updaterPort(latest: string | null, fail?: Error): UpdaterPort {
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: true,
    checkForUpdates: vi.fn(async () => {
      if (fail) throw fail;
      return latest === null ? null : { isUpdateAvailable: true, updateInfo: { version: latest } };
    }),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
  };
}

interface Setup {
  fetch?: PingFetch;
  env?: Record<string, string | undefined>;
  enabled?: boolean;
  /** A signed build whose updater answers with this version, or null for none newer. */
  signed?: { latest: string | null; fail?: Error };
}

function service(setup: Setup = {}): UpdateService {
  const port = setup.signed ? updaterPort(setup.signed.latest, setup.signed.fail) : undefined;
  const updater = new UpdateController({
    enabled: port !== undefined,
    packaged: true,
    load: () => port ?? updaterPort(null),
    log: () => {},
  });
  const made = new UpdateService({
    version: '1.2.0',
    updater,
    versionCheck: setup.enabled ?? true,
    env: setup.env ?? {},
    stateDir: dir,
    fetch: setup.fetch ?? server(null),
    now: () => NOW,
  });
  services.push(made);
  return made;
}

describe('UpdateService: the version check', () => {
  it('names the version remembered from an earlier ping at startup, even when the day is not up and the line was shown today', () => {
    // The CLI showed its once-a-day line an hour ago and pinged then: the
    // desktop must still know, without asking again.
    remember({ lastCheckAt: at(NOW - HOUR), latest: '1.3.0', latestAt: at(NOW - HOUR), updateShownAt: at(NOW - HOUR) });
    const fetch = server('9.9.9');
    const updates = service({ fetch });
    updates.start();
    expect(updates.state()).toEqual<UpdateState>({
      current: '1.2.0',
      method: 'download',
      latest: '1.3.0',
      updater: { phase: 'idle' },
    });
    expect(fetch.urls).toEqual([]);
  });

  it('ignores a remembered version that is not newer than the running one', () => {
    remember({ lastCheckAt: at(NOW - HOUR), latest: '1.2.0', latestAt: at(NOW - HOUR) });
    const updates = service();
    updates.start();
    expect(updates.state().latest).toBeUndefined();
  });

  it('pings once the day is up, sending the desktop\'s version, and tells every listener what the answer named', async () => {
    remember({ lastCheckAt: at(NOW - 2 * DAY) });
    const fetch = server('1.4.0');
    const updates = service({ fetch });
    const seen: (string | undefined)[] = [];
    updates.onChange((state) => seen.push(state.latest));
    updates.start();
    await vi.waitFor(() => expect(seen).toEqual(['1.4.0']));
    expect(fetch.urls).toHaveLength(1);
    expect(new URL(fetch.urls[0]).searchParams.get('v')).toBe('1.2.0');
    expect(updates.state().latest).toBe('1.4.0');
  });

  it('on the first start on a machine holds the notice for a window, names the Settings switch, and sends nothing', () => {
    const fetch = server('1.4.0');
    const updates = service({ fetch });
    const changes: UpdateState[] = [];
    updates.onChange((state) => changes.push(state));
    updates.start();
    const notice = updates.state().notice ?? '';
    expect(notice).toContain('ORDEWELL_NO_VERSION_CHECK');
    expect(notice).toContain('Settings → Check for new versions');
    expect(fetch.urls).toEqual([]);

    updates.dismissNotice();
    expect(updates.state().notice).toBeUndefined();
    expect(changes.at(-1)?.notice).toBeUndefined();
  });

  it('with the Settings toggle off sends nothing and writes nothing, and names no remembered version', () => {
    const fetch = server('1.4.0');
    const fresh = service({ fetch, enabled: false });
    fresh.start();
    expect(existsSync(stateFile())).toBe(false);
    expect(fresh.state().notice).toBeUndefined();

    remember({ lastCheckAt: at(NOW - 2 * DAY), latest: '1.3.0', latestAt: at(NOW - 2 * DAY) });
    const off = service({ fetch, enabled: false });
    off.start();
    expect(off.state().latest).toBeUndefined();
    expect(fetch.urls).toEqual([]);
  });

  it('turning the toggle off forgets the version, and turning it back on starts the check again', async () => {
    remember({ lastCheckAt: at(NOW - HOUR), latest: '1.3.0', latestAt: at(NOW - HOUR) });
    const updates = service();
    updates.start();
    expect(updates.state().latest).toBe('1.3.0');
    updates.setVersionCheck(false);
    expect(updates.state().latest).toBeUndefined();
    updates.setVersionCheck(true);
    expect(updates.state().latest).toBe('1.3.0');
  });

  it.each([
    ['ORDEWELL_NO_VERSION_CHECK', '1'],
    ['DO_NOT_TRACK', 'true'],
  ])('%s=%s turns it off whatever the toggle says', async (name, value) => {
    remember({ lastCheckAt: at(NOW - 2 * DAY), latest: '1.3.0', latestAt: at(NOW - 2 * DAY) });
    const before = readFileSync(stateFile(), 'utf8');
    const fetch = server('1.4.0');
    const updates = service({ fetch, env: { [name]: value } });
    updates.start();
    expect(updates.state().latest).toBeUndefined();
    await expect(updates.check()).resolves.toEqual({ kind: 'off', reason: 'environment' });
    expect(fetch.urls).toEqual([]);
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
  });
});

describe('UpdateService: Check for updates…', () => {
  it('on a download build runs the version check now and names what it found', async () => {
    remember({ lastCheckAt: at(NOW - 2 * DAY) });
    const updates = service({ fetch: server('1.4.0') });
    updates.start();
    await expect(updates.check()).resolves.toEqual({ kind: 'available', latest: '1.4.0' });
  });

  it('on a download build says up to date when the answer names nothing newer', async () => {
    remember({ lastCheckAt: at(NOW - 2 * DAY) });
    const updates = service({ fetch: server(null) });
    updates.start();
    await expect(updates.check()).resolves.toEqual({ kind: 'up-to-date' });
    expect(updates.state().latest).toBeUndefined();
  });

  it('on a download build with the toggle off asks nothing and says why', async () => {
    const fetch = server('1.4.0');
    const updates = service({ fetch, enabled: false });
    updates.start();
    await expect(updates.check()).resolves.toEqual({ kind: 'off', reason: 'setting' });
    expect(fetch.urls).toEqual([]);
  });

  it('on a signed build asks the updater, toggle or not, and the version it names is the one shown', async () => {
    const fetch = server('1.4.0');
    const updates = service({ fetch, enabled: false, signed: { latest: '1.5.0' } });
    updates.start();
    expect(updates.state().method).toBe('install');
    await expect(updates.check()).resolves.toEqual({ kind: 'available', latest: '1.5.0' });
    expect(updates.state()).toMatchObject({ latest: '1.5.0', updater: { phase: 'available', version: '1.5.0' } });
    expect(fetch.urls).toEqual([]);
  });

  it('on a signed build reports up to date, and a failure as a failure', async () => {
    const none = service({ signed: { latest: null } });
    none.start();
    await expect(none.check()).resolves.toEqual({ kind: 'up-to-date' });

    const broken = service({ signed: { latest: null, fail: new Error('offline') } });
    broken.start();
    await expect(broken.check()).resolves.toEqual({ kind: 'failed', message: 'offline' });
  });

  it('on a signed build keeps naming the ping\'s version while the updater has nothing for it yet', async () => {
    remember({ lastCheckAt: at(NOW - HOUR), latest: '1.3.0', latestAt: at(NOW - HOUR) });
    const updates = service({ signed: { latest: null } });
    updates.start();
    await updates.download();
    expect(updates.state()).toMatchObject({ latest: '1.3.0', updater: { phase: 'up-to-date' } });
  });

  it('downloads on a signed build, reporting each step to listeners', async () => {
    remember({ lastCheckAt: at(NOW - HOUR) });
    const updates = service({ signed: { latest: '1.5.0' } });
    const phases: string[] = [];
    updates.onChange((state) => phases.push(state.updater.phase));
    updates.start();
    await updates.download();
    expect(phases).toEqual(['checking', 'available', 'downloading', 'ready']);
    expect(updates.state()).toMatchObject({ latest: '1.5.0', updater: { phase: 'ready', version: '1.5.0' } });
  });
});
