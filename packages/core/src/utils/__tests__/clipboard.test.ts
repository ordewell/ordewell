import { describe, it, expect } from 'vitest';
import { clipboardCopyCommand } from '../clipboard';

describe('clipboardCopyCommand', () => {
  const has = (...bins: string[]) => (bin: string) => bins.includes(bin);

  it('uses pbcopy on macOS', () => {
    expect(clipboardCopyCommand(has('pbcopy'), 'darwin', {})).toBe('pbcopy');
  });

  it('uses clip.exe on Windows', () => {
    expect(clipboardCopyCommand(has('clip.exe'), 'win32', {})).toBe('clip.exe');
  });

  it('prefers wl-copy over xclip under a Wayland session', () => {
    expect(clipboardCopyCommand(has('wl-copy', 'xclip'), 'linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('wl-copy');
  });

  it('prefers xclip on X11 even when wl-copy is installed', () => {
    expect(clipboardCopyCommand(has('wl-copy', 'xclip'), 'linux', { DISPLAY: ':0' })).toBe('xclip -selection clipboard');
  });

  it('falls back to xsel, then to wl-copy', () => {
    expect(clipboardCopyCommand(has('xsel', 'wl-copy'), 'linux', {})).toBe('xsel --clipboard --input');
    expect(clipboardCopyCommand(has('wl-copy'), 'linux', {})).toBe('wl-copy');
  });

  it('is null when nothing is installed, leaving OSC 52 as the only path', () => {
    expect(clipboardCopyCommand(() => false, 'linux', {})).toBeNull();
  });
});
