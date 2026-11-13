// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerm, type TermHandle } from '../xterm';

/**
 * The real xterm.js behind createTerm, fed keydowns the way Chromium delivers
 * them, to pin what reaches the shell. The panel's own tests swap this module
 * for a fake, so only here is xterm's keyboard handling itself in the loop.
 */

interface Chord { key: string; keyCode: number; alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean; composing?: boolean }

const LEFT = { key: 'ArrowLeft', keyCode: 37 };
const RIGHT = { key: 'ArrowRight', keyCode: 39 };

let handle: TermHandle | undefined;

beforeEach(() => {
  // jsdom has neither; xterm asks for both while it opens and draws nothing with them here.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  vi.restoreAllMocks();
});

async function terminal(mac: boolean): Promise<{ press(chord: Chord): { sent: string[]; prevented: boolean } }> {
  const sent: string[] = [];
  handle = await createTerm({
    onData: (data) => sent.push(data),
    onLink: () => undefined,
    screenReaderMode: false,
    // Nothing here reads or writes the clipboard; a rejection is what a failed bridge call looks like.
    readClipboard: () => Promise.reject(new Error('no clipboard in this test')),
    writeClipboard: () => Promise.reject(new Error('no clipboard in this test')),
    onClipboardError: () => undefined,
  }, mac);
  const parent = document.createElement('div');
  document.body.append(parent);
  handle.mount(parent);
  const textarea = parent.querySelector('textarea');
  if (!textarea) throw new Error('xterm opened without its input textarea');
  return {
    press(chord) {
      sent.length = 0;
      // keyCode is legacy, but it is what xterm reads for the arrows.
      const event = new KeyboardEvent('keydown', {
        key: chord.key, keyCode: chord.keyCode, bubbles: true, cancelable: true,
        altKey: chord.alt ?? false, ctrlKey: chord.ctrl ?? false, metaKey: chord.meta ?? false,
        shiftKey: chord.shift ?? false, isComposing: chord.composing ?? false,
      } as KeyboardEventInit);
      textarea.dispatchEvent(event);
      return { sent: [...sent], prevented: event.defaultPrevented };
    },
  };
}

describe('the terminal keyboard on macOS', () => {
  it('sends Option+Left/Right as Meta+B / Meta+F, which the stock shells move a word on', async () => {
    const term = await terminal(true);
    expect(term.press({ ...LEFT, alt: true })).toEqual({ sent: ['\x1bb'], prevented: true });
    expect(term.press({ ...RIGHT, alt: true })).toEqual({ sent: ['\x1bf'], prevented: true });
  });

  it('leaves the other keys as xterm sends them', async () => {
    const term = await terminal(true);
    expect(term.press({ key: 'c', keyCode: 67, ctrl: true }).sent).toEqual(['\x03']);
    expect(term.press({ key: 'a', keyCode: 65 }).sent).toEqual(['a']);
    expect(term.press(LEFT).sent).toEqual(['\x1b[D']);
    expect(term.press({ ...LEFT, ctrl: true }).sent).toEqual(['\x1b[1;5D']);
    expect(term.press({ ...LEFT, alt: true, shift: true }).sent).toEqual(['\x1b[1;4D']);
    // Option is Meta here (macOptionIsMeta), so Option+B is already Meta+B.
    expect(term.press({ key: 'b', keyCode: 66, alt: true }).sent).toEqual(['\x1bb']);
    expect(term.press({ key: 'ArrowUp', keyCode: 38, alt: true }).sent).toEqual(['\x1b[1;3A']);
    expect(term.press({ ...LEFT, meta: true }).sent).toEqual([]);
  });

  it('leaves Option+Left to xterm while an input method is composing', async () => {
    const term = await terminal(true);
    expect(term.press({ ...LEFT, alt: true, composing: true }).sent).not.toContain('\x1bb');
  });
});

describe('the terminal keyboard on Windows and Linux', () => {
  it('sends Ctrl+Left/Right, the word chord there, as xterm does', async () => {
    const term = await terminal(false);
    expect(term.press({ ...LEFT, ctrl: true }).sent).toEqual(['\x1b[1;5D']);
    expect(term.press({ ...RIGHT, ctrl: true }).sent).toEqual(['\x1b[1;5C']);
  });

  it('rewrites no Alt+Arrow and keeps Ctrl+C the interrupt', async () => {
    const term = await terminal(false);
    // xterm 6's own sequence; on macOS this is what moved nothing (see wordKeys.ts).
    expect(term.press({ ...LEFT, alt: true }).sent).toEqual(['\x1b[1;3D']);
    expect(term.press({ ...RIGHT, alt: true }).sent).toEqual(['\x1b[1;3C']);
    expect(term.press({ key: 'c', keyCode: 67, ctrl: true }).sent).toEqual(['\x03']);
  });
});
