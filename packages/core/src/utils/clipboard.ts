import { execSync } from 'child_process';

export type HasBinFn = (bin: string) => boolean;

const defaultHasBin: HasBinFn = (bin) => {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Shell command tmux should pipe a copy-mode selection into, so selecting text
 * in a tmux pane puts it on the *system* clipboard rather than in a tmux
 * paste buffer no other application can read. Preferred over tmux's OSC 52
 * bridge, which plenty of emulators (VTE before 0.76, xterm without
 * `allowWindowOps`) drop on the floor.
 */
export function clipboardCopyCommand(
  hasBin: HasBinFn = defaultHasBin,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: [string, string][] =
    platform === 'darwin'
      ? [['pbcopy', 'pbcopy']]
      : platform === 'win32'
        ? [['clip.exe', 'clip.exe']]
        : [
            // Only prefer wl-copy when there is a Wayland display to talk to —
            // on X11 it is often installed but fails at copy time.
            ...(env.WAYLAND_DISPLAY ? ([['wl-copy', 'wl-copy']] as [string, string][]) : []),
            ['xclip', 'xclip -selection clipboard'],
            ['xsel', 'xsel --clipboard --input'],
            ['wl-copy', 'wl-copy'],
          ];
  for (const [bin, command] of candidates) {
    if (hasBin(bin)) return command;
  }
  return null;
}
