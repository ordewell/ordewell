import { basename } from 'node:path';

/**
 * Which shell a terminal starts and with what environment (design: Terminal
 * rule). The user's own: `SHELL` is their login shell, and PowerShell is what a
 * Windows user opens a terminal into. Pure, so every platform's answer is
 * testable from any host.
 */

export interface ShellChoice {
  file: string;
  args: string[];
}

export function shellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ShellChoice {
  if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  const file = env.SHELL && env.SHELL.trim() !== '' ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  // A Dock or launcher start never ran the user's profile, so macOS shells
  // read it here, as other terminals there do. Elsewhere the desktop session
  // already did, and a second pass would only repeat it.
  return { file, args: platform === 'darwin' ? ['-l'] : [] };
}

/** The shell's name as the tab shows it: `zsh`, `powershell`. */
export function shellName(file: string): string {
  return basename(file).replace(/\.exe$/i, '');
}

/** Variables that describe this Electron process, not the user's session: a shell inheriting them would run its own `node` as Electron. */
const HOST_VARIABLES = /^(ELECTRON_|ORDEWELL_DESKTOP_)/;

/** The environment a terminal starts with: the user's, minus this app's own, with the terminal type set. */
export function terminalEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || HOST_VARIABLES.test(key)) continue;
    env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Ordewell';
  return env;
}
