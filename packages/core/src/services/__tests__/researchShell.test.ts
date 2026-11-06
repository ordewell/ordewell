import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import {
  resolveResearchShell,
  clearResearchShellCache,
  researchToolsPath,
  researchShellWarning,
  parseMounts,
  mountedHostPath,
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

// What Git Bash's `mount` and `mount -p` print on a Windows host.
const MOUNT = [
  'C:/Program Files/Git on / type ntfs (binary,noacl,auto)',
  'C:/Program Files/Git/usr/bin on /bin type ntfs (binary,noacl,auto)',
  'C:/Users/me/AppData/Local/Temp on /tmp type ntfs (binary,noacl,posix=0,usertemp)',
  'C: on /c type ntfs (binary,noacl,posix=0,user,noumount,auto)',
  'F: on /f type ntfs (binary,noacl,posix=0,user,noumount,auto)',
].join('\n');
const PREFIX = 'Prefix              Type         Flags\n/                   user         binmode\n';
const WORKSPACE = 'F:\\work\\repo';

describe('a path through Git Bash (ADR-0010)', () => {
  beforeEach(() => clearResearchShellCache());
  const gitBash = (env: NodeJS.ProcessEnv = {}) => resolveResearchShell({ ...win([GIT_BASH], env), readMounts: () => [MOUNT, PREFIX] }).hostPath!;

  // The classifier judged `/etc/passwd` as `<drive>:\\etc\\passwd` and `/c/x` as
  // `<drive>:\\c\\x`, so the folder a user approved was not the one the shell
  // reached, and a workspace at `<drive>:\\c` held paths that were not in it.
  it('reads a POSIX path where the shell\'s mount table puts it', () => {
    const read = (spelled: string) => gitBash()(spelled, WORKSPACE);
    expect(read('/c/Users/me/.ssh/id_rsa')).toBe('C:\\Users\\me\\.ssh\\id_rsa');
    expect(read('/C/x')).toBe('C:\\x');
    expect(read('/q/x')).toBe('Q:\\x');
    expect(read('/etc/passwd')).toBe('C:\\Program Files\\Git\\etc\\passwd');
    expect(read('/bin/grep')).toBe('C:\\Program Files\\Git\\usr\\bin\\grep');
    expect(read('/tmpx/a')).toBe('C:\\Program Files\\Git\\tmpx\\a');
    expect(read('//srv/share/x')).toBe('\\\\srv\\share\\x');
    // A backslash separates, as Git Bash reads one.
    expect(read('/c\\Users\\me\\.ssh')).toBe('C:\\Users\\me\\.ssh');
    // Its /proc/cygdrive is the drive prefix.
    expect(read('/proc/cygdrive/c/Users/me')).toBe('C:\\Users\\me');
  });

  // A `posix=0` mount (the drives, `/tmp`) matches in any case; the others only
  // as spelled, so `/BIN` is a folder of the install, not `/bin`.
  it('matches a mount point in any case only where Git Bash does', () => {
    const read = (spelled: string) => gitBash()(spelled, WORKSPACE);
    expect(read('/TMP/x')).toBe('C:\\Users\\me\\AppData\\Local\\Temp\\x');
    expect(read('/BIN/x')).toBe('C:\\Program Files\\Git\\BIN\\x');
  });

  // Git Bash climbs `/tmp/..` on disk and `/bin/..` by name, reads
  // `../../c/Users` from `F:\\work` as `C:\\Users`, and keeps /proc and /dev of its
  // own: no folder an approval could name is the one these reach.
  it('follows nothing it cannot be sure of', () => {
    const read = (spelled: string, from = WORKSPACE) => gitBash()(spelled, from);
    for (const spelled of ['/tmp/../x', '/bin/../x', '/c/x/../y', '/proc/registry/HKEY_CURRENT_USER', '/dev/clipboard', '/dev\\null', '../../../c/Users/me']) {
      expect(read(spelled)).toBeUndefined();
    }
    expect(read('../x')).toBe('../x');
    expect(read('../../x')).toBe('../../x');
    // Below one of its other mounts, `..` climbs in ways no one reading can follow.
    expect(read('../x', 'C:\\Program Files\\Git\\usr')).toBeUndefined();
  });

  it('leaves the shell\'s devices, and every path the host reads as Git Bash does, as spelled', () => {
    for (const spelled of ['/dev/null', '/dev/stdin', 'src/a.ts', '~/.ssh', 'C:\\x', 'C:/x', '\\Users\\x']) expect(gitBash()(spelled, WORKSPACE)).toBe(spelled);
  });

  it('reads ~ as the HOME Git Bash would use', () => {
    expect(gitBash({ HOME: '/c/Users/me' })('~/.ssh/id_rsa', WORKSPACE)).toBe('C:\\Users\\me\\.ssh\\id_rsa');
    expect(gitBash({ HOME: 'D:\\home' })('~', WORKSPACE)).toBe('D:\\home');
  });

  it('asks the shell once, on the first path that needs it', () => {
    let reads = 0;
    const { hostPath } = resolveResearchShell({ ...win([GIT_BASH]), readMounts: () => { reads++; return [MOUNT, PREFIX]; } });
    hostPath!('src/a.ts', WORKSPACE);
    expect(reads).toBe(0);
    hostPath!('/c/a', WORKSPACE);
    hostPath!('/etc/b', WORKSPACE);
    expect(reads).toBe(1);
  });

  it('stands in Git for Windows\' own table when the shell cannot be asked', () => {
    const { hostPath } = resolveResearchShell({ ...win([GIT_BASH], { TEMP: 'C:\\Temp' }), readMounts: () => undefined });
    expect(hostPath!('/etc/x', WORKSPACE)).toBe('C:\\Program Files\\Git\\etc\\x');
    expect(hostPath!('/tmp/x', WORKSPACE)).toBe('C:\\Temp\\x');
    expect(hostPath!('/d/x', WORKSPACE)).toBe('D:\\x');
  });

  it('puts the drives under the prefix the table names', () => {
    const table = parseMounts('D:/Git on / type ntfs (binary)', 'Prefix Type Flags\n/cygdrive user binmode\n')!;
    expect(mountedHostPath(table, '/cygdrive/e/x')).toBe('E:\\x');
    expect(mountedHostPath(table, '/e/x')).toBe('D:\\Git\\e\\x');
    expect(parseMounts('', PREFIX)).toBeUndefined();
  });
});

describe.runIf(process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\usr\\bin\\cygpath.exe'))('a path through a real Git Bash', () => {
  it('lands where Git\'s own cygpath says it does, or nowhere at all', () => {
    const { hostPath } = resolveResearchShell({ platform: 'win32', env: process.env });
    const from = process.cwd();
    // No program's name: cygpath gives one its `.exe`.
    const spellings = ['/c/Users/x', '/C/x', '/tmp/a b', '/TMP/x', '/etc/passwd', '/bin/x', '/BIN/x', '/usr/bin/x', '/mingw64/bin', '//srv/share/x', '/c\\Users\\x', '/proc/cygdrive/c/Users/x'];
    const cygpath = execFileSync('C:\\Program Files\\Git\\usr\\bin\\cygpath.exe', ['-w', ...spellings], { encoding: 'utf8' }).trim().split(/\r?\n/);
    expect(spellings.map((s) => hostPath!(s, from)?.toLowerCase())).toEqual(cygpath.map((p) => p.toLowerCase()));
    for (const spelled of ['/tmp/../x', '/proc/registry/HKEY_CURRENT_USER', '/dev/clipboard']) expect(hostPath!(spelled, from)).toBeUndefined();
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
