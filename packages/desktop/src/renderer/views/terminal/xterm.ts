import '@xterm/xterm/css/xterm.css';
import { clipboardChord } from './clipboard';
import { findLinks } from './links';
import { buildTerminalTheme, TERMINAL_FONT, TERMINAL_FONT_SIZE, type TerminalTheme } from './terminalTheme';

/**
 * xterm.js behind a handle that is nothing but strings and callbacks, the way
 * monaco/index.ts hides Monaco: a test swaps this module for a fake (xterm
 * needs a browser's layout), and the store never touches xterm's own types.
 *
 * xterm is a large module, so it loads on the first terminal, not at start-up.
 */

export interface TermOptions {
  /** What the user typed or pasted, for the shell. */
  onData(data: string): void;
  /** A link the user activated (modifier + click). */
  onLink(url: string): void;
  screenReaderMode: boolean;
  /** The clipboard's text; rejects with why it could not be read, for the user. */
  readClipboard(): Promise<string>;
  /** Rejects with why the text could not be copied, for the user. */
  writeClipboard(text: string): Promise<void>;
  /** A copy or paste that failed, said so rather than doing nothing: what failed, and why. */
  onClipboardError(title: string, reason: string): void;
}

export interface TermHandle {
  /** Opens on first call; later calls move the same terminal, with its scrollback, to a new parent. */
  mount(parent: HTMLElement): void;
  write(data: string): void;
  /** Fits to the parent and returns the size the shell should have. */
  fit(): { cols: number; rows: number };
  size(): { cols: number; rows: number };
  focus(): void;
  setTheme(): void;
  dispose(): void;
}

const dark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;
const readToken = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name);
export const currentTheme = (): TerminalTheme => buildTerminalTheme(readToken, dark());

export async function createTerm(options: TermOptions, mac: boolean): Promise<TermHandle> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  const term = new Terminal({
    fontFamily: TERMINAL_FONT,
    fontSize: TERMINAL_FONT_SIZE,
    cursorBlink: true,
    scrollback: 5000,
    theme: currentTheme(),
    screenReaderMode: options.screenReaderMode,
    // macOS: Option types accents unless it is asked to be Meta, which shells need for word movement.
    macOptionIsMeta: mac,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((data) => options.onData(data));

  const failed = (title: string) => (err: unknown): void => {
    options.onClipboardError(title, err instanceof Error ? err.message : String(err));
  };
  const copy = (): void => {
    const text = term.getSelection();
    if (text) void options.writeClipboard(text).catch(failed('Could not copy the selection'));
  };
  // term.paste, not onData: it wraps the text in bracketed-paste markers when
  // the shell asked for them, so a pasted newline does not run a command.
  const paste = (): void => {
    void options.readClipboard().then((text) => { if (text) term.paste(text); }, failed('Could not paste'));
  };

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    // Ctrl+` toggles the panel (the frame's command), so it must reach the window, not the shell.
    if (event.key === '`' && event.ctrlKey && !event.metaKey && !event.altKey) return false;
    const chord = clipboardChord(event, mac);
    if (chord === 'copy' && term.hasSelection()) { event.preventDefault(); copy(); return false; }
    if (chord === 'paste') { event.preventDefault(); paste(); return false; }
    return true;
  });

  term.registerLinkProvider({
    provideLinks(line, callback) {
      const text = term.buffer.active.getLine(line - 1)?.translateToString(true) ?? '';
      const links = findLinks(text).map((match) => ({
        range: { start: { x: match.start + 1, y: line }, end: { x: match.end, y: line } },
        text: match.url,
        activate: (event: MouseEvent, url: string) => {
          // Plain clicks select text; the modifier says the user means the link.
          if (mac ? event.metaKey : event.ctrlKey) options.onLink(url);
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  });

  let opened = false;
  return {
    mount(parent) {
      if (!opened) {
        // Another tab's terminal may still be in the parent.
        parent.replaceChildren();
        term.open(parent);
        opened = true;
        // xterm's own right-click is the browser's menu; the terminal's is copy-or-paste.
        term.element?.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (term.hasSelection()) { copy(); term.clearSelection(); } else paste();
        });
      } else if (term.element && term.element.parentElement !== parent) {
        parent.replaceChildren(term.element);
      }
    },
    write: (data) => term.write(data),
    fit() {
      try { fit.fit(); } catch { /* not laid out yet: the size stays what it was */ }
      return { cols: term.cols, rows: term.rows };
    },
    size: () => ({ cols: term.cols, rows: term.rows }),
    focus: () => term.focus(),
    setTheme() { term.options.theme = currentTheme(); },
    dispose: () => term.dispose(),
  };
}
