type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'>;

// Neither xterm's modified arrow sequence nor Meta+B/F is safe in every shell keymap.
export function unavailableWordChord(event: KeyLike, mac: boolean): boolean {
  return mac && !event.isComposing && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
}
