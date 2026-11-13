// @vitest-environment jsdom
/**
 * The terminal's copy and paste, down to the key handler xterm is given: which
 * chords are the clipboard's on each platform, which reach the shell, and that
 * a paste goes through xterm's paste (bracketed paste) exactly once.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTerm, type TermOptions } from '../xterm';

const fake = vi.hoisted(() => ({
  keyHandler: undefined as undefined | ((event: KeyboardEvent) => boolean),
  selection: '',
  pasted: [] as string[],
  element: undefined as undefined | HTMLElement,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    element?: HTMLElement;
    buffer = { active: { getLine: () => undefined } };
    loadAddon(): void { /* the fit addon */ }
    onData(): void { /* typing is not this test's */ }
    registerLinkProvider(): void { /* links are not this test's */ }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { fake.keyHandler = handler; }
    hasSelection(): boolean { return fake.selection.length > 0; }
    getSelection(): string { return fake.selection; }
    clearSelection(): void { fake.selection = ''; }
    paste(text: string): void { fake.pasted.push(text); }
    open(parent: HTMLElement): void {
      this.element = document.createElement('div');
      parent.appendChild(this.element);
      fake.element = this.element;
    }
    focus(): void { /* nothing to focus */ }
    dispose(): void { /* nothing to free */ }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void { /* no layout */ } } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

let clipboard = '';
let options: TermOptions & {
  readClipboard: Mock<() => Promise<string>>;
  writeClipboard: Mock<(text: string) => Promise<void>>;
  onClipboardError: Mock<(title: string, reason: string) => void>;
  onData: Mock<(data: string) => void>;
};

beforeEach(() => {
  fake.keyHandler = undefined;
  fake.selection = '';
  fake.pasted = [];
  fake.element = undefined;
  clipboard = 'from another app';
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  options = {
    onData: vi.fn(),
    onLink: vi.fn(),
    screenReaderMode: false,
    readClipboard: vi.fn(async () => clipboard),
    writeClipboard: vi.fn(async (text: string) => { clipboard = text; }),
    onClipboardError: vi.fn(),
  };
});

