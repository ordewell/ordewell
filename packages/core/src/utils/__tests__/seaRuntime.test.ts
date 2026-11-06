import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { fakeSea } from '../../testing';
import { installMethod, isSea, seaRuntimeDir, seaVersion, upgradeCommand, type SeaModule } from '../seaRuntime';

describe('isSea', () => {
  it('is false where node:sea does not load, and answers from the module where it does', () => {
    expect(isSea({ sea: null })).toBe(false);
    expect(isSea({ sea: { ...fakeSea('1.0.0'), isSea: () => false } })).toBe(false);
    expect(isSea({ sea: fakeSea('1.0.0', {}) })).toBe(true);
  });

  it('is false in this test process, which is plain node', () => {
    expect(isSea()).toBe(false);
  });
});

describe('seaVersion', () => {
  it('is the version the embedded manifest names', () => {
    expect(seaVersion({ sea: fakeSea('3.4.5', {}) })).toBe('3.4.5');
  });

  it('is undefined outside a binary', () => {
    expect(seaVersion({ sea: null })).toBeUndefined();
  });
});

describe('seaRuntimeDir', () => {
  const files = {
    'skills/tdd/SKILL.md': '# tdd\n',
    'skills/explore/SKILL.md': '# explore\n',
    'docker/task.Dockerfile': 'FROM node:22\n',
  };
  let dataDir: string;

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'ordewell-sea-runtime-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('extracts every manifest file into runtime/<version> under the data dir', () => {
    const dir = seaRuntimeDir({ sea: fakeSea('1.2.3', files), dataDir });
    expect(dir).toBe(join(dataDir, 'runtime', '1.2.3'));
    expect(readFileSync(join(dir, 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe('# tdd\n');
    expect(readFileSync(join(dir, 'skills', 'explore', 'SKILL.md'), 'utf8')).toBe('# explore\n');
    expect(readFileSync(join(dir, 'docker', 'task.Dockerfile'), 'utf8')).toBe('FROM node:22\n');
    // Nothing of the extraction is left beside it.
    expect(readdirSync(join(dataDir, 'runtime'))).toEqual(['1.2.3']);
  });

  it('extracts once: a later call leaves the tree as it is', () => {
    const dir = seaRuntimeDir({ sea: fakeSea('1.2.3', files), dataDir });
    const file = join(dir, 'skills', 'tdd', 'SKILL.md');
    writeFileSync(file, 'touched');
    expect(seaRuntimeDir({ sea: fakeSea('1.2.3', files), dataDir })).toBe(dir);
    expect(readFileSync(file, 'utf8')).toBe('touched');
  });

  it('gives a different version a folder of its own', () => {
    const older = seaRuntimeDir({ sea: fakeSea('1.2.3', files), dataDir });
    const newer = seaRuntimeDir({ sea: fakeSea('1.3.0', { ...files, 'skills/tdd/SKILL.md': '# tdd v2\n' }), dataDir });
    expect(newer).toBe(join(dataDir, 'runtime', '1.3.0'));
    expect(readFileSync(join(newer, 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe('# tdd v2\n');
    expect(readFileSync(join(older, 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe('# tdd\n');
  });

  it('survives a second process finishing the same extraction while this one is midway', () => {
    const plain = fakeSea('1.2.3', files);
    let raced = false;
    // The TUI and its daemon start together: the other one completes its
    // extraction between this one's reads and its move into place.
    const racing = {
      isSea: () => true,
      getAsset(key: string, encoding?: string): ArrayBuffer | string {
        if (!raced && key === 'runtime/docker/task.Dockerfile') {
          raced = true;
          seaRuntimeDir({ sea: plain, dataDir });
        }
        return encoding ? plain.getAsset(key, encoding) : plain.getAsset(key);
      },
    } as SeaModule;
    const dir = seaRuntimeDir({ sea: racing, dataDir });
    expect(raced).toBe(true);
    expect(dir).toBe(join(dataDir, 'runtime', '1.2.3'));
    expect(readFileSync(join(dir, 'docker', 'task.Dockerfile'), 'utf8')).toBe('FROM node:22\n');
    expect(readdirSync(join(dataDir, 'runtime'))).toEqual(['1.2.3']);
  });

  it('replaces a folder an interrupted extraction left without its completion marker', () => {
    const dir = join(dataDir, 'runtime', '1.2.3');
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'half'), '');
    expect(seaRuntimeDir({ sea: fakeSea('1.2.3', files), dataDir })).toBe(dir);
    expect(existsSync(join(dir, 'skills', 'half'))).toBe(false);
    expect(readFileSync(join(dir, 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe('# tdd\n');
  });

  it('refuses a manifest path that would land outside the folder', () => {
    expect(() => seaRuntimeDir({ sea: fakeSea('1.2.3', { '../escape': 'x' }), dataDir })).toThrow(/escape/);
    expect(existsSync(join(dataDir, 'runtime', 'escape'))).toBe(false);
    expect(existsSync(join(dataDir, 'escape'))).toBe(false);
  });

  // POSIX file modes; Windows has none to check.
  it.skipIf(process.platform === 'win32')('keeps the files private to the user, as the rest of the data dir', () => {
    const dir = seaRuntimeDir({ sea: fakeSea('1.2.3', files), dataDir });
    expect(statSync(join(dir, 'skills', 'tdd', 'SKILL.md')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'skills', 'tdd')).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('is an error outside a binary, which has its files beside its code', () => {
    expect(() => seaRuntimeDir({ sea: null, dataDir })).toThrow(/binary/);
  });
});

describe('installMethod', () => {
  const sea = fakeSea('1.2.3', {});
  const at = (...parts: string[]): string => join(sep, ...parts);
  const asIs = (p: string): string => p;

  it('is npm outside a binary, whatever runs it', () => {
    expect(installMethod({ sea: null, execPath: at('opt', 'homebrew', 'bin', 'node'), realpath: asIs })).toBe('npm');
  });

  it('is homebrew for a binary whose real path is in a Homebrew Cellar or prefix', () => {
    for (const execPath of [
      at('opt', 'homebrew', 'Cellar', 'ordewell', '1.2.3', 'bin', 'ordewell'),
      at('usr', 'local', 'Cellar', 'ordewell', '1.2.3', 'bin', 'ordewell'),
      at('home', 'linuxbrew', '.linuxbrew', 'Cellar', 'ordewell', '1.2.3', 'bin', 'ordewell'),
      at('home', 'me', 'brew', 'Cellar', 'ordewell', '1.2.3', 'bin', 'ordewell'),
    ]) {
      expect(installMethod({ sea, execPath, realpath: asIs })).toBe('homebrew');
    }
  });

  it('follows the brew link to the Cellar', () => {
    const link = at('usr', 'local', 'bin', 'ordewell');
    const cellar = at('usr', 'local', 'Cellar', 'ordewell', '1.2.3', 'bin', 'ordewell');
    expect(installMethod({ sea, execPath: link, realpath: (p) => (p === link ? cellar : p) })).toBe('homebrew');
    expect(installMethod({ sea, execPath: link, realpath: asIs })).toBe('binary');
  });

  it('is binary for one the installer put anywhere else', () => {
    expect(installMethod({ sea, execPath: at('home', 'me', '.local', 'bin', 'ordewell'), realpath: asIs })).toBe('binary');
    expect(installMethod({ sea, execPath: at('usr', 'local', 'bin', 'ordewell'), realpath: () => { throw new Error('gone'); } })).toBe('binary');
  });
});

describe('upgradeCommand', () => {
  it('names the upgrade each install method has', () => {
    expect(upgradeCommand('npm')).toBe('npm i -g ordewell');
    expect(upgradeCommand('homebrew')).toBe('brew upgrade ordewell');
    expect(upgradeCommand('binary')).toBe('curl -fsSL https://ordewell.ai/install.sh | sh');
  });
});
