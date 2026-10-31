import { describe, it, expect } from 'vitest';
import { SeatbeltBackend, SANDBOX_EXEC } from '../seatbelt';
import { BubblewrapBackend, findBubblewrap } from '../bubblewrap';
import { sealedShellProfile, type SealedRunOptions } from '../plannerSandbox';
import { MEMORY_LIMIT_SIGNAL, SandboxUnsupportedError, type SandboxInvocation, type SandboxLimits, type SandboxProfile, type ProbeExec } from '../SandboxBackend';

const SH: SandboxInvocation = { shell: '/bin/sh', shellArgs: ['-c'], env: { PATH: '/usr/bin:/bin', HOME: '/home/me' } };
const SCRATCH = '/tmp/ordewell-planner-abc';

function profile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return { write: [SCRATCH], read: 'host', network: false, env: { TMPDIR: SCRATCH }, ...overrides };
}

const LIMITS: SandboxLimits = { processes: 64, memoryBytes: 2 * 1024 ** 3, addressSpaceBytes: 64 * 1024 ** 3, wallTimeMs: 30_000 };

/** A sealed run's profile, as ADR-0036 S1 shapes it. */
function sealed(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return profile({
    read: ['/usr', '/bin', '/work/repo'],
    privateTmp: true,
    env: { TMPDIR: SCRATCH, HOME: SCRATCH },
    inheritEnv: ['PATH'],
    limits: LIMITS,
    ...overrides,
  });
}

/** A path built to break out of any quoting a backend might have done by hand. */
const HOSTILE = '/tmp/a"b) (allow file-write* (subpath "/"))\n(allow network*)';

/** A read-only task's checkout, the worktree it may write, and a repo group's task workspace. */
const REPO = '/work/repo';
const WORKTREE = `${REPO}/.ordewell/worktrees/run/1-review`;
const GROUP = `${REPO}/.ordewell/worktrees/run/3-group`;
const ALPHA = `${GROUP}/alpha`;
const BETA = `${GROUP}/beta`;
const SEALED_HOST = { platform: 'linux' as NodeJS.Platform, reads: ['/usr', '/bin'], masked: [] };

type Mount = { op: '--bind' | '--ro-bind' | '--tmpfs' | '--tmp-overlay'; src?: string; dest: string };

/** The mounts a bubblewrap argv builds, in the order it builds them, up to the shell it runs. */
function mounts(args: readonly string[]): Mount[] {
  const out: Mount[] = [];
  for (let i = 0; i < args.indexOf('--'); i++) {
    const arg = args[i];
    if (arg === '--bind' || arg === '--ro-bind') {
      out.push({ op: arg, src: args[i + 1], dest: args[i + 2] });
      i += 2;
    } else if (arg === '--tmpfs') {
      out.push({ op: arg, dest: args[i + 1] });
      i += 1;
    } else if (arg === '--overlay-src' && args[i + 2] === '--tmp-overlay') {
      out.push({ op: '--tmp-overlay', src: args[i + 1], dest: args[i + 3] });
      i += 3;
    }
  }
  return out;
}

