import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveResearchShell,
  clearResearchShellCache,
  researchToolsPath,
  researchShellWarning,
} from '../researchShell';

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const GIT_GREP = 'C:\\Program Files\\Git\\usr\\bin\\grep.exe';

function win(files: string[], env: NodeJS.ProcessEnv = {}) {
  const present = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32' as NodeJS.Platform,
    exists: (candidate: string) => present.has(candidate.toLowerCase()),
    env,
  };
}

describe('resolveResearchShell', () => {
  beforeEach(() => clearResearchShellCache());

  // `file: null` is the contract for "use `shell: true`" — the exact call the
  // adapters made before this module existed. POSIX must not change at all.
  it('resolves to the host default with the POSIX dialect on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
      expect(resolveResearchShell({ platform })).toEqual({
        file: null, args: [], dialect: 'posix', utilsDir: null,
      });
    }
  });

  it('does not probe the filesystem on POSIX', () => {
    let touched = false;
    resolveResearchShell({ platform: 'linux', exists: () => { touched = true; return true; } });
    expect(touched).toBe(false);
  });

  it('finds the Git for Windows shell and reports the POSIX dialect', () => {
    const shell = resolveResearchShell(win([GIT_BASH, GIT_GREP]));
    expect(shell.file).toBe(GIT_BASH);
    // `-c`, not `-lc`: a login shell can `cd` out of the workspace via profile.
    expect(shell.args).toEqual(['-c']);
    expect(shell.dialect).toBe('posix');
    expect(shell.utilsDir).toBe('C:\\Program Files\\Git\\usr\\bin');
  });

  it('finds the MSYS-tree shell when the bin wrapper is absent', () => {
    const shell = resolveResearchShell(win(['C:\\Program Files\\Git\\usr\\bin\\bash.exe']));
    expect(shell.file).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
    expect(shell.dialect).toBe('posix');
  });

  it('honours a per-user Git install found through LOCALAPPDATA', () => {
    const file = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    const shell = resolveResearchShell(win([file], { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }));
    expect(shell.file).toBe(file);
  });

  // The one candidate that must never be picked. WSL's bash sees `/mnt/c/...`,
  // so every workspace path would mean a different file than the one path
  // confinement is checking, and every relative path would resolve elsewhere.
  it('never selects the WSL launcher in System32', () => {
    const shell = resolveResearchShell(win(['C:\\Windows\\System32\\bash.exe']));
    expect(shell.file).toBeNull();
    expect(shell.dialect).toBe('cmd');
  });

  it('falls back to cmd.exe and says so, so the classifier lexes the same language', () => {
    const shell = resolveResearchShell(win([]));
    expect(shell).toEqual({ file: null, args: [], dialect: 'cmd', utilsDir: null });
  });

  it('leaves utilsDir null when the shell brings no grep', () => {
    expect(resolveResearchShell(win([GIT_BASH])).utilsDir).toBeNull();
  });

  it('caches only the unparameterised resolution', () => {
    let probes = 0;
    const counting = { ...win([GIT_BASH]), exists: (c: string) => { probes++; return c === GIT_BASH; } };
    resolveResearchShell(counting);
    resolveResearchShell(counting);
    expect(probes).toBeGreaterThan(2);
  });
});

describe('researchToolsPath', () => {
  it('is the identity when the shell brings no utilities', () => {
    const shell = { file: null, args: [], dialect: 'posix' as const, utilsDir: null };
    expect(researchToolsPath(shell, '/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });

  // Without this, `grep` — the fallback when ripgrep is absent — is
  // unresolvable by `execFile` even with a working grep.exe on the box.
  it('prepends the utilities directory so execFile can resolve grep', () => {
    const shell = { file: GIT_BASH, args: ['-c'], dialect: 'posix' as const, utilsDir: 'C:\\Git\\usr\\bin' };
    expect(researchToolsPath(shell, 'C:\\Windows;C:\\tools')).toBe('C:\\Git\\usr\\bin;C:\\Windows;C:\\tools');
  });

  it('does not duplicate a directory already on PATH', () => {
    const shell = { file: GIT_BASH, args: ['-c'], dialect: 'posix' as const, utilsDir: 'C:\\Git\\usr\\bin' };
    expect(researchToolsPath(shell, 'C:\\Git\\usr\\bin;C:\\Windows')).toBe('C:\\Git\\usr\\bin;C:\\Windows');
  });
});

describe('researchShellWarning', () => {
  it('says nothing when the research surface is intact', () => {
    expect(researchShellWarning({ file: null, args: [], dialect: 'posix', utilsDir: null })).toBeNull();
  });

  it('explains the degradation and names the fix under cmd.exe', () => {
    const warning = researchShellWarning({ file: null, args: [], dialect: 'cmd', utilsDir: null });
    expect(warning).toContain('cmd.exe');
    expect(warning).toContain('Git for Windows');
  });
});
