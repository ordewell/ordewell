import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  PlannerShellSandbox,
  clearPlannerSandboxCache,
  plannerShellProfile,
  resolvePlannerSandbox,
  sandboxedFailureNote,
  sealedShellProfile,
  sweepOrphanScratch,
  PLANNER_SANDBOX_DOCS,
  SEALED_LIMITS,
  type PlannerSandboxAvailability,
  type SealedAvailability,
} from '../plannerSandbox';
import type { ProbeExec, SandboxBackend, SandboxProfile } from '../SandboxBackend';
import { classifyOutcome } from '../../researchStepSummary';
import type { ResearchShell } from '../../researchShell';

const POSIX: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };

function recordingExec(result: { code: number | null; output: string }): { exec: ProbeExec; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  return { calls, exec: async (file, args) => { calls.push({ file, args }); return result; } };
}

function linux(files: string[], exec: ProbeExec, extra: { env?: NodeJS.ProcessEnv; dirs?: string[] } = {}) {
  const present = new Set(files);
  const dirs = new Set([...(extra.dirs ?? []), '/usr', '/bin', '/work']);
  return {
    platform: 'linux' as NodeJS.Platform,
    env: extra.env ?? { PATH: '/usr/bin:/bin' },
    exists: (f: string) => present.has(f),
    stat: (p: string) => (dirs.has(p) ? { canonical: p, directory: true } : null),
    uid: 1000,
    exec,
    probeWorkspace: '/work',
  };
}

/** An exec that answers each call with the next result, the last one for the rest. */
function scriptedExec(results: Array<{ code: number | null; output: string }>): { exec: ProbeExec; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  return { calls, exec: async (file, args) => { calls.push({ file, args }); return results[Math.min(calls.length - 1, results.length - 1)]; } };
}

function sealedOf(availability: PlannerSandboxAvailability): SealedAvailability {
  if (!availability.available) throw new Error('expected a sandbox');
  return availability.sealed;
}

function unavailableNotice(availability: PlannerSandboxAvailability): string {
  if (availability.available) throw new Error('expected no sandbox');
  return availability.notice;
}

