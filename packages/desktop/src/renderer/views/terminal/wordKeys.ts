type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'>;

/**
 * Option+Left/Right on macOS: a word back or forward, as Terminal.app and iTerm2
 * send it. xterm.js 6 sends the xterm sequences ESC[1;3D / ESC[1;3C, which neither
 * macOS's stock zsh (`zsh -f`) nor bash binds, while both bind ESC b / ESC f
 * (Meta+B / Meta+F) to backward-word / forward-word. xterm.js 5 did this rewrite
 * itself; 6 dropped it. Elsewhere the convention is Ctrl+Left/Right, whose
 * ESC[1;5D / ESC[1;5C xterm already sends, so nothing is rewritten.
 */
export function wordMove(event: KeyLike, mac: boolean): string | undefined {
  if (!mac || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  if (event.key === 'ArrowLeft') return '\x1bb';
  if (event.key === 'ArrowRight') return '\x1bf';
  return undefined;
}
