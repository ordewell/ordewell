import * as os from 'os';
import { describe, it, expect } from 'vitest';
import { resolveWithin, grantScopeFor } from '../pathScope';

describe('resolveWithin', () => {
  it('marks an inside path as inside and returns the absolute form', () => {
    expect(resolveWithin('/repo', 'src/a.ts')).toEqual({ abs: '/repo/src/a.ts', inside: true });
  });

  it('marks the root itself as inside', () => {
    expect(resolveWithin('/repo', '.')).toEqual({ abs: '/repo', inside: true });
    expect(resolveWithin('/repo', '/repo')).toEqual({ abs: '/repo', inside: true });
  });

  it('flags a parent escape', () => {
    const r = resolveWithin('/repo', '../../etc/passwd');
    expect(r.inside).toBe(false);
    expect(r.abs).toBe('/etc/passwd');
  });

  it('flags an absolute path outside the root', () => {
    expect(resolveWithin('/repo', '/etc/passwd').inside).toBe(false);
  });

  // Unexpanded, `~/.ssh/id_rsa` resolves to `/repo/~/.ssh/id_rsa` and reads as
  // inside the workspace — so an auto-tier `cat ~/.ssh/id_rsa` passed
  // confinement with no prompt, and the shell then expanded `~` for real.
  it('expands ~ so a home-relative path is not mistaken for an inside path', () => {
    const r = resolveWithin('/repo', '~/.ssh/id_rsa');
    expect(r.abs).toBe(`${os.homedir()}/.ssh/id_rsa`);
    expect(r.inside).toBe(false);
    expect(resolveWithin('/repo', '~').abs).toBe(os.homedir());
  });

  it('keeps ~otheruser outside the workspace rather than resolving it into one', () => {
    expect(resolveWithin('/repo', '~someone/notes.txt').inside).toBe(false);
  });
});

describe('grantScopeFor', () => {
  it('scopes a file grant to its containing directory', () => {
    expect(grantScopeFor('/tmp/dump/a.log', 'file')).toBe('/tmp/dump/*');
  });

  it('scopes a directory grant to itself', () => {
    expect(grantScopeFor('/tmp/dump', 'directory')).toBe('/tmp/dump/*');
  });

  // A path immediately under the filesystem root has `/` as its parent;
  // scoping to `/*` would approve every top-level directory in one click.
  it('does not collapse a root-level path to /*', () => {
    expect(grantScopeFor('/etc', 'file')).toBe('/etc/*');
    expect(grantScopeFor('/etc/hosts', 'file')).toBe('/etc/*');
  });
});