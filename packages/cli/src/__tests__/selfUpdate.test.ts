import { describe, expect, it } from 'vitest';
import { fakeSea } from '@ordewell/core/testing';
import { runUpdate, type SelfUpdateDeps } from '../selfUpdate';

const INSTALLER = 'https://github.com/ordewell/ordewell/releases/latest/download/install.sh';

interface Ran {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  input?: string;
}

/** A machine whose every effect is recorded: what ran, what it printed, what it downloaded. */
function machine(overrides: Partial<SelfUpdateDeps> & { status?: number; outputs?: Record<string, string> } = {}) {
  const ran: Ran[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const downloaded: string[] = [];
  const { status = 0, outputs = {}, ...deps } = overrides;
  const all: SelfUpdateDeps = {
    platform: 'linux',
    env: {},
    run: async (command, args, options) => {
      ran.push({ command, args, ...options });
      return status;
    },
    output: (command, args) => outputs[[command, ...args].join(' ')] ?? null,
    writable: () => true,
    download: async (url) => {
      downloaded.push(url);
      return '#!/bin/sh\necho installer\n';
    },
    say: (line) => stdout.push(line),
    warn: (line) => stderr.push(line),
    ...deps,
  };
  return { deps: all, ran, stdout, stderr, downloaded };
}

const binary = (execPath: string) => ({ sea: fakeSea('0.12.6'), execPath, realpath: (path: string) => path });

describe('ordewell update', () => {
  describe('a binary the installer put there', () => {
    it('prints the installer command for the binary’s own folder and runs nothing on --dry-run', async () => {
      const m = machine({ sea: binary('/home/me/.local/bin/ordewell') });

      const status = await runUpdate(['--dry-run'], m.deps);

      expect(status).toBe(0);
      expect(m.stdout.join('\n')).toContain(`curl -fsSL ${INSTALLER} | ORDEWELL_INSTALL_DIR=/home/me/.local/bin sh`);
      expect(m.ran).toEqual([]);
      expect(m.downloaded).toEqual([]);
    });

    it('runs the downloaded installer with sh into that folder, then names the version before and after', async () => {
      const m = machine({
        sea: binary('/home/me/.local/bin/ordewell'),
        env: { HOME: '/home/me', PATH: '/usr/bin' },
        outputs: { '/home/me/.local/bin/ordewell --version': '0.13.0' },
      });

      const status = await runUpdate([], m.deps);

      expect(status).toBe(0);
      expect(m.downloaded).toEqual([INSTALLER]);
      expect(m.ran).toEqual([{
        command: 'sh',
        args: ['-s'],
        env: { HOME: '/home/me', PATH: '/usr/bin', ORDEWELL_INSTALL_DIR: '/home/me/.local/bin' },
        input: '#!/bin/sh\necho installer\n',
      }]);
      expect(m.stdout.at(-1)).toBe('Ordewell 0.12.6 → 0.13.0');
    });

    it('exits with the installer’s status when it fails, naming no new version', async () => {
      const m = machine({ sea: binary('/home/me/.local/bin/ordewell'), status: 3 });

      const status = await runUpdate([], m.deps);

      expect(status).toBe(3);
      expect(m.stdout.join('\n')).not.toContain('→');
      expect(m.stderr.join('\n')).toContain('status 3');
    });

    it('runs nothing in a folder it cannot write, and names the command that can', async () => {
      const checked: string[] = [];
      const m = machine({
        sea: binary('/usr/local/bin/ordewell'),
        writable: (dir) => {
          checked.push(dir);
          return false;
        },
      });

      const status = await runUpdate([], m.deps);

      expect(status).toBe(1);
      expect(checked).toEqual(['/usr/local/bin']);
      expect(m.downloaded).toEqual([]);
      expect(m.ran).toEqual([]);
      expect(m.stderr.join('\n')).toContain('/usr/local/bin is not writable');
      expect(m.stderr.join('\n')).toContain(`curl -fsSL ${INSTALLER} | sudo env ORDEWELL_INSTALL_DIR=/usr/local/bin sh`);
    });

    it('updates the file a link points at, in the folder it is really in', async () => {
      const m = machine({
        sea: { sea: fakeSea('0.12.6'), execPath: '/home/me/bin/ordewell', realpath: () => '/opt/ordewell/ordewell' },
      });

      await runUpdate(['--dry-run'], m.deps);

      expect(m.stdout.join('\n')).toContain('| ORDEWELL_INSTALL_DIR=/opt/ordewell sh');
    });

    it('quotes a folder whose name the shell would split', async () => {
      const m = machine({ sea: binary("/home/me/my tools/it's/ordewell") });

      await runUpdate(['--dry-run'], m.deps);

      expect(m.stdout.join('\n')).toContain(`| ORDEWELL_INSTALL_DIR='/home/me/my tools/it'\\''s' sh`);
    });
  });

  describe('when it cannot go on', () => {
    it('runs nothing when the installer cannot be downloaded, and exits 1', async () => {
      const m = machine({
        sea: binary('/home/me/.local/bin/ordewell'),
        download: async (url) => {
          throw new Error(`could not download ${url}: HTTP 404`);
        },
      });

      expect(await runUpdate([], m.deps)).toBe(1);

      expect(m.ran).toEqual([]);
      expect(m.stderr.join('\n')).toContain('HTTP 404');
    });

    it('exits 1 naming the command it could not start', async () => {
      const m = machine({
        sea: binary('/opt/homebrew/Cellar/ordewell/0.12.6/bin/ordewell'),
        run: async () => {
          throw Object.assign(new Error('spawn brew ENOENT'), { code: 'ENOENT' });
        },
      });

      expect(await runUpdate([], m.deps)).toBe(1);

      expect(m.stderr.join('\n')).toContain('spawn brew ENOENT');
    });

    it('says so when the new copy does not answer --version', async () => {
      const m = machine({ sea: binary('/home/me/.local/bin/ordewell') });

      expect(await runUpdate([], m.deps)).toBe(0);

      expect(m.stdout.at(-1)).toBe('Updated Ordewell 0.12.6, but /home/me/.local/bin/ordewell --version did not answer.');
    });
  });

  describe('a Homebrew install', () => {
    it('runs brew upgrade, then asks the copy brew links for its version', async () => {
      const m = machine({
        sea: binary('/opt/homebrew/Cellar/ordewell/0.12.6/bin/ordewell'),
        outputs: { '/opt/homebrew/bin/ordewell --version': '0.13.0' },
      });

      const status = await runUpdate([], m.deps);

      expect(status).toBe(0);
      expect(m.stdout[0]).toBe('Running: brew upgrade ordewell');
      expect(m.ran).toEqual([{ command: 'brew', args: ['upgrade', 'ordewell'] }]);
      expect(m.downloaded).toEqual([]);
      expect(m.stdout.at(-1)).toBe('Ordewell 0.12.6 → 0.13.0');
    });

    it('prints brew upgrade and runs nothing on --dry-run', async () => {
      const m = machine({ sea: binary('/home/linuxbrew/.linuxbrew/Cellar/ordewell/0.12.6/bin/ordewell') });

      expect(await runUpdate(['--dry-run'], m.deps)).toBe(0);

      expect(m.stdout).toEqual(['Would run: brew upgrade ordewell']);
      expect(m.ran).toEqual([]);
    });
  });

  describe('an npm install', () => {
    const node = { sea: null, execPath: '/usr/bin/node', realpath: (path: string) => path };

    it('installs the latest ordewell globally, then asks the same script for its version', async () => {
      const entry = '/usr/lib/node_modules/ordewell/bin/ordewell.js';
      const m = machine({
        sea: node,
        entry,
        outputs: { 'npm root -g': '/usr/lib/node_modules\n', [`/usr/bin/node ${entry} --version`]: '0.13.0' },
      });

      const status = await runUpdate([], m.deps);

      expect(status).toBe(0);
      expect(m.stdout[0]).toBe('Running: npm install -g ordewell@latest');
      expect(m.ran).toEqual([{ command: 'npm', args: ['install', '-g', 'ordewell@latest'] }]);
      expect(m.stdout.at(-1)).toMatch(/^Ordewell .+ → 0\.13\.0$/);
    });

    it('installs the latest @ordewell/cli when that is the package installed', async () => {
      const m = machine({
        sea: node,
        entry: '/usr/lib/node_modules/@ordewell/cli/dist/main.js',
        outputs: { 'npm root -g': '/usr/lib/node_modules' },
      });

      await runUpdate([], m.deps);

      expect(m.ran).toEqual([{ command: 'npm', args: ['install', '-g', '@ordewell/cli@latest'] }]);
    });

    it('runs npm.cmd through a shell on Windows', async () => {
      const m = machine({
        platform: 'win32',
        sea: { ...node, execPath: 'C:\\Program Files\\nodejs\\node.exe' },
        entry: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ordewell\\bin\\ordewell.js',
        outputs: { 'npm.cmd root -g': 'c:\\users\\me\\appdata\\roaming\\npm\\node_modules\r\n' },
      });

      const status = await runUpdate([], m.deps);

      expect(status).toBe(0);
      expect(m.ran).toEqual([{ command: 'npm.cmd', args: ['install', '-g', 'ordewell@latest'], shell: true }]);
    });

    it('prints the npm command and runs nothing on --dry-run', async () => {
      const m = machine({ sea: node, entry: '/usr/lib/node_modules/ordewell/bin/ordewell.js', outputs: { 'npm root -g': '/usr/lib/node_modules' } });

      expect(await runUpdate(['--dry-run'], m.deps)).toBe(0);

      expect(m.stdout).toEqual(['Would run: npm install -g ordewell@latest']);
      expect(m.ran).toEqual([]);
    });
  });

  describe('a copy it cannot update', () => {
    const node = { sea: null, execPath: '/usr/bin/node', realpath: (path: string) => path };

    it.each([
      ['an npx run', '/home/me/.npm/_npx/0a1b2c/node_modules/ordewell/bin/ordewell.js', 'npx ordewell@latest'],
      ['an npx run on Windows', 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0a1b2c\\node_modules\\ordewell\\bin\\ordewell.js', 'npx ordewell@latest'],
      ['a project’s own install', '/home/me/app/node_modules/ordewell/bin/ordewell.js', 'npm install ordewell@latest'],
      ['a source checkout', '/home/me/src/ordewell/packages/cli/dist/main.js', 'pull'],
    ])('runs nothing for %s and says what would', async (_, entry, advice) => {
      const m = machine({ sea: node, entry, outputs: { 'npm root -g': '/usr/lib/node_modules' } });

      for (const args of [[], ['--dry-run']]) {
        expect(await runUpdate(args, m.deps)).toBe(0);
      }

      expect(m.ran).toEqual([]);
      expect(m.stdout).toHaveLength(2);
      expect(m.stdout[0]).toContain(advice);
    });

    it('names the project folder an install belongs to', async () => {
      const m = machine({ sea: node, entry: '/home/me/app/node_modules/ordewell/bin/ordewell.js', outputs: { 'npm root -g': '/usr/lib/node_modules' } });

      await runUpdate([], m.deps);

      expect(m.stdout[0]).toContain('/home/me/app');
    });
  });
});

describe('runUpdate options', () => {
  it('refuses an unknown option before planning or running anything', async () => {
    const m = machine({ sea: binary('/home/me/.local/bin/ordewell') });

    const status = await runUpdate(['--dryrun'], m.deps);

    expect(status).toBe(1);
    expect(m.stderr).toEqual(['Unknown option: --dryrun', 'Run `ordewell update --help` for usage.']);
    expect(m.stdout).toEqual([]);
    expect(m.ran).toEqual([]);
    expect(m.downloaded).toEqual([]);
  });
});
