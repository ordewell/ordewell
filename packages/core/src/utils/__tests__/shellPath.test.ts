import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { augmentedPath, clearAugmentedPathCache, wellKnownBinDirs } from '../shellPath';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('augmentedPath', () => {
  beforeEach(() => clearAugmentedPathCache());
  afterEach(() => clearAugmentedPathCache());

  it('merges the login-shell PATH over the current PATH, deduplicated', async () => {
    const exec = async () => ({
      stdout: `motd noise\n__ORDEWELL_PATH__/login/bin:/usr/bin__ORDEWELL_PATH__\n`,
    });

    const result = await augmentedPath(exec);
    const segments = result.split(path.delimiter);

    for (const seg of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      expect(segments).toContain(seg);
    }
    expect(segments).toContain('/login/bin');
    expect(segments.filter((s) => s === '/usr/bin')).toHaveLength(1);
  });

  it('extracts PATH between markers even with profile noise on the same line', async () => {
    const exec = async () => ({ stdout: `prefix __ORDEWELL_PATH__/only/bin__ORDEWELL_PATH__ suffix` });

    const segments = (await augmentedPath(exec)).split(path.delimiter);
    expect(segments).toContain('/only/bin');
  });

  it('falls back to well-known per-user bin dirs when the login shell fails', async () => {
    const exec = async () => { throw new Error('shell blew up'); };

    const segments = (await augmentedPath(exec)).split(path.delimiter);
    expect(segments.some((s) => s.endsWith('/.local/bin'))).toBe(true);
    expect(segments.some((s) => s.endsWith('/.opencode/bin'))).toBe(true);
  });

  it('caches the resolution for the process lifetime', async () => {
    let calls = 0;
    const exec = async () => { calls++; return { stdout: '__ORDEWELL_PATH__/x__ORDEWELL_PATH__' }; };

    await augmentedPath(exec);
    await augmentedPath(exec);
    expect(calls).toBe(1);
  });
});

/**
 * On Windows there is no login shell to query, so this list is the entire
 * safety net: a directory missing from it is a runner the picker greys out
 * while the user is looking at the install that just succeeded.
 */
describe('wellKnownBinDirs on Windows', () => {
  const HOME = 'C:\\Users\\me';
  const ENV: NodeJS.ProcessEnv = {
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
  };
  const dirs = (env: NodeJS.ProcessEnv = ENV) => wellKnownBinDirs({ platform: 'win32', env, home: HOME });

  // The regression this list exists for: `irm https://claude.ai/install.ps1 |
  // iex` is the documented Windows install of the flagship runner, and it
  // writes here. `.local\bin` was in the POSIX list and missing from this one.
  it('covers the PowerShell one-liner installers', () => {
    expect(dirs()).toContain('C:\\Users\\me\\.local\\bin');
    expect(dirs()).toContain('C:\\Users\\me\\.opencode\\bin');
  });

  it('covers the Node package managers, which do not share a prefix', () => {
    const d = dirs();
    expect(d).toContain('C:\\Users\\me\\AppData\\Roaming\\npm');
    expect(d).toContain('C:\\Users\\me\\AppData\\Local\\pnpm');
    expect(d).toContain('C:\\Users\\me\\AppData\\Local\\Yarn\\bin');
    expect(d).toContain('C:\\Users\\me\\.bun\\bin');
  });

  it('covers the Windows package managers', () => {
    const d = dirs();
    expect(d).toContain('C:\\Users\\me\\scoop\\shims');
    expect(d).toContain('C:\\ProgramData\\chocolatey\\bin');
    // WinGet portable packages land in Links; WindowsApps is MSIX only, so
    // neither substitutes for the other.
    expect(d).toContain('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links');
    expect(d).toContain('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps');
  });

  it('spells Volta the Windows way as well as the POSIX way', () => {
    expect(dirs()).toContain('C:\\Users\\me\\AppData\\Local\\Volta\\bin');
  });

  it('honours a relocated Scoop root', () => {
    expect(dirs({ ...ENV, SCOOP: 'D:\\scoop' })).toContain('D:\\scoop\\shims');
  });

  // A service account or a stripped container exports none of these; the
  // home-relative entries must still come through rather than the list
  // collapsing to nothing.
  it('degrades to the home-relative entries when the environment is bare', () => {
    const d = dirs({});
    expect(d).toContain('C:\\Users\\me\\.local\\bin');
    expect(d).toContain('C:\\Users\\me\\AppData\\Roaming\\npm');
    expect(d.every((p) => p.startsWith('C:\\Users\\me'))).toBe(true);
  });

  it('emits no duplicates, since APPDATA usually restates the literal npm path', () => {
    const d = dirs();
    expect(new Set(d).size).toBe(d.length);
  });

  it('leaves the POSIX list alone', () => {
    const d = wellKnownBinDirs({ platform: 'linux', env: ENV, home: HOME });
    expect(d).toContain('/opt/homebrew/bin');
    expect(d.some((p) => p.includes('scoop'))).toBe(false);
  });
});