describe('resolvePlannerSandbox', () => {
  afterEach(() => clearPlannerSandboxCache());

  it('has no sandbox on Windows, and says so without probing anything', async () => {
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const notice = unavailableNotice(await resolvePlannerSandbox({ platform: 'win32', exec }));
    expect(notice).toContain("The planner's shell runs without an OS sandbox on this machine: Windows has no sandbox");
    expect(notice).toContain("Ordewell's command rules");
    expect(notice).toContain(PLANNER_SANDBOX_DOCS);
    expect(calls).toEqual([]);
  });

  it('names bubblewrap and how to install it when Linux has none', async () => {
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const notice = unavailableNotice(await resolvePlannerSandbox(linux([], exec)));
    expect(notice).toContain('bubblewrap (bwrap) is not installed');
    expect(notice).toContain('sudo apt install bubblewrap');
    expect(calls).toEqual([]);
  });

  it("names Ubuntu's user-namespace restriction and both fixes when bubblewrap cannot start", async () => {
    const { exec } = recordingExec({ code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' });
    const notice = unavailableNotice(await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec)));
    expect(notice).toContain('bubblewrap could not start (bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted)');
    expect(notice).toContain('AppArmor profile for bwrap');
    expect(notice).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  });

  it('probes bubblewrap once with the stricter profile: no network, and the local services masked', async () => {
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const availability = await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec, {
      env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
      dirs: ['/run/user/1000', '/tmp/.X11-unix'],
    }));
    expect(availability.available).toBe(true);
    // The planner's profile, then the sealed one.
    expect(calls).toHaveLength(2);
    const args = calls[0].args.join(' ');
    expect(calls[0].file).toBe('/usr/bin/bwrap');
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--tmpfs /run/user/1000');
    expect(args).toContain('--tmpfs /tmp/.X11-unix');
    expect(args).not.toContain('--bind ');
    expect(args.endsWith('-- /bin/sh -c true')).toBe(true);
  });

  it('probes Seatbelt by running sandbox-exec, and reports one that cannot start', async () => {
    const ok = recordingExec({ code: 0, output: '' });
    expect((await resolvePlannerSandbox({ platform: 'darwin', exists: () => true, exec: ok.exec })).available).toBe(true);
    expect(ok.calls[0].file).toBe('/usr/bin/sandbox-exec');

    const failing = recordingExec({ code: 71, output: 'sandbox-exec: sandbox_apply: Operation not permitted' });
    const notice = unavailableNotice(await resolvePlannerSandbox({ platform: 'darwin', exists: () => true, exec: failing.exec }));
    expect(notice).toContain('Seatbelt could not start (sandbox-exec: sandbox_apply: Operation not permitted)');
    expect(notice).not.toContain('AppArmor');
  });

  it('probes a sealed run with its own profile, overlay first, then read-only where the overlay cannot start (ADR-0036 S1)', async () => {
    const { exec, calls } = scriptedExec([{ code: 0, output: '' }, { code: 1, output: 'bwrap: Unknown option --overlay-src' }, { code: 0, output: '' }]);
    const sealed = sealedOf(await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec)));
    expect(sealed.available).toBe(true);
    expect(calls).toHaveLength(3);
    const [overlay, readOnly] = [calls[1], calls[2]].map((call) => call.args.join(' '));
    expect(calls[1].file).toBe('/bin/sh');
    expect(overlay).toContain('--overlay-src /work --tmp-overlay /work');
    expect(readOnly).toContain('--ro-bind /work /work');
    expect(readOnly).not.toContain('--overlay-src');
    expect(readOnly).toContain('--ro-bind /usr /usr --ro-bind /bin /bin');
    expect(readOnly).not.toContain('--ro-bind / /');
    if (sealed.available) expect(sealed.profile({ workspace: '/work/repo' }).throwaway).toBeUndefined();
  });

  it('keeps the sandbox but says sealed runs are unavailable where neither sealed probe starts (S6)', async () => {
    const { exec } = scriptedExec([{ code: 0, output: '' }, { code: 125, output: 'The sealed run could not be held to its limits, so it did not run.' }]);
    const availability = await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec));
    expect(availability.available).toBe(true);
    const sealed = sealedOf(availability);
    expect(sealed.available).toBe(false);
    if (sealed.available) return;
    expect(sealed.notice).toContain('Sealed runs are unavailable on this machine: bubblewrap could not start one (The sealed run could not be held to its limits');
    expect(sealed.notice).toContain('a loop or a script for an interpreter, is refused rather than run sealed');
  });

  it('says in the notice of a host without a sandbox that loops and scripts are refused for that reason (S6)', async () => {
    const notice = unavailableNotice(await resolvePlannerSandbox({ platform: 'win32' }));
    expect(notice).toContain('a command those rules refuse, such as a loop or a script for an interpreter, is refused rather than run sealed');
  });

  it("gives a Linux sealed run the host's name table, and no resolver to ask past it", async () => {
    const { exec } = recordingExec({ code: 0, output: '' });
    const sealed = sealedOf(await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec, { dirs: ['/etc/hosts', '/etc/resolv.conf'] })));
    if (!sealed.available) throw new Error('expected sealed runs');
    const read = sealed.profile({ workspace: '/w' }).read;
    expect(read).toContain('/etc/hosts');
    expect(read).not.toContain('/etc/resolv.conf');
  });

  it("names macOS's links as the links themselves, and Apple's developer directory where it points", async () => {
    const real: Record<string, string> = { '/private/var/select/developer_dir': '/Applications/Xcode.app/Contents/Developer' };
    const present = new Set(['/usr', '/private/etc', '/private/var/db', '/private/var/db/xcode_select_link', '/opt/homebrew', '/opt/homebrew/var', '/private/var/select/developer_dir', '/private/tmp']);
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const availability = await resolvePlannerSandbox({
      platform: 'darwin', exists: () => true, exec, probeWorkspace: '/private/tmp',
      stat: (p) => (present.has(p) ? { canonical: real[p] ?? p, directory: true } : null),
    });
    const sealed = sealedOf(availability);
    if (!sealed.available) throw new Error('expected sealed runs');
    const read = sealed.profile({ workspace: '/w' }).read;
    expect(read).toEqual(['/usr', '/private/etc', '/private/var/db/xcode_select_link', '/opt/homebrew', '/Applications/Xcode.app/Contents/Developer', '/w']);
    expect(sealed.profile({ workspace: '/w' }).masked).toEqual(['/opt/homebrew/var']);
    // Seatbelt has no overlay: the probe that asks for one fails without starting, and the second one runs.
    expect(calls).toHaveLength(2);
  });

  it('probes once per process: later callers share the first answer', () => {
    const first = resolvePlannerSandbox();
    expect(resolvePlannerSandbox()).toBe(first);
    clearPlannerSandboxCache();
    expect(resolvePlannerSandbox()).not.toBe(first);
  });
});

