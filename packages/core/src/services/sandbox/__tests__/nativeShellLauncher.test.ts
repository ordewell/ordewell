import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { createNativeShellLauncher, launcherScript, nativeShellInvocation } from '../nativeShellLauncher';
import { PlannerShellSandbox, plannerShellProfile, sealedShellProfile, type SealedAvailability } from '../plannerSandbox';
import type { SandboxBackend, SandboxProfile } from '../SandboxBackend';

/** A sandbox whose backend records the profile and reports a launch the script can hold. */
function fakeSandbox(profiles: SandboxProfile[] = []): PlannerShellSandbox {
  const backend: SandboxBackend = {
    name: 'fake',
    probe: async () => ({ ok: true }),
    wrap: (invocation, profile) => {
      profiles.push(profile);
      return {
        file: '/usr/bin/sandbox-exec',
        args: ['-p', 'PROFILE', '-D', 'WORKSPACE=/work/repo', invocation.shell, ...invocation.shellArgs],
        env: { ...invocation.env, ...profile.env },
      };
    },
  };
  const sealed: SealedAvailability = {
    available: true,
    profile: (opts) => sealedShellProfile({ platform: 'darwin', reads: ['/usr'], masked: [], overlay: false }, opts),
  };
  return new PlannerShellSandbox(async () => ({
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'darwin', services: [] }, opts),
    sealed,
  }));
}

describe('nativeShellInvocation', () => {
  it('runs a command with the user\'s own shell', () => {
    expect(nativeShellInvocation('darwin', {})).toEqual({ shell: '/bin/zsh', args: ['-c'] });
    expect(nativeShellInvocation('linux', { SHELL: '/usr/local/bin/fish' })).toEqual({ shell: '/usr/local/bin/fish', args: ['-c'] });
  });

  it('never takes a relative $SHELL, which would resolve against the workspace', () => {
    expect(nativeShellInvocation('linux', { SHELL: './bin/sh' })).toEqual({ shell: '/bin/sh', args: ['-c'] });
    expect(nativeShellInvocation('linux', {})).toEqual({ shell: '/bin/sh', args: ['-c'] });
  });
});

describe('launcherScript', () => {
  it('keeps the fixed launch as argv entries and hands the harness command over as one argument', () => {
    const script = launcherScript({
      file: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1)', '-D', "READ_0=/work/it's here", '/bin/zsh', '-c'],
      env: { PATH: '/usr/bin', HOME: '/tmp/s' },
    });
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('exec /usr/bin/env -i ');
    expect(script).toContain(`'-D' 'READ_0=/work/it'\\''s here'`);
    expect(script.trimEnd().endsWith(`'/usr/bin/sandbox-exec' '-p' '(version 1)' '-D' 'READ_0=/work/it'\\''s here' '/bin/zsh' '-c' "$command"`)).toBe(true);
    // Claude Code passes the whole command; OpenCode names a shell and appends
    // `-c <command>` (checked live on OpenCode 2.0.32).
    expect(script).toContain('case "$1" in\n  -c) command="$2" ;;\n  *) command="$1" ;;\nesac');
  });

  it('drops an environment name that cannot be an assignment', () => {
    const script = launcherScript({ file: '/bin/true', args: [], env: { 'A=B': 'x', KEPT: 'y' } });
    expect(script).toContain(`'KEPT=y'`);
    expect(script).not.toContain('A=B');
  });
});

// The launcher is a POSIX script with its short folder under `/tmp`, and
// `nativeShellOffer` never offers the opt-in on Windows.
describe.skipIf(process.platform === 'win32')('createNativeShellLauncher (ADR-0036 N2)', () => {
  it.each([
    ['darwin' as NodeJS.Platform, {}, '/bin/zsh'],
    ['linux' as NodeJS.Platform, { SHELL: '/bin/fish' }, '/bin/fish'],
  ])('builds a %s launcher around %s with a short writable temp folder', async (platform, env, shell) => {
    const sandbox = fakeSandbox();
    const launcher = await createNativeShellLauncher({ workspace: tmpdir(), sandbox, platform, env });
    try {
      const script = readFileSync(launcher.prefix, 'utf8');
      expect(script).toContain(`'${shell}' '-c' "$command"`);
      expect(statSync(launcher.prefix).mode & 0o777).toBe(0o700);
      expect(statSync(launcher.tmpdir).isDirectory()).toBe(true);
      expect(launcher.tmpdir.length).toBeLessThan(30);
      expect(launcher.prefix.startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(launcher.env).toEqual({ CLAUDE_CODE_SHELL_PREFIX: launcher.prefix, CLAUDE_CODE_TMPDIR: launcher.tmpdir });
    } finally {
      launcher.remove();
      sandbox.end();
    }
    expect(existsSync(launcher.prefix)).toBe(false);
    expect(existsSync(launcher.tmpdir)).toBe(false);
  });

  it('gives the sealed profile the workspace read-only, the scratch and the short folder writable, and the network (N2, N3)', async () => {
    const profiles: SandboxProfile[] = [];
    const sandbox = fakeSandbox(profiles);
    const launcher = await createNativeShellLauncher({ workspace: tmpdir(), sandbox, platform: 'darwin' });
    try {
      const profile = profiles[0];
      expect(profile.read).toContain(realpathSync(tmpdir()));
      expect(profile.write).toContain(realpathSync(launcher.tmpdir));
      expect(profile.write).toContain(profile.env.TMPDIR);
      expect(profile.network).toBe(true);
      // The harness's own server and Ordewell's daemon listen on loopback and
      // run what they are asked outside the sandbox.
      expect(profile.localNetwork).toBe(false);
      // The launcher itself is outside every writable directory: a command
      // must not be able to rewrite what the next command starts through.
      expect(profile.write).not.toContain(launcher.prefix);
      expect(profile.write.some((dir) => launcher.prefix.startsWith(`${dir}/`))).toBe(false);
    } finally {
      launcher.remove();
      sandbox.end();
    }
  });
});
