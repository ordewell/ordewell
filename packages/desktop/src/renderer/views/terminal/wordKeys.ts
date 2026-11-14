type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'>;

/**
 * The macOS word chord, Option+Left/Right. It never reaches the shell as bytes:
 * neither xterm's modified arrow sequence nor Meta+B/F is safe in every shell
 * keymap, so it is a request over the shell's word link (ADR-0069), or nothing.
 */
export function macWordChord(event: KeyLike, mac: boolean): 'left' | 'right' | undefined {
  if (!mac || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  return event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : undefined;
}