describe('sealedShellProfile (ADR-0036 S1)', () => {
  const host = { platform: 'linux' as NodeJS.Platform, reads: ['/usr', '/bin'], masked: [], overlay: false };

  it('reads the system and the workspace, writes scratch alone, and makes scratch its home', () => {
    const profile = sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo' });
    expect(profile).toMatchObject({
      read: ['/usr', '/bin', '/work/repo'],
      write: ['/tmp/s'],
      network: false,
      privateTmp: true,
      limits: SEALED_LIMITS,
    });
    expect(profile.throwaway).toBeUndefined();
    expect(profile.env).toMatchObject({ HOME: '/tmp/s', TMPDIR: '/tmp/s', PYTHONPYCACHEPREFIX: '/tmp/s/pycache' });
  });

  it('keeps none of the credentials the host environment holds', () => {
    const kept = sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/w' }).inheritEnv ?? [];
    expect(kept).toContain('PATH');
    for (const secret of ['HOME', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'KUBECONFIG', 'ANTHROPIC_API_KEY']) expect(kept).not.toContain(secret);
  });

  it('lays an overlay over the workspace where the host has one', () => {
    expect(sealedShellProfile({ ...host, overlay: true }, { workspace: '/work/repo' }).throwaway).toEqual(['/work/repo']);
  });

  it('leaves a nested worktree the only host-writable path under an overlaid checkout (ADR-0046)', () => {
    const overlaid = { ...host, overlay: true };
    const single = sealedShellProfile(overlaid, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/repo/wt' });
    expect(single.throwaway).toEqual(['/work/repo']);
    expect(single.write).toEqual(['/tmp/s', '/work/repo/wt']);
    // A repo group's root stays inside the overlay: only its worktrees are writable on the host.
    const group = sealedShellProfile(overlaid, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/ws', worktrees: ['/ws/alpha', '/ws/beta'] });
    expect(group.throwaway).toEqual(['/work/repo']);
    expect(group.write).toEqual(['/tmp/s', '/ws/alpha', '/ws/beta']);
  });

  it('writes one more directory when it is given one, and only then', () => {
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree' }).write).toEqual(['/tmp/s', '/work/tree']);
    expect(sealedShellProfile(host, { workspace: '/work/repo' }).write).toEqual([]);
  });

  it("writes a repo group's worktrees instead of its task workspace root, which holds no worktree's .git (ADR-0046)", () => {
    const group = sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/ws', writable: '/ws', worktrees: ['/ws/alpha', '/ws/beta'] });
    expect(group.write).toEqual(['/tmp/s', '/ws/alpha', '/ws/beta']);
    // One repo, whose worktrees are left out or name the writable directory itself, stays as it was.
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/repo' }).write).toEqual(['/tmp/s', '/work/repo']);
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/repo', worktrees: ['/work/repo'] }).write).toEqual(['/tmp/s', '/work/repo']);
  });

  it('refuses links in that directory where Seatbelt can, and leaves bubblewrap a profile it can start (ADR-0046)', () => {
    const darwin = { ...host, platform: 'darwin' as NodeJS.Platform };
    expect(sealedShellProfile(darwin, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree' }).linkless).toEqual(['/work/tree']);
    expect(sealedShellProfile(darwin, { scratch: '/tmp/s', workspace: '/work/repo' }).linkless).toBeUndefined();
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree' }).linkless).toBeUndefined();
  });

  it("protects each worktree's .git, from the worktrees given or the single writable one (ADR-0046)", () => {
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree' }).gitWorktrees).toEqual(['/work/tree']);
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/ws', writable: '/ws', worktrees: ['/ws/alpha', '/ws/beta'] }).gitWorktrees).toEqual(['/ws/alpha', '/ws/beta']);
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo' }).gitWorktrees).toBeUndefined();
  });

  it("passes on every .git entry the checkout brought, for the profile to hold still (ADR-0046)", () => {
    const entries = [{ path: '/work/tree/sub/.git', directory: false }, { path: '/work/tree/vendor/.git', directory: true }];
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree', gitEntries: entries }).gitEntries).toEqual(entries);
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree' }).gitEntries).toBeUndefined();
    // One outside the writable directory needs no protection, and binding it
    // could reveal a file the read list withholds.
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/work/repo', writable: '/work/tree', gitEntries: [{ path: '/elsewhere/.git', directory: false }] }).gitEntries).toBeUndefined();
  });

  it('refuses a .git created anywhere in its writable directory where Seatbelt can, a group\'s task workspace root included (ADR-0046)', () => {
    const darwin = { ...host, platform: 'darwin' as NodeJS.Platform };
    expect(sealedShellProfile(darwin, { scratch: '/tmp/s', workspace: '/ws', writable: '/ws', worktrees: ['/ws/alpha', '/ws/beta'] }).gitless).toEqual(['/ws']);
    expect(sealedShellProfile(darwin, { scratch: '/tmp/s', workspace: '/work/repo' }).gitless).toBeUndefined();
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/ws', writable: '/ws', worktrees: ['/ws/alpha'] }).gitless).toBeUndefined();
  });

  it('keeps its network off unless a native shell asks for the harness\'s own (N3)', () => {
    expect(sealedShellProfile(host, { workspace: '/w' }).network).toBe(false);
    expect(sealedShellProfile(host, { workspace: '/w', network: true }).network).toBe(true);
  });

  it('writes the harness\'s short temp folder beside the scratch one (N2)', () => {
    expect(sealedShellProfile(host, { scratch: '/tmp/s', workspace: '/w', tmpdir: '/tmp/t' }).write).toEqual(['/tmp/s', '/tmp/t']);
  });
});

describe('plannerShellProfile', () => {
  const host = { platform: 'linux' as NodeJS.Platform, services: ['/run/user/1000'] };

  it('reads the host, writes only scratch, and points the read commands that write caches at it (B2)', () => {
    const profile = plannerShellProfile(host, { scratch: '/tmp/s', network: false });
    expect(profile.read).toBe('host');
    expect(profile.write).toEqual(['/tmp/s']);
    expect(profile.env).toEqual({
      TMPDIR: '/tmp/s',
      GIT_OPTIONAL_LOCKS: '0',
      npm_config_cache: '/tmp/s/npm',
      npm_config_update_notifier: 'false',
      GOCACHE: '/tmp/s/go-build',
      XDG_CACHE_HOME: '/tmp/s/cache',
      PYTHONPYCACHEPREFIX: '/tmp/s/pycache',
    });
    expect(plannerShellProfile({ ...host, platform: 'darwin' }, { scratch: '/tmp/s', network: false }).env.xcrun_db).toBe('/tmp/s/xcrun_db');
  });

  it('withholds the network and the local services only from a command that ran without asking (B3)', () => {
    expect(plannerShellProfile(host, { scratch: '/tmp/s', network: false })).toMatchObject({ network: false, masked: ['/run/user/1000'] });
    expect(plannerShellProfile(host, { scratch: '/tmp/s', network: true })).toMatchObject({ network: true, masked: [] });
  });
});

/** A backend that records the profile of every command it wraps. */
function fakeBackend(): SandboxBackend & { profiles: SandboxProfile[] } {
  const profiles: SandboxProfile[] = [];
  return {
    name: 'fake',
    profiles,
    probe: async () => ({ ok: true }),
    wrap: (invocation, profile) => {
      profiles.push(profile);
      return { file: '/sandbox', args: ['--policy', invocation.shell, ...invocation.shellArgs], env: { ...invocation.env, ...profile.env } };
    },
  };
}

function availableWith(backend: SandboxBackend, sealed: SealedAvailability = { available: true, profile: (opts) => sealedShellProfile({ platform: 'linux', reads: ['/usr'], masked: [], overlay: false }, opts) }): () => Promise<PlannerSandboxAvailability> {
  return async () => ({
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'linux', services: [] }, opts),
    sealed,
  });
}

describe('PlannerShellSandbox', () => {
  it('runs the shell as before and says so once per session where no sandbox runs (B5)', async () => {
    const notices: string[] = [];
    const sandbox = new PlannerShellSandbox(async () => ({ available: false, notice: 'no sandbox' }));
    sandbox.setNotice((m) => notices.push(m));

    const launches = await Promise.all([1, 2, 3].map(() => sandbox.launch(POSIX, { network: false })));
    await sandbox.launch(POSIX, { network: true });
    expect(launches.every((l) => l.launch === POSIX && !l.sandboxed)).toBe(true);
    expect(notices).toEqual(['no sandbox']);

    sandbox.end();
    await sandbox.launch(POSIX, { network: false });
    expect(notices).toEqual(['no sandbox', 'no sandbox']);
  });

  it('wraps the POSIX shell `shell: true` would have used, with the command left to the caller (B6)', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const { launch, sandboxed } = await sandbox.launch(POSIX, { network: false });
    expect(sandboxed).toBe(true);
    expect(launch.file).toBe('/sandbox');
    expect(launch.args).toEqual(['--policy', '/bin/sh', '-c']);
    sandbox.end();
  });

  it('wraps a resolved shell with its own arguments', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const { launch } = await sandbox.launch({ file: '/usr/local/bin/bash', args: ['-c'], dialect: 'posix', utilsDir: null }, { network: false });
    expect(launch.args).toEqual(['--policy', '/usr/local/bin/bash', '-c']);
    sandbox.end();
  });

  it('gives a session one private scratch directory under the OS temporary directory, and removes it when the session ends', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const first = await sandbox.launch(POSIX, { network: false });
    await sandbox.launch(POSIX, { network: true });
    const [a, b] = backend.profiles;
    expect(a.write).toEqual(b.write);
    const scratch = a.write[0];
    expect(scratch.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(first.launch.env?.TMPDIR).toBe(scratch);
    expect([a.network, b.network]).toEqual([false, true]);

    sandbox.end();
    expect(existsSync(scratch)).toBe(false);
    await sandbox.launch(POSIX, { network: false });
    expect(backend.profiles[2].write[0]).not.toBe(scratch);
    sandbox.end();
  });

  it('never runs a cmd.exe command in the POSIX shell it would wrap', async () => {
    const sandbox = new PlannerShellSandbox(availableWith(fakeBackend()));
    await expect(sandbox.launch({ ...POSIX, dialect: 'cmd' }, { network: false })).rejects.toThrow('POSIX shell');
    await expect(sandbox.launchSealed({ ...POSIX, dialect: 'cmd' }, { workspace: tmpdir() })).rejects.toThrow('POSIX shell');
  });

  it("seals a run in the session's own scratch directory, with the workspace as the kernel names it (ADR-0036 S1)", async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    expect(await sandbox.canSeal()).toBe(true);
    await sandbox.launch(POSIX, { network: false });
    const root = mkdtempSync(join(tmpdir(), 'ordewell-sealed-ws-'));
    try {
      await sandbox.launchSealed(POSIX, { workspace: root });
      const [planner, sealed] = backend.profiles;
      expect(sealed.write).toEqual(planner.write);
      expect(sealed.read).toEqual(['/usr', realpathSync(root)]);
      expect(sealed.env.HOME).toBe(planner.write[0]);
      await sandbox.launchSealed(POSIX, { workspace: root, writable: root });
      expect(backend.profiles[2].write).toEqual([planner.write[0], realpathSync(root)]);
    } finally {
      sandbox.end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wraps a harness's own shell in the sealed profile, with the network and its short temp folder (ADR-0036 N2, N3)", async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const root = mkdtempSync(join(tmpdir(), 'ordewell-native-ws-'));
    const short = mkdtempSync(join(tmpdir(), 'ordewell-native-tmp-'));
    try {
      const launch = await sandbox.launchNativeShell({ workspace: root, tmpdir: short, shell: '/bin/zsh' });
      const profile = backend.profiles[0];
      expect(launch.file).toBe('/sandbox');
      expect(launch.args).toEqual(['--policy', '/bin/zsh', '-c']);
      expect(profile).toMatchObject({ network: true, privateTmp: true, keychain: false });
      expect(profile.throwaway).toBeUndefined();
      expect(profile.read).toEqual(['/usr', realpathSync(root)]);
      expect(profile.write).toContain(realpathSync(short));
      expect(profile.env.HOME).toBe(profile.write[0]);
    } finally {
      sandbox.end();
      rmSync(root, { recursive: true, force: true });
      rmSync(short, { recursive: true, force: true });
    }
  });

  it('cannot seal where no sandbox runs, or where the sandbox cannot start a sealed run, and says so once (S6)', async () => {
    const notices: string[] = [];
    const none = new PlannerShellSandbox(async () => ({ available: false, notice: 'no sandbox' }));
    none.setNotice((m) => notices.push(m));
    expect(await none.canSeal()).toBe(false);
    await none.launch(POSIX, { network: false });
    await expect(none.launchSealed(POSIX, { workspace: tmpdir() })).rejects.toThrow('sealed runs are unavailable');

    const unsealed = new PlannerShellSandbox(availableWith(fakeBackend(), { available: false, notice: 'no sealed runs' }));
    unsealed.setNotice((m) => notices.push(m));
    await unsealed.launch(POSIX, { network: false });
    expect(await unsealed.canSeal()).toBe(false);
    expect(notices).toEqual(['no sandbox', 'no sealed runs']);
    none.end();
    unsealed.end();
  });
});

