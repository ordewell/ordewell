import { describe, it, expect } from 'vitest';
import { tmuxSessionName, tmuxWindowName, hasTmux, clipboardCopyCommand } from '../tmux';

describe('tmuxSessionName', () => {
  it('scopes the session to the daemon port', () => {
    expect(tmuxSessionName(3742)).toBe('ordewell-3742');
  });
});

describe('tmuxWindowName', () => {
  it('prefixes and keeps a short alnum slug of the task id', () => {
    expect(tmuxWindowName('task-1234-abcd')).toBe('t-task1234abcd');
  });

  it('strips characters tmux window targeting would choke on', () => {
    expect(tmuxWindowName('a:b.c d/e')).toBe('t-abcde');
  });

  it('truncates long task ids to keep window names short', () => {
    expect(tmuxWindowName('a'.repeat(40))).toBe(`t-${'a'.repeat(16)}`);
  });

  it('scopes the window by plan session so identical task ids in two plans never collide', () => {
    const a = tmuxWindowName('task-1', 'session-1753000042111');
    const b = tmuxWindowName('task-1', 'session-1753000098222');
    expect(a).toBe('t-042111-task1');
    expect(b).toBe('t-098222-task1');
    expect(a).not.toBe(b);
  });
});

describe('hasTmux', () => {
  it('is true when the probe command succeeds', () => {
    expect(hasTmux(() => {})).toBe(true);
  });

  it('is false when the probe command throws', () => {
    expect(hasTmux(() => { throw new Error('not found'); })).toBe(false);
  });
});

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
