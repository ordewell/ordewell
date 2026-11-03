import { describe, expect, it } from 'vitest';
import { shellFor, shellName, terminalEnv } from '../shellChoice';

describe('shellFor', () => {
  it('uses the user\'s SHELL, as a login shell on macOS only', () => {
    expect(shellFor('darwin', { SHELL: '/opt/homebrew/bin/fish' })).toEqual({ file: '/opt/homebrew/bin/fish', args: ['-l'] });
    expect(shellFor('linux', { SHELL: '/usr/bin/zsh' })).toEqual({ file: '/usr/bin/zsh', args: [] });
  });

  it('falls back to the platform default when SHELL is unset or blank', () => {
    expect(shellFor('darwin', {}).file).toBe('/bin/zsh');
    expect(shellFor('linux', { SHELL: '  ' }).file).toBe('/bin/bash');
  });

  it('opens PowerShell on Windows, whatever SHELL says', () => {
    expect(shellFor('win32', { SHELL: 'C:\\Git\\bin\\bash.exe' })).toEqual({ file: 'powershell.exe', args: ['-NoLogo'] });
  });
});

describe('shellName', () => {
  it('is the program without its folder or .exe', () => {
    expect(shellName('/bin/zsh')).toBe('zsh');
    expect(shellName('powershell.exe')).toBe('powershell');
  });
});

describe('terminalEnv', () => {
  it('keeps the user\'s environment, drops this app\'s own, and sets the terminal type', () => {
    const env = terminalEnv({ HOME: '/h', PATH: '/a:/b', ELECTRON_RUN_AS_NODE: '1', ORDEWELL_DESKTOP_DEV_URL: 'http://x', GONE: undefined });
    expect(env.HOME).toBe('/h');
    expect(env.PATH).toBe('/a:/b');
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(env).not.toHaveProperty('ORDEWELL_DESKTOP_DEV_URL');
    expect(env).not.toHaveProperty('GONE');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
  });
});
