import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startExtensionVersionCheck } from '../versionCheck';

function fakeHost(isTelemetryEnabled: boolean) {
  let listener: ((enabled: boolean) => void) | undefined;
  const subscription = { dispose: vi.fn() };
  return {
    host: {
      env: {
        isTelemetryEnabled,
        onDidChangeTelemetryEnabled: (cb: (enabled: boolean) => void) => { listener = cb; return subscription; },
      },
      window: { showInformationMessage: vi.fn(async () => undefined) },
    } as never,
    showInformationMessage: undefined as unknown,
    change: (enabled: boolean) => listener?.(enabled),
    subscription,
  };
}

describe('startExtensionVersionCheck', () => {
  let stateDir: string;
  const env = {};
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-vc-')); });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const stateFile = () => path.join(stateDir, 'version-check.json');

  it('shows the one-time notice as a single information message and pings nothing', () => {
    const fetch = vi.fn();
    const fake = fakeHost(true);
    startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch });
    const show = (fake.host as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage;
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toContain('once a day');
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  const shown = (fake: ReturnType<typeof fakeHost>) =>
    (fake.host as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage.mock.calls.map((call) => call[0] as string);

  it('names the version a ping answered, and the Extensions view, which updates it', async () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ installId: 'abc', installIdAt: new Date().toISOString(), noticeShownAt: new Date().toISOString() }));
    const fetch = vi.fn(async () => ({ status: 200, text: async () => '{"latest":"9.9.9"}' }));
    const fake = fakeHost(true);
    startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch });
    await vi.waitFor(() => expect(shown(fake)).toEqual(['Ordewell 9.9.9 is out (you have 1.0.0) — update it from the Extensions view']));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('names a newer version an earlier ping remembered without asking again, once a day', () => {
    const now = new Date().toISOString();
    fs.writeFileSync(stateFile(), JSON.stringify({ installId: 'abc', installIdAt: now, noticeShownAt: now, lastCheckAt: now, latest: '9.9.9', latestAt: now }));
    const fetch = vi.fn();
    // Every window starts an extension host, and a message interrupts each one.
    const windows = [fakeHost(true), fakeHost(true)];
    for (const fake of windows) startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch });

    expect(shown(windows[0])).toEqual(['Ordewell 9.9.9 is out (you have 1.0.0) — update it from the Extensions view']);
    expect(shown(windows[1])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing with VS Code telemetry off: no message, no file, no ping', () => {
    const fetch = vi.fn();
    const fake = fakeHost(false);
    startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch });
    const show = (fake.host as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage;
    expect(show).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFile())).toBe(false);
  });

  it('stops the re-check when telemetry is turned off mid-session', () => {
    vi.useFakeTimers();
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ installId: 'abc', installIdAt: '2020-01-01T00:00:00.000Z', noticeShownAt: '2020-01-01T00:00:00.000Z' }));
      let now = Date.now();
      const fetch = vi.fn(async () => ({ status: 204, text: async () => '' }));
      const fake = fakeHost(true);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch, now: () => now });
      expect(fetch).toHaveBeenCalledTimes(1);
      fake.change(false);
      now += 25 * 60 * 60 * 1000;
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes its telemetry subscription', () => {
    const fake = fakeHost(true);
    startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir }).dispose();
    expect(fake.subscription.dispose).toHaveBeenCalled();
  });
});
