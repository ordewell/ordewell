import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { resolveWithin, resolveRef, grantScopeFor } from '../pathScope';
import { mountedHostPath, parseMounts } from '../researchShell';

// The fixtures are POSIX paths; on Windows `/repo` resolves to `<drive>:\repo`,
// and containment is judged the same way in either spelling.
const abs = (p: string) => path.resolve(p);
const scope = (dir: string) => path.join(abs(dir), '*');

describe('resolveWithin', () => {
  it('marks an inside path as inside and returns the absolute form', () => {
    expect(resolveWithin('/repo', 'src/a.ts')).toEqual({ abs: abs('/repo/src/a.ts'), inside: true });
  });

  it('marks the root itself as inside', () => {
    expect(resolveWithin('/repo', '.')).toEqual({ abs: abs('/repo'), inside: true });
    expect(resolveWithin('/repo', '/repo')).toEqual({ abs: abs('/repo'), inside: true });
  });

  it('flags a parent escape', () => {
    const r = resolveWithin('/repo', '../../etc/passwd');
    expect(r.inside).toBe(false);
    expect(r.abs).toBe(abs('/etc/passwd'));
  });

  it('flags an absolute path outside the root', () => {
    expect(resolveWithin('/repo', '/etc/passwd').inside).toBe(false);
  });

  // Unexpanded, `~/.ssh/id_rsa` resolves to `/repo/~/.ssh/id_rsa` and reads as
  // inside the workspace — so an auto-tier `cat ~/.ssh/id_rsa` passed
  // confinement with no prompt, and the shell then expanded `~` for real.
  it('expands ~ so a home-relative path is not mistaken for an inside path', () => {
    const r = resolveWithin('/repo', '~/.ssh/id_rsa');
    expect(r.abs).toBe(path.join(os.homedir(), '.ssh', 'id_rsa'));
    expect(r.inside).toBe(false);
    expect(resolveWithin('/repo', '~').abs).toBe(os.homedir());
  });

  it('keeps ~otheruser outside the workspace rather than resolving it into one', () => {
    expect(resolveWithin('/repo', '~someone/notes.txt').inside).toBe(false);
  });
});

describe('a path as the shell running it reads one (ADR-0010)', () => {
  // A shell that mounts the workspace at /w, as Git Bash mounts a drive at /c.
  const mounted = (p: string) => (p.startsWith('/w/') ? `/repo/${p.slice(3)}` : p);

  it('judges where the shell puts a path, and a cd target too', () => {
    expect(resolveWithin('/repo', '/w/src/a.ts', '/repo', mounted)).toEqual({ abs: abs('/repo/src/a.ts'), inside: true });
    expect(resolveRef('/repo', { path: 'a.ts', cwd: ['/w/src'] }, mounted)).toEqual({ abs: abs('/repo/src/a.ts'), inside: true });
    expect(resolveRef('/repo', { path: '/etc/passwd', cwd: [] }, mounted).inside).toBe(false);
  });

  // Resolved as a host path, Git Bash's `/dev/null` was `<drive>:\dev\null`, so
  // `diff a /dev/null` asked to reach a folder that is not there.
  it('takes a device the shell provides as no place on disk', () => {
    expect(resolveWithin('/repo', '/dev/null', '/repo', mounted)).toEqual({ abs: '/dev/null', inside: false, device: true });
  });

  // No approval could name the folder such a path reaches, so it is judged nowhere, and after a `cd` to one, so is every path.
  it('judges a path the shell reads by rules it cannot follow to be nowhere, and every path after a cd to one', () => {
    const unsure = (p: string) => (p.startsWith('/proc') ? undefined : mounted(p));
    expect(resolveWithin('/repo', '/proc/registry', '/repo', unsure)).toEqual({ abs: '/proc/registry', inside: false, unfollowable: true });
    expect(resolveRef('/repo', { path: 'a.ts', cwd: ['/proc'] }, unsure)).toEqual({ abs: 'a.ts', inside: false, unfollowable: true });
  });
});

describe.runIf(process.platform === 'win32')('a path through Git Bash on a Windows host', () => {
  const table = parseMounts('C:/Program Files/Git on / type ntfs (binary)\nC: on /c type ntfs (binary,posix=0)', '')!;
  const hostPath = (p: string, from: string) => mountedHostPath(table, p, from);

  // Read on the host's drive, `/c/Users/me` was `C:\c\Users\me`: inside a workspace at `C:\c`, though the shell reads `C:\Users\me`.
  it('keeps a drive path out of a workspace that only shares its spelling', () => {
    expect(resolveWithin('C:\\c', '/c/Users/me/.ssh/id_rsa', 'C:\\c').inside).toBe(true);
    expect(resolveWithin('C:\\c', '/c/Users/me/.ssh/id_rsa', 'C:\\c', hostPath)).toEqual({ abs: 'C:\\Users\\me\\.ssh\\id_rsa', inside: false });
    expect(resolveWithin('C:\\Users\\me\\repo', '/c/Users/me/repo/src', 'C:\\Users\\me\\repo', hostPath).inside).toBe(true);
  });
});

describe('grantScopeFor', () => {
  it('scopes a file grant to its containing directory', () => {
    expect(grantScopeFor(abs('/tmp/dump/a.log'), 'file')).toBe(scope('/tmp/dump'));
  });

  it('scopes a directory grant to itself', () => {
    expect(grantScopeFor(abs('/tmp/dump'), 'directory')).toBe(scope('/tmp/dump'));
  });

  // A path immediately under the filesystem root has `/` as its parent;
  // scoping to `/*` would approve every top-level directory in one click.
  it('does not collapse a root-level path to /*', () => {
    expect(grantScopeFor(abs('/etc'), 'file')).toBe(scope('/etc'));
    expect(grantScopeFor(abs('/etc/hosts'), 'file')).toBe(scope('/etc'));
  });
});
