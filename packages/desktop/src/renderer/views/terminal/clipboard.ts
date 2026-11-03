/** Where the platform's terminals copy and paste: Cmd on macOS, Ctrl+Shift elsewhere (a bare Ctrl+C is the shell's interrupt). */
export function clipboardChord(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, mac: boolean): 'copy' | 'paste' | undefined {
  if (event.altKey) return undefined;
  const key = event.key.toLowerCase();
  const held = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!held) return undefined;
  return key === 'c' ? 'copy' : key === 'v' ? 'paste' : undefined;
}
