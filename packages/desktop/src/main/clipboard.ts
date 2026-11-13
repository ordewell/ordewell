import type { ActionResult, ClipboardReadResult } from '../shared/bridge';

/**
 * The system clipboard's plain text, for the page through the bridge
 * (ADR-0063 H4). The session refuses every web permission, clipboard ones
 * included (security.ts), so the page cannot read or write the clipboard by
 * itself. These calls are its only route, and only for text.
 *
 * The page's preload asks only during a key press or click. Main cannot see
 * that, so it also requires the asking window to have focus: a window in the
 * background cannot read what the user copied elsewhere.
 */

/** Far beyond a terminal's whole scrollback; anything larger is not a copy the user meant. */
export const MAX_CLIPBOARD_TEXT = 32 * 1024 * 1024;

export interface ClipboardAccess {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

const NOT_FOCUSED = 'The clipboard is reachable only from the window you are using.';

function reason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

export async function readClipboard(clipboard: ClipboardAccess, focused: boolean): Promise<ClipboardReadResult> {
  if (!focused) return { ok: false, message: NOT_FOCUSED };
  try {
    return { ok: true, text: await clipboard.readText() };
  } catch (err) {
    return { ok: false, message: `The clipboard could not be read: ${reason(err)}` };
  }
}

export async function writeClipboard(clipboard: ClipboardAccess, focused: boolean, text: unknown): Promise<ActionResult> {
  if (typeof text !== 'string') return { ok: false, message: 'Only text can be copied.' };
  if (text.length > MAX_CLIPBOARD_TEXT) return { ok: false, message: 'That is too much text to copy.' };
  if (!focused) return { ok: false, message: NOT_FOCUSED };
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `The clipboard could not be written: ${reason(err)}` };
  }
}