async function terminal(mac: boolean): Promise<void> {
  const term = await createTerm(options, mac);
  term.mount(document.createElement('div'));
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

/** Presses a key; true when xterm would go on to handle it (send it to the shell). */
function press(init: KeyboardEventInit, type: 'keydown' | 'keyup' = 'keydown'): { reachesXterm: boolean; prevented: boolean } {
  const handler = fake.keyHandler;
  if (!handler) throw new Error('createTerm attached no key handler');
  const event = new KeyboardEvent(type, { cancelable: true, ...init });
  return { reachesXterm: handler(event), prevented: event.defaultPrevented };
}

function rightClick(): boolean {
  const element = fake.element;
  if (!element) throw new Error('the terminal was not mounted');
  const event = new MouseEvent('contextmenu', { cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe.each([
  ['macOS', true, { metaKey: true }],
  ['Windows and Linux', false, { ctrlKey: true, shiftKey: true }],
])('the clipboard chords on %s', (_platform, mac, chord) => {
  it('copies the selection, and keeps the chord from the shell', async () => {
    await terminal(mac);
    fake.selection = 'echo hello';
    expect(press({ key: 'c', ...chord })).toEqual({ reachesXterm: false, prevented: true });
    await settle();
    expect(options.writeClipboard).toHaveBeenCalledTimes(1);
    expect(options.writeClipboard).toHaveBeenCalledWith('echo hello');
    expect(clipboard).toBe('echo hello');
    expect(options.onClipboardError).not.toHaveBeenCalled();
  });

  it('leaves the copy chord to xterm when nothing is selected, and copies nothing', async () => {
    await terminal(mac);
    expect(press({ key: 'c', ...chord })).toEqual({ reachesXterm: true, prevented: false });
    await settle();
    expect(options.writeClipboard).not.toHaveBeenCalled();
  });

  it('pastes once, through xterm\'s paste so bracketed paste holds, never as typed data', async () => {
    await terminal(mac);
    expect(press({ key: 'v', ...chord })).toEqual({ reachesXterm: false, prevented: true });
    await settle();
    expect(options.readClipboard).toHaveBeenCalledTimes(1);
    expect(fake.pasted).toEqual(['from another app']);
    expect(options.onData).not.toHaveBeenCalled();
  });

  it('takes the chord whichever case the key comes in', async () => {
    await terminal(mac);
    expect(press({ key: 'V', ...chord }).reachesXterm).toBe(false);
    await settle();
    expect(fake.pasted).toEqual(['from another app']);
  });

  it('pastes nothing from an empty clipboard', async () => {
    clipboard = '';
    await terminal(mac);
    press({ key: 'v', ...chord });
    await settle();
    expect(fake.pasted).toEqual([]);
    expect(options.onClipboardError).not.toHaveBeenCalled();
  });

  it('says why a copy failed instead of doing nothing', async () => {
    options.writeClipboard.mockRejectedValueOnce(new Error('The clipboard could not be written: busy'));
    await terminal(mac);
    fake.selection = 'echo hello';
    press({ key: 'c', ...chord });
    await settle();
    expect(options.onClipboardError).toHaveBeenCalledTimes(1);
    expect(options.onClipboardError).toHaveBeenCalledWith('Could not copy the selection', 'The clipboard could not be written: busy');
  });

  it('says why a paste failed, and pastes nothing', async () => {
    options.readClipboard.mockRejectedValueOnce(new Error('Copy and paste work from a key press or a click in the window.'));
    await terminal(mac);
    press({ key: 'v', ...chord });
    await settle();
    expect(fake.pasted).toEqual([]);
    expect(options.onClipboardError).toHaveBeenCalledTimes(1);
    expect(options.onClipboardError).toHaveBeenCalledWith('Could not paste', 'Copy and paste work from a key press or a click in the window.');
  });

  it('leaves a bare Ctrl+C to the shell as its interrupt, even with a selection', async () => {
    await terminal(mac);
    fake.selection = 'echo hello';
    expect(press({ key: 'c', ctrlKey: true })).toEqual({ reachesXterm: true, prevented: false });
    expect(press({ key: 'v', ctrlKey: true })).toEqual({ reachesXterm: true, prevented: false });
    await settle();
    expect(options.writeClipboard).not.toHaveBeenCalled();
    expect(options.readClipboard).not.toHaveBeenCalled();
  });

  it('leaves the chord with Alt held, and the key-up, to xterm', async () => {
    await terminal(mac);
    fake.selection = 'echo hello';
    expect(press({ key: 'c', altKey: true, ...chord }).reachesXterm).toBe(true);
    expect(press({ key: 'v', ...chord }, 'keyup').reachesXterm).toBe(true);
    await settle();
    expect(options.writeClipboard).not.toHaveBeenCalled();
    expect(options.readClipboard).not.toHaveBeenCalled();
  });

  it('copies the selection on a right-click and clears it, then pastes on the next', async () => {
    await terminal(mac);
    fake.selection = 'ls -la';
    expect(rightClick()).toBe(true);
    await settle();
    expect(clipboard).toBe('ls -la');
    expect(fake.selection).toBe('');
    expect(fake.pasted).toEqual([]);

    expect(rightClick()).toBe(true);
    await settle();
    expect(fake.pasted).toEqual(['ls -la']);
    expect(options.readClipboard).toHaveBeenCalledTimes(1);
  });

  it('says why a right-click paste failed', async () => {
    options.readClipboard.mockRejectedValueOnce(new Error('The clipboard could not be read: busy'));
    await terminal(mac);
    rightClick();
    await settle();
    expect(options.onClipboardError).toHaveBeenCalledTimes(1);
    expect(options.onClipboardError).toHaveBeenCalledWith('Could not paste', 'The clipboard could not be read: busy');
  });
});

describe('the other platform\'s chord', () => {
  it('is not the clipboard\'s on macOS: Ctrl+Shift+V reaches xterm', async () => {
    await terminal(true);
    expect(press({ key: 'v', ctrlKey: true, shiftKey: true }).reachesXterm).toBe(true);
    await settle();
    expect(options.readClipboard).not.toHaveBeenCalled();
  });

  it('is not the clipboard\'s on Windows and Linux: the Meta key\'s V reaches xterm', async () => {
    await terminal(false);
    expect(press({ key: 'v', metaKey: true }).reachesXterm).toBe(true);
    await settle();
    expect(options.readClipboard).not.toHaveBeenCalled();
  });
});
