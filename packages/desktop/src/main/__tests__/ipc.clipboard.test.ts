import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const system = vi.hoisted(() => ({
  text: '',
  focused: true,
  packaged: true,
  fail: undefined as Error | undefined,
}));

vi.mock('electron', () => ({
  app: { get isPackaged() { return system.packaged; } },
  ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
  BrowserWindow: { fromWebContents: () => ({ isFocused: () => system.focused }) },
  clipboard: {
    readText: async () => { if (system.fail) throw system.fail; return system.text; },
    writeText: async (text: string) => { if (system.fail) throw system.fail; system.text = text; },
  },
  dialog: {},
  shell: {},
}));

import { CHANNELS } from '../../shared/bridge';
import { MAX_CLIPBOARD_TEXT } from '../clipboard';
import { registerIpc, type IpcDeps } from '../ipc';
import { TEST_WINDOWS_ENV } from '../testWindows';

/**
 * The page's only route to the clipboard (security.ts refuses it the web's):
 * main answers the app's own top frame in a window it made, while that window
 * is the one in use, with text only, and says why when it cannot.
 */
describe('the clipboard channels', () => {
  beforeEach(() => {
    handlers.clear();
    Object.assign(system, { text: 'copied elsewhere', focused: true, packaged: true, fail: undefined });
    vi.stubEnv(TEST_WINDOWS_ENV, '');
    const inert = (): unknown => new Proxy(() => inert(), { get: (_target, key) => (key === 'then' ? undefined : inert()) });
    registerIpc({
      appVersion: '0', contract: 1, devOrigin: undefined,
      daemon: inert(), recents: inert(), projects: inert(), prefs: inert(), updates: inert(), notifications: inert(), terminals: inert(), proxy: inert(), holders: inert(),
      windows: { contextOf: () => ({ kind: 'workspace', path: '/b' }), openWelcome: () => undefined, broadcast: () => undefined },
    } as unknown as IpcDeps);
  });

  const from = (url: string, parent: unknown = null): IpcMainInvokeEvent =>
    ({ senderFrame: { parent, url }, sender: { id: 1 } }) as unknown as IpcMainInvokeEvent;
  const app = from('app://renderer/index.html');
  const invoke = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): unknown => handlers.get(channel)?.(event, ...args);

  it('reads and writes plain text for the app\'s page', async () => {
    await expect(invoke(CHANNELS.clipboardReadText, app)).resolves.toEqual({ ok: true, text: 'copied elsewhere' });
    await expect(invoke(CHANNELS.clipboardWriteText, app, 'echo hello')).resolves.toEqual({ ok: true });
    expect(system.text).toBe('echo hello');
  });

  it.each([
    ['another origin', from('https://example.com/')],
    ['a frame inside the page', from('app://renderer/index.html', {})],
    ['a file page', from('file:///tmp/index.html')],
  ])('refuses %s, and leaves the clipboard alone', (_who, event) => {
    expect(() => invoke(CHANNELS.clipboardReadText, event)).toThrow('Refused: not an Ordewell window.');
    expect(() => invoke(CHANNELS.clipboardWriteText, event, 'overwritten')).toThrow('Refused: not an Ordewell window.');
    expect(system.text).toBe('copied elsewhere');
  });

  it('refuses a window in the background, which cannot be the one the user pressed a key in', async () => {
    system.focused = false;
    await expect(invoke(CHANNELS.clipboardReadText, app)).resolves.toEqual({ ok: false, message: 'The clipboard is reachable only from the window you are using.' });
    await expect(invoke(CHANNELS.clipboardWriteText, app, 'overwritten')).resolves.toMatchObject({ ok: false });
    expect(system.text).toBe('copied elsewhere');
  });

  it('answers a test run\'s hidden windows, which are never focused, only from a source checkout', async () => {
    system.focused = false;
    vi.stubEnv(TEST_WINDOWS_ENV, 'hidden');
    system.packaged = false;
    await expect(invoke(CHANNELS.clipboardReadText, app)).resolves.toEqual({ ok: true, text: 'copied elsewhere' });
    system.packaged = true;
    await expect(invoke(CHANNELS.clipboardReadText, app)).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['a number', 42],
    ['an object', { toString: () => 'x' }],
    ['nothing', undefined],
  ])('writes only text, refusing %s', async (_what, value) => {
    await expect(invoke(CHANNELS.clipboardWriteText, app, value)).resolves.toEqual({ ok: false, message: 'Only text can be copied.' });
    expect(system.text).toBe('copied elsewhere');
  });

  it('refuses text past the cap', async () => {
    await expect(invoke(CHANNELS.clipboardWriteText, app, 'x'.repeat(MAX_CLIPBOARD_TEXT + 1))).resolves.toEqual({ ok: false, message: 'That is too much text to copy.' });
    expect(system.text).toBe('copied elsewhere');
  });

  it('says why the OS clipboard failed rather than throwing', async () => {
    system.fail = new Error('the pasteboard is locked');
    await expect(invoke(CHANNELS.clipboardReadText, app)).resolves.toEqual({ ok: false, message: 'The clipboard could not be read: the pasteboard is locked' });
    await expect(invoke(CHANNELS.clipboardWriteText, app, 'x')).resolves.toEqual({ ok: false, message: 'The clipboard could not be written: the pasteboard is locked' });
  });
});