describe('sandboxedFailureNote', () => {
  it('explains a denied write, and a missing network only where the command had none', () => {
    expect(sandboxedFailureNote('touch: x: Operation not permitted', true)).toContain('cannot write outside its scratch directory');
    expect(sandboxedFailureNote('touch: x: Operation not permitted', true)).not.toContain('network');
    expect(sandboxedFailureNote('curl: (6) Could not resolve host: example.com', false)).toContain('has no network');
    expect(sandboxedFailureNote('fatal: bad revision', false)).toBeNull();
  });

  it('never reads as a refusal or a denial to the surfaces', () => {
    const output = `Command exited 1:\ntouch: x: Read-only file system\n\n[${sandboxedFailureNote('Read-only file system', false)}]`;
    expect(classifyOutcome(false, output)).toBe('failure');
  });
});

describe('sweepOrphanScratch', () => {
  it("removes the scratch directories of processes that are gone, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-sweep-'));
    try {
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      for (const name of [`ordewell-planner-${gone}-abc`, `ordewell-planner-${process.pid}-abc`, `ordewell-planner-${process.ppid}-abc`, 'ordewell-planner-abc', 'unrelated']) {
        mkdirSync(join(root, name));
      }
      sweepOrphanScratch(root);
      expect(existsSync(join(root, `ordewell-planner-${gone}-abc`))).toBe(false);
      for (const kept of [`ordewell-planner-${process.pid}-abc`, `ordewell-planner-${process.ppid}-abc`, 'ordewell-planner-abc', 'unrelated']) {
        expect(existsSync(join(root, kept))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a scratch directory after the process that made it', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    await sandbox.launch(POSIX, { network: false });
    expect(backend.profiles[0].write[0]).toMatch(new RegExp(`/ordewell-planner-${process.pid}-[^/]+$`));
    sandbox.end();
  });
});