describe('SeatbeltBackend.wrap', () => {
  const seatbelt = new SeatbeltBackend();

  function profileText(args: string[]): string {
    expect(args[0]).toBe('-p');
    return args[1];
  }

  it('launches sandbox-exec by its absolute path, with the shell and its arguments last', () => {
    const launch = seatbelt.wrap(SH, profile());
    expect(launch.file).toBe(SANDBOX_EXEC);
    expect(launch.args.slice(-2)).toEqual(['/bin/sh', '-c']);
  });

  it('denies by default and allows writes only under the parameters it passes', () => {
    const launch = seatbelt.wrap(SH, profile());
    const text = profileText(launch.args);
    expect(text).toMatch(/^\(version 1\)\n\(deny default\)/);
    expect(text).toContain('(allow file-read* file-test-existence file-map-executable file-write* (subpath (param "WRITABLE_0")))');
    expect(launch.args).toContain(`WRITABLE_0=${SCRATCH}`);
    expect(launch.args[launch.args.indexOf(`WRITABLE_0=${SCRATCH}`) - 1]).toBe('-D');
    // Nothing but the scratch directory, the device files and the shell's own here-document names.
    const writes = text.split('\n').filter((line) => line.includes('file-write'));
    expect(writes.join('\n')).not.toMatch(/subpath "\/(Users|home|private\/var)/);
  });

  it('allows no network without it, and the network with it', () => {
    const off = profileText(seatbelt.wrap(SH, profile()).args);
    const on = profileText(seatbelt.wrap(SH, profile({ network: true })).args);
    expect(off).not.toMatch(/\(allow network-outbound\b(?! \(literal "\/private\/var\/run\/syslog"\))/);
    expect(off).not.toContain('com.apple.SecurityServer');
    expect(on).toContain('(allow network-outbound network-inbound network-bind system-socket)');
    expect(on).toContain('com.apple.SecurityServer');
  });

  it('keeps the keychain out of reach of a native shell that has the network (ADR-0036 N2.2)', () => {
    const text = profileText(seatbelt.wrap(SH, profile({ network: true, keychain: false })).args);
    expect(text).toContain('(allow network-outbound network-inbound network-bind system-socket)');
    expect(text).toContain('com.apple.trustd');
    expect(text).not.toContain('com.apple.SecurityServer');
  });

  it('keeps a native shell that has the network off this machine\'s own services, since a local API acts outside the sandbox (ADR-0036 N2)', () => {
    const text = profileText(seatbelt.wrap(SH, profile({ network: true, localNetwork: false })).args);
    const network = text.indexOf('(allow network-outbound network-inbound network-bind system-socket)');
    const deny = text.indexOf('(deny network-outbound (remote ip "localhost:*") (remote unix-socket))');
    expect(network).toBeGreaterThan(-1);
    expect(deny).toBeGreaterThan(network);
    // Name resolution goes through mDNSResponder's socket, and logging through syslog's.
    expect(text.indexOf('(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")) (literal "/private/var/run/syslog"))')).toBeGreaterThan(deny);
    expect(profileText(seatbelt.wrap(SH, profile({ network: true })).args)).not.toContain('(deny network-outbound');
  });

  it('never puts a path into the profile text, so none can become syntax', () => {
    const plain = seatbelt.wrap(SH, profile());
    const hostile = seatbelt.wrap(SH, profile({ write: [HOSTILE], masked: [HOSTILE] }));
    expect(profileText(hostile.args)).not.toContain('a"b');
    expect(profileText(hostile.args)).toBe(profileText(seatbelt.wrap(SH, profile({ write: ['/x'], masked: ['/y'] })).args));
    expect(hostile.args).toContain(`WRITABLE_0=${HOSTILE}`);
    expect(hostile.args).toContain(`MASKED_0=${HOSTILE}`);
    expect(profileText(plain.args)).not.toContain('MASKED');
  });

  it('keeps a writable directory inside a masked one writable, as bubblewrap does', () => {
    const text = profileText(seatbelt.wrap(SH, profile({ masked: ['/run/user/501'] })).args);
    expect(text.indexOf('(deny file-read* file-write* (subpath (param "MASKED_0")))'))
      .toBeLessThan(text.indexOf('file-write* (subpath (param "WRITABLE_0")))'));
  });

  it('sets the profile environment over the one the shell had', () => {
    const { env } = seatbelt.wrap(SH, profile({ env: { TMPDIR: SCRATCH, HOME: '/elsewhere' } }));
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/elsewhere', TMPDIR: SCRATCH });
  });

  it.each<[string, Partial<SandboxProfile>]>([
    ['a throwaway overlay', { read: ['/work/repo'], throwaway: ['/work/repo'] }],
    ['a relative path', { write: ['scratch'] }],
    ['an option-shaped path', { write: ['--help'] }],
    ['a limit that is not a whole number', { limits: { ...LIMITS, processes: 1.5 } }],
    ['an address ceiling that is not a whole number', { limits: { ...LIMITS, addressSpaceBytes: 1.5 } }],
  ])('refuses %s rather than enforce less than it was asked', (_what, overrides) => {
    expect(() => seatbelt.wrap(SH, profile(overrides))).toThrow(SandboxUnsupportedError);
  });

  describe('a sealed profile (ADR-0036 S1)', () => {
    it('reads only what it lists, the directories above it by name, and none of the user preferences or other processes', () => {
      const launch = seatbelt.wrap(SH, sealed({ masked: ['/usr/local/var'] }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      expect(text).not.toContain('(allow file-read* file-test-existence file-map-executable)\n');
      expect(text).not.toContain('user-preference-read');
      expect(text).not.toContain('com.apple.cfprefsd');
      expect(text).toContain('(allow process-info* (target same-sandbox))');
      expect(text).toContain('(allow file-read* file-test-existence file-map-executable (subpath (param "READ_0")) (subpath (param "READ_1")) (subpath (param "READ_2")))');
      expect(launch.args).toEqual(expect.arrayContaining(['READ_0=/usr', 'READ_1=/bin', 'READ_2=/work/repo']));
      // Stat, never read: the workspace's and the scratch directory's parents.
      expect(launch.args).toEqual(expect.arrayContaining(['ABOVE_0=/work', 'ABOVE_1=/tmp']));
      expect(text).toMatch(/\(allow file-read-metadata \(literal \(param "ABOVE_0"\)\)/);
      expect(text.indexOf('(deny file-read* file-write* (subpath (param "MASKED_0")))')).toBeGreaterThan(text.indexOf('READ_2'));
    });

    it('refuses a link made in, or moved into, a writable directory without links, after the rule that makes it writable (ADR-0046)', () => {
      const launch = seatbelt.wrap(SH, sealed({ write: [SCRATCH, '/work/repo/wt'], linkless: ['/work/repo/wt'] }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      const deny = '(deny file-write-create (require-all (vnode-type SYMLINK) (require-any (subpath (param "LINKLESS_0")))))';
      expect(text).toContain(deny);
      expect(text.indexOf(deny)).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'));
      expect(launch.args).toContain('LINKLESS_0=/work/repo/wt');
      expect(profileText(seatbelt.wrap(SH, sealed()).args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1))).not.toContain('LINKLESS');
    });

    it("protects a writable worktree's .git and its root, after the writable allow (ADR-0046)", () => {
      const launch = seatbelt.wrap(SH, sealed({ write: [SCRATCH, '/work/repo/wt'], gitWorktrees: ['/work/repo/wt'] }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      const write = '(deny file-write* (literal (param "GIT_0")))';
      expect(text).toContain(write);
      // After the rule that made the worktree writable, so the last-match-wins deny stands.
      expect(text.indexOf(write)).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'));
      expect(launch.args).toContain('GIT_0=/work/repo/wt/.git');
      // The root cannot be renamed or removed either: a moved worktree would
      // take its `.git` out of the profile and could be moved back with a
      // planted one (ADR-0046). Its contents stay writable.
      const root = '(deny file-write* (literal (param "WORKTREE_0")))';
      expect(text).toContain(root);
      expect(text.indexOf(root)).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'));
      expect(launch.args).toContain('WORKTREE_0=/work/repo/wt');
      expect(profileText(seatbelt.wrap(SH, sealed()).args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1))).not.toContain('GIT_0=');
    });

    it("holds every .git entry the checkout brought still: literal for a file, subpath for a directory (ADR-0046)", () => {
      const launch = seatbelt.wrap(SH, sealed({
        write: [SCRATCH, '/work/repo/wt'],
        gitEntries: [
          { path: '/work/repo/wt/sub/.git', directory: false },
          { path: '/work/repo/wt/vendor/.git', directory: true },
        ],
      }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      const file = '(deny file-write* (literal (param "GITFILE_0")))';
      const dir = '(deny file-write* (subpath (param "GITDIR_0")))';
      expect(text).toContain(file);
      expect(text).toContain(dir);
      // After the writable allow, so the last-match-wins deny stands.
      expect(text.indexOf(file)).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'));
      expect(text.indexOf(dir)).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'));
      expect(launch.args).toContain('GITFILE_0=/work/repo/wt/sub/.git');
      expect(launch.args).toContain('GITDIR_0=/work/repo/wt/vendor/.git');
      expect(profileText(seatbelt.wrap(SH, sealed()).args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1))).not.toContain('GITFILE_0=');
    });

    it('refuses creating a .git anywhere in a gitless directory, its own root included, after the writable allow (ADR-0046)', () => {
      // A repo group's task workspace: the runner's own git starts at its root, where no worktree's .git is.
      const launch = seatbelt.wrap(SH, sealed({ write: [SCRATCH, '/work/ws'], gitWorktrees: ['/work/ws/alpha'], gitless: ['/work/ws'] }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      const create = '(deny file-write-create (require-all (regex #"/\\.git$") (require-any (subpath (param "GITLESS_0")))))';
      expect(text).toContain(create);
      expect(text.indexOf(create)).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'));
      expect(launch.args).toContain('GITLESS_0=/work/ws');
      expect(profileText(seatbelt.wrap(SH, sealed({ gitWorktrees: ['/work/ws/alpha'] })).args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1))).not.toContain('GITLESS');
    });

    it("keeps each worktree's .git protected when a repo group makes only its worktrees writable (ADR-0046)", () => {
      const launch = seatbelt.wrap(SH, sealed({
        read: ['/usr', '/bin', '/ws'],
        write: [SCRATCH, '/ws/alpha', '/ws/beta'],
        gitWorktrees: ['/ws/alpha', '/ws/beta'],
        gitless: ['/ws'],
      }));
      const text = profileText(launch.args.slice(launch.args.indexOf(SANDBOX_EXEC) + 1));
      expect(launch.args).toEqual(expect.arrayContaining([
        'WRITABLE_1=/ws/alpha', 'WRITABLE_2=/ws/beta', 'GIT_0=/ws/alpha/.git', 'GIT_1=/ws/beta/.git', 'GITLESS_0=/ws',
        'WORKTREE_0=/ws/alpha', 'WORKTREE_1=/ws/beta',
      ]));
      expect(launch.args).not.toContain('WRITABLE_1=/ws');
      expect(text).toContain('(deny file-write* (literal (param "GIT_0")) (literal (param "GIT_1")))');
      expect(text).toContain('(deny file-write* (literal (param "WORKTREE_0")) (literal (param "WORKTREE_1")))');
      expect(text).toContain('(deny file-write-create (require-all (regex #"/\\.git$") (require-any (subpath (param "GITLESS_0")))))');
    });

    it('keeps a hostile path out of the profile text in the read list too', () => {
      const launch = seatbelt.wrap(SH, sealed({ read: [HOSTILE] }));
      expect(launch.args.find((arg) => arg.startsWith('(version 1)'))).not.toContain('a"b');
      expect(launch.args).toContain(`READ_0=${HOSTILE}`);
    });

    it('hides the host /tmp from a profile that reads the host, but for the shell\'s here-documents', () => {
      const text = profileText(seatbelt.wrap(SH, profile({ privateTmp: true })).args);
      const deny = text.indexOf('(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))');
      expect(deny).toBeGreaterThan(text.indexOf('(allow file-read* file-test-existence file-map-executable)'));
      expect(text.indexOf('(allow file-read* file-write* (regex #"^/private/tmp/sh-thd-[0-9]+$"))')).toBeGreaterThan(deny);
    });

    it('starts behind a bash prelude that sets the limits and owns the process group, and asks the caller to keep the time', () => {
      const launch = seatbelt.wrap(SH, sealed());
      expect(launch.file).toBe('/bin/bash');
      expect(launch.args[0]).toBe('-c');
      const prelude = launch.args[1];
      expect(prelude).toContain('ulimit -u $((n + 64))');
      expect(prelude).toContain(`ulimit -v $((v + ${64 * 1024 * 1024}))`);
      expect(prelude).toContain('set -m');
      expect(prelude).toContain('kill -KILL -$pid');
      // `$0`, then the launcher and the shell, with the command left to come last.
      expect(launch.args.slice(2, 4)).toEqual(['ordewell-sealed', SANDBOX_EXEC]);
      expect(launch.args.slice(-2)).toEqual(['/bin/sh', '-c']);
      expect(launch.wallTimeMs).toBe(30_000);
    });

    it('bounds real memory with a watcher that sums the run\'s process group about once a second, and tells the caller by a signal', () => {
      const launch = seatbelt.wrap(SH, sealed());
      const prelude = launch.args[1];
      expect(prelude).toContain('/bin/sleep 1');
      expect(prelude).toContain('/bin/ps -o rss= -g $pid');
      expect(prelude).toContain(`-gt ${2 * 1024 * 1024}`);
      expect(prelude).toContain('kill -USR2 $$');
      expect(MEMORY_LIMIT_SIGNAL).toBe('SIGUSR2');
      expect(launch.memoryBytes).toBe(2 * 1024 ** 3);
    });

    it('sets the kernel\'s limits on the command alone, so a fork bomb cannot stop the watcher forking', () => {
      const prelude = seatbelt.wrap(SH, sealed()).args[1];
      const command = prelude.indexOf('ulimit -u');
      expect(prelude.lastIndexOf('(', command)).toBeGreaterThan(prelude.lastIndexOf('\n', command) - 1);
      expect(prelude.indexOf('exec "$@"')).toBeGreaterThan(command);
      expect(prelude.indexOf('/bin/ps -o rss=')).toBeGreaterThan(prelude.indexOf('exec "$@"'));
    });

    it('puts only numbers from the limits into the script, whatever the limits are', () => {
      const text = (limits: SandboxLimits) => seatbelt.wrap(SH, sealed({ limits })).args[1].replace(/\d+/g, 'N');
      expect(text({ ...LIMITS, memoryBytes: 1024, addressSpaceBytes: 2048, processes: 7 })).toBe(text(LIMITS));
    });

    it('keeps only the environment the profile names, then sets its own', () => {
      const { env } = seatbelt.wrap({ ...SH, env: { PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'x', HOME: '/home/me' } }, sealed());
      expect(env).toEqual({ PATH: '/usr/bin', TMPDIR: SCRATCH, HOME: SCRATCH });
    });
  });
});

describe('BubblewrapBackend.wrap', () => {
  const bwrap = (isDirectory: (p: string) => boolean = () => true) => new BubblewrapBackend('/usr/bin/bwrap', { isDirectory });

  it('builds the planner command line ADR-0011 names, without the network', () => {
    expect(bwrap().wrap(SH, profile())).toEqual({
      file: '/usr/bin/bwrap',
      args: [
        '--new-session', '--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-net',
        '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--bind', SCRATCH, SCRATCH,
        '--', '/bin/sh', '-c',
      ],
      env: { PATH: '/usr/bin:/bin', HOME: '/home/me', TMPDIR: SCRATCH },
    });
  });

  it('refuses a network without this machine\'s own services, which needs a network namespace of its own', () => {
    expect(() => bwrap().wrap(SH, profile({ network: true, localNetwork: false }))).toThrow(SandboxUnsupportedError);
    expect(() => bwrap().wrap(SH, profile({ network: false, localNetwork: false }))).not.toThrow();
  });

  it('keeps the network for an approved command', () => {
    const { args } = bwrap().wrap(SH, profile({ network: true }));
    expect(args).not.toContain('--unshare-net');
    expect(args).toContain('--unshare-pid');
  });

  it('masks a directory with an empty one and a socket file with /dev/null, before the writable binds', () => {
    const { args } = bwrap((p) => p !== '/run/docker.sock').wrap(SH, profile({ masked: ['/run/user/1000', '/run/docker.sock'] }));
    const joined = args.join(' ');
    expect(joined).toContain('--tmpfs /run/user/1000');
    expect(joined).toContain('--ro-bind /dev/null /run/docker.sock');
    expect(joined.indexOf('--tmpfs /run/user/1000')).toBeLessThan(joined.indexOf(`--bind ${SCRATCH}`));
  });

  it('can say all a sealed run needs: a read list, a private /tmp, no network', () => {
    const { args } = bwrap().wrap(SH, profile({
      read: ['/usr/lib', '/usr', '/tmp/ws'],
      write: ['/tmp/ws/worktree', SCRATCH],
      privateTmp: true,
    }));
    expect(args).not.toContain('/');
    const joined = args.join(' ');
    // The private /tmp first, so a workspace and a scratch under /tmp are mounted on it, parents before children.
    expect(joined).toContain('--tmpfs /tmp --ro-bind /usr /usr --ro-bind /usr/lib /usr/lib --ro-bind /tmp/ws /tmp/ws');
    expect(joined).toContain(`--bind ${SCRATCH} ${SCRATCH} --bind /tmp/ws/worktree /tmp/ws/worktree`);
  });

  it('passes a hostile path as one argument, never split or read as an option', () => {
    const { args } = bwrap().wrap(SH, profile({ write: [HOSTILE] }));
    expect(args[args.indexOf('--bind') + 1]).toBe(HOSTILE);
    expect(args[args.indexOf('--bind') + 2]).toBe(HOSTILE);
  });

  it.each<[string, Partial<SandboxProfile>]>([
    ['a limit that is not a whole number', { limits: { ...LIMITS, memoryBytes: -1 } }],
    ['a relative path', { masked: ['run/user'] }],
    ['a relative throwaway directory', { throwaway: ['repo'] }],
    ['a writable directory without links, which a mount cannot hold to (ADR-0046)', { write: ['/work/repo/wt'], linkless: ['/work/repo/wt'] }],
    ['a writable directory where no .git may be created, which a mount cannot hold to (ADR-0046)', { write: ['/work/repo/wt'], gitless: ['/work/repo/wt'] }],
    ['a relative .git entry', { write: ['/work/repo/wt'], gitEntries: [{ path: 'wt/.git', directory: false }] }],
  ])('refuses %s rather than enforce less than it was asked', (_what, overrides) => {
    expect(() => bwrap().wrap(SH, profile(overrides))).toThrow(SandboxUnsupportedError);
  });

  describe('a sealed profile (ADR-0036 S1)', () => {
    it('lays a throwaway overlay over the workspace in place of a read-only bind', () => {
      const { args } = bwrap().wrap(SH, sealed({ throwaway: ['/work/repo'] }));
      const joined = args.join(' ');
      expect(joined).toContain('--overlay-src /work/repo --tmp-overlay /work/repo');
      expect(joined).not.toContain('--ro-bind /work/repo');
      expect(joined).toContain('--ro-bind /usr /usr --ro-bind /bin /bin');
      expect(joined).toContain('--unshare-net');
      expect(joined).toContain('--tmpfs /tmp');
    });

    it('starts behind a prelude that sets the limits and then becomes bubblewrap, so its kill and its parent\'s death reach the sandbox', () => {
      const launch = bwrap().wrap(SH, sealed());
      expect(launch.file).toBe('/bin/sh');
      const prelude = launch.args[1];
      // dash calls the process limit -p, bash -u.
      const processes = '$(($(set -- /proc/[0-9]*; echo $#) + 64))';
      expect(prelude).toContain(`ulimit -u ${processes} 2>/dev/null || ulimit -p ${processes}`);
      expect(prelude).toContain(`ulimit -v ${64 * 1024 * 1024}`);
      expect(prelude).toMatch(/exec "\$@"$/);
      expect(launch.args.slice(2, 4)).toEqual(['ordewell-sealed', '/usr/bin/bwrap']);
      expect(launch.args).toContain('--die-with-parent');
      expect(launch.wallTimeMs).toBe(30_000);
    });

    it('starts the memory watcher before the limits, outside the sandbox, on no PATH the host gave it', () => {
      const launch = bwrap().wrap(SH, sealed());
      const prelude = launch.args[1];
      const watcher = prelude.indexOf('VmRSS:');
      expect(watcher).toBeGreaterThan(-1);
      expect(watcher).toBeLessThan(prelude.indexOf('ulimit -v'));
      expect(prelude).toContain(`-gt ${2 * 1024 * 1024}`);
      expect(prelude).toContain('kill -USR2 $$');
      // A sealed run may write a directory a relative PATH entry names, and this runs outside the sandbox.
      expect(prelude).toContain('PATH=/usr/bin:/bin:/run/current-system/sw/bin');
      expect(launch.memoryBytes).toBe(2 * 1024 ** 3);
    });

    it('puts only numbers from the limits into the script, whatever the limits are', () => {
      const text = (limits: SandboxLimits) => bwrap().wrap(SH, sealed({ limits })).args[1].replace(/\d+/g, 'N');
      expect(text({ ...LIMITS, memoryBytes: 1024, addressSpaceBytes: 2048, processes: 7 })).toBe(text(LIMITS));
    });

    it('keeps only the environment the profile names, then sets its own', () => {
      const { env } = bwrap().wrap({ ...SH, env: { PATH: '/usr/bin', GITHUB_TOKEN: 'x', HOME: '/home/me' } }, sealed());
      expect(env).toEqual({ PATH: '/usr/bin', TMPDIR: SCRATCH, HOME: SCRATCH });
    });

    it("binds a worktree's .git read-only after the writable bind, so the file cannot be rewritten (ADR-0046)", () => {
      const { args } = bwrap().wrap(SH, sealed({ write: [SCRATCH, '/work/repo/wt'], gitWorktrees: ['/work/repo/wt'] }));
      const joined = args.join(' ');
      expect(joined).toContain('--bind /work/repo/wt /work/repo/wt');
      expect(joined).toContain('--ro-bind /work/repo/wt/.git /work/repo/wt/.git');
      // After the writable bind, so the overmount of the .git file stands.
      expect(joined.indexOf('--ro-bind /work/repo/wt/.git')).toBeGreaterThan(joined.indexOf('--bind /work/repo/wt /work/repo/wt'));
      expect(bwrap().wrap(SH, sealed()).args.join(' ')).not.toContain('/.git');
    });

    it("binds every .git entry the checkout brought read-only after the writable bind (ADR-0046)", () => {
      const { args } = bwrap().wrap(SH, sealed({
        write: [SCRATCH, '/work/repo/wt'],
        gitEntries: [
          { path: '/work/repo/wt/sub/.git', directory: false },
          { path: '/work/repo/wt/vendor/.git', directory: true },
        ],
      }));
      const joined = args.join(' ');
      for (const entry of ['/work/repo/wt/sub/.git', '/work/repo/wt/vendor/.git']) {
        expect(joined).toContain(`--ro-bind ${entry} ${entry}`);
        expect(joined.indexOf(`--ro-bind ${entry}`)).toBeGreaterThan(joined.indexOf('--bind /work/repo/wt /work/repo/wt'));
      }
    });

    it("binds a repo group's worktrees, not its task workspace root, which the workspace read leaves read-only (ADR-0046)", () => {
      const { args } = bwrap().wrap(SH, sealed({
        read: ['/usr', '/bin', '/ws'],
        write: [SCRATCH, '/ws/alpha', '/ws/beta'],
        gitWorktrees: ['/ws/alpha', '/ws/beta'],
      }));
      const joined = args.join(' ');
      expect(joined).toContain('--ro-bind /ws /ws');
      expect(joined).toContain('--bind /ws/alpha /ws/alpha');
      expect(joined).toContain('--bind /ws/beta /ws/beta');
      expect(joined).not.toContain('--bind /ws /ws');
      // A worktree's `.git` is still overmounted read-only after its writable bind.
      expect(joined).toContain('--ro-bind /ws/alpha/.git /ws/alpha/.git');
      expect(joined).toContain('--ro-bind /ws/beta/.git /ws/beta/.git');
    });

    describe('over a nested writable worktree (ADR-0046)', () => {
      const layouts: Array<[string, SealedRunOptions & { scratch: string }, readonly string[]]> = [
        ['one repository', { workspace: REPO, writable: WORKTREE, scratch: SCRATCH, limits: LIMITS }, [SCRATCH, WORKTREE]],
        ['a repo group', { workspace: REPO, writable: GROUP, worktrees: [ALPHA, BETA], scratch: SCRATCH, limits: LIMITS }, [SCRATCH, ALPHA, BETA]],
      ];

      it.each(layouts)('with an overlay, makes only scratch and the admitted worktrees writable: %s', (_name, opts, writables) => {
        const { args } = bwrap().wrap(SH, sealedShellProfile({ ...SEALED_HOST, overlay: true }, opts));
        const m = mounts(args);
        const rw = m.filter((mount) => mount.op === '--bind');
        expect(rw.map((mount) => mount.dest).sort()).toEqual([...writables].sort());
        for (const mount of rw) expect(mount.src).toBe(mount.dest);

        // The checkout is one throwaway overlay, mounted before the binds nested inside it.
        const overlay = m.findIndex((mount) => mount.op === '--tmp-overlay' && mount.dest === REPO);
        expect(overlay).toBeGreaterThan(-1);
        expect(m.find((mount) => mount.op === '--ro-bind' && mount.dest === REPO)).toBeUndefined();
        for (const mount of rw) if (mount.dest.startsWith(`${REPO}/`)) expect(m.indexOf(mount)).toBeGreaterThan(overlay);
        // The private /tmp comes first, since the scratch directory and a temporary checkout live under it.
        expect(m.findIndex((mount) => mount.op === '--tmpfs' && mount.dest === '/tmp')).toBeLessThan(overlay);

        // A worktree's .git is overmounted read-only after every writable bind.
        const lastWrite = Math.max(...rw.map((mount) => m.indexOf(mount)));
        for (const worktree of writables.filter((p) => p !== SCRATCH)) {
          expect(m.findIndex((mount) => mount.op === '--ro-bind' && mount.dest === `${worktree}/.git`)).toBeGreaterThan(lastWrite);
        }

        // A tmpfs upper, never a host directory one that would keep the layer.
        expect(args).not.toContain('--overlay');
        const sources = args.flatMap((arg, i) => (arg === '--overlay-src' ? [i] : []));
        expect(sources.length).toBeGreaterThan(0);
        for (const i of sources) {
          expect(args[i + 2]).toBe('--tmp-overlay');
          expect(args[i + 3]).toBe(args[i + 1]);
        }
      });

      it.each(layouts)('without an overlay, binds the checkout read-only and still only the worktrees writable: %s', (_name, opts, writables) => {
        const { args } = bwrap().wrap(SH, sealedShellProfile({ ...SEALED_HOST, overlay: false }, opts));
        const m = mounts(args);
        expect(args).not.toContain('--overlay-src');
        expect(args).not.toContain('--tmp-overlay');

        const checkout = m.findIndex((mount) => mount.op === '--ro-bind' && mount.dest === REPO);
        expect(checkout).toBeGreaterThan(-1);
        const rw = m.filter((mount) => mount.op === '--bind');
        expect(rw.map((mount) => mount.dest).sort()).toEqual([...writables].sort());
        for (const mount of rw) {
          expect(mount.src).toBe(mount.dest);
          // The checkout is mounted before the writable bind nested inside it.
          if (mount.dest.startsWith(`${REPO}/`)) expect(m.indexOf(mount)).toBeGreaterThan(checkout);
        }

        const lastWrite = Math.max(...rw.map((mount) => m.indexOf(mount)));
        for (const worktree of writables.filter((p) => p !== SCRATCH)) {
          expect(m.findIndex((mount) => mount.op === '--ro-bind' && mount.dest === `${worktree}/.git`)).toBeGreaterThan(lastWrite);
        }
      });
    });
  });
});

describe('probing a backend', () => {
  function recording(result: { code: number | null; output: string }): { exec: ProbeExec; calls: Array<{ file: string; args: string[] }> } {
    const calls: Array<{ file: string; args: string[] }> = [];
    return { calls, exec: async (file, args) => { calls.push({ file, args }); return result; } };
  }

  it('runs `true` in the wrapped shell, exactly as a command would run', async () => {
    const { exec, calls } = recording({ code: 0, output: '' });
    expect(await new BubblewrapBackend('/usr/bin/bwrap', { exec }).probe(profile({ write: [] }))).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/usr/bin/bwrap');
    expect(calls[0].args.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'true']);
    expect(calls[0].args).toContain('--unshare-net');
  });

  it('reports what the launcher said when it cannot start', async () => {
    const { exec } = recording({ code: 1, output: 'bwrap: setting up uid map: Permission denied' });
    expect(await new BubblewrapBackend('/usr/bin/bwrap', { exec }).probe(profile())).toEqual({ ok: false, detail: 'bwrap: setting up uid map: Permission denied' });
  });

  it('fails a profile the backend cannot enforce without running anything', async () => {
    const { exec, calls } = recording({ code: 0, output: '' });
    const probe = await new SeatbeltBackend(exec).probe(profile({ read: ['/work/repo'], throwaway: ['/work/repo'] }));
    expect(probe.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('findBubblewrap', () => {
  it('prefers the distribution install over whatever PATH finds first', () => {
    const present = new Set(['/home/me/bin/bwrap', '/usr/bin/bwrap']);
    expect(findBubblewrap({ PATH: '/home/me/bin:/usr/bin' }, (f) => present.has(f))).toBe('/usr/bin/bwrap');
  });

  it('falls back to an absolute PATH entry, and never a relative one', () => {
    expect(findBubblewrap({ PATH: 'node_modules/.bin:/opt/tools/bin' }, (f) => f === '/opt/tools/bin/bwrap' || f === 'node_modules/.bin/bwrap')).toBe('/opt/tools/bin/bwrap');
    expect(findBubblewrap({ PATH: 'node_modules/.bin' }, (f) => f === 'node_modules/.bin/bwrap')).toBeNull();
  });

  it('answers null when it is not installed', () => {
    expect(findBubblewrap({ PATH: '/usr/bin' }, () => false)).toBeNull();
  });
});
