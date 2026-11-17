import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startExtensionVersionCheck } from '../versionCheck';

function fakeHost(isTelemetryEnabled: boolean, choose?: string) {
  let listener: ((enabled: boolean) => void) | undefined;
  const subscription = { dispose: vi.fn() };
  const items: Array<{ text: string; tooltip?: string; command?: { command: string; arguments?: unknown[] }; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  const executeCommand = vi.fn(async (_command: string, ..._args: unknown[]) => undefined);
  const openExternal = vi.fn(async (_uri: unknown) => true);
  return {
    host: {
      env: {
        isTelemetryEnabled,
        onDidChangeTelemetryEnabled: (cb: (enabled: boolean) => void) => { listener = cb; return subscription; },
        openExternal,
      },
      window: {
        showInformationMessage: vi.fn(async (..._args: unknown[]) => choose),
        createStatusBarItem: vi.fn(() => {
          const item = { text: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
          items.push(item);
          return item;
        }),
      },
      commands: { executeCommand },
      Uri: { parse: (value: string) => ({ toString: () => value }) },
      StatusBarAlignment: { Left: 1, Right: 2 },
    } as never,
    items,
    executeCommand,
    openExternal,
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
    const show = (fake.host as unknown as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage;
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toContain('once a day');
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(stateFile())).toBe(true);
  });

  const shown = (fake: ReturnType<typeof fakeHost>) =>
    (fake.host as unknown as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage.mock.calls.map((call) => call[0] as string);

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
    let shownAt: number | undefined;
    const popupStore = { get: () => shownAt, set: (at: number) => { shownAt = at; } };
    for (const fake of windows) startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch, popupStore });

    expect(shown(windows[0])).toEqual(['Ordewell 9.9.9 is out (you have 1.0.0) — update it from the Extensions view']);
    expect(shown(windows[1])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing with VS Code telemetry off: no message, no file, no ping', () => {
    const fetch = vi.fn();
    const fake = fakeHost(false);
    startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch });
    const show = (fake.host as unknown as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage;
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

  describe('an update is out', () => {
    const remember = (extra: Record<string, unknown> = {}) => {
      const at = new Date().toISOString();
      fs.writeFileSync(stateFile(), JSON.stringify({ installId: 'abc', installIdAt: at, noticeShownAt: at, ...extra }));
    };
    const ext = { extensionId: 'ordewell.ordewell' };
    const messageArgs = (fake: ReturnType<typeof fakeHost>) =>
      (fake.host as unknown as { window: { showInformationMessage: ReturnType<typeof vi.fn> } }).window.showInformationMessage.mock.calls;

    it('goes from a fetch answering a newer version to the buttons and the status bar item', async () => {
      remember();
      const fetch = vi.fn(async () => ({ status: 200, text: async () => '{"latest":"9.9.9"}' }));
      const fake = fakeHost(true);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch, ...ext });
      await vi.waitFor(() => expect(messageArgs(fake)).toHaveLength(1));
      expect(messageArgs(fake)[0]).toEqual(['Ordewell 9.9.9 is out (you have 1.0.0) — update it from the Extensions view', 'Update', "What's new"]);
      expect(fake.items).toHaveLength(1);
      expect(fake.items[0].text).toBe('$(arrow-circle-up) Ordewell 9.9.9');
      expect(fake.items[0].tooltip).toContain('9.9.9');
      expect(fake.items[0].command).toMatchObject({ command: 'extension.open', arguments: ['ordewell.ordewell'] });
      expect(fake.items[0].show).toHaveBeenCalled();
    });

    it('shows the status bar item at activation from the remembered latest, with no ping', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const fetch = vi.fn();
      const fake = fakeHost(true);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch, ...ext });
      expect(fetch).not.toHaveBeenCalled();
      expect(fake.items[0].text).toBe('$(arrow-circle-up) Ordewell 9.9.9');
      expect(fake.items[0].show).toHaveBeenCalled();
    });

    it('shows the status bar item although the TUI or CLI showed its update line today', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now, updateShownAt: now });
      const fake = fakeHost(true);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      expect(fake.items[0].show).toHaveBeenCalled();
    });

    it('shows no item when the remembered version is not newer', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '1.0.0', latestAt: now });
      const fake = fakeHost(true);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      expect(fake.items).toHaveLength(0);
    });

    it('shows the message once a day across windows while every window keeps the item', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      let shownAt: number | undefined;
      const popupStore = { get: () => shownAt, set: (at: number) => { shownAt = at; } };
      const windows = [fakeHost(true), fakeHost(true)];
      for (const fake of windows) startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), popupStore, ...ext });
      expect(messageArgs(windows[0])).toHaveLength(1);
      expect(messageArgs(windows[1])).toHaveLength(0);
      expect(windows.map((fake) => fake.items.length)).toEqual([1, 1]);
    });

    it('shows the message again when the last one was over a day ago', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const popupStore = { get: () => Date.now() - 25 * 60 * 60 * 1000, set: vi.fn() };
      const fake = fakeHost(true);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), popupStore, ...ext });
      expect(messageArgs(fake)).toHaveLength(1);
      expect(popupStore.set).toHaveBeenCalledTimes(1);
    });

    it('opens this extension in the Extensions view for Update, and for a click on the item', async () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const fake = fakeHost(true, 'Update');
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      await vi.waitFor(() => expect(fake.executeCommand).toHaveBeenCalledWith('extension.open', 'ordewell.ordewell'));
      expect(fake.openExternal).not.toHaveBeenCalled();
    });

    it("opens the release page of the tag for What's new", async () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const fake = fakeHost(true, "What's new");
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      await vi.waitFor(() => expect(fake.openExternal).toHaveBeenCalledTimes(1));
      expect(String((fake.openExternal.mock.calls[0] as unknown[])[0] as { toString(): string })).toBe('https://github.com/ordewell/ordewell/releases/tag/v9.9.9');
      expect(fake.executeCommand).not.toHaveBeenCalled();
    });

    it('falls back to the Extensions view when the extension page cannot be opened', async () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const fake = fakeHost(true, 'Update');
      fake.executeCommand.mockImplementationOnce(async () => { throw new Error('no such command'); });
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      await vi.waitFor(() => expect(fake.executeCommand).toHaveBeenCalledWith('workbench.view.extensions'));
    });

    it('hides the item when telemetry is turned off mid-session, and disposes it with the extension', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const fake = fakeHost(true);
      const check = startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      fake.change(false);
      expect(fake.items[0].hide).toHaveBeenCalled();
      check.dispose();
      expect(fake.items[0].dispose).toHaveBeenCalled();
    });

    it('shows no item with telemetry off', () => {
      const now = new Date().toISOString();
      remember({ lastCheckAt: now, latest: '9.9.9', latestAt: now });
      const fake = fakeHost(false);
      startExtensionVersionCheck(fake.host, '1.0.0', { env, stateDir, fetch: vi.fn(), ...ext });
      expect(fake.items).toHaveLength(0);
    });
  });
});
