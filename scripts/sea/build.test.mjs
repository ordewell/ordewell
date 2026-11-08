// The pure parts of the standalone CLI build (scripts/sea/build.mjs): what it
// names, what it embeds and how it packs. The build itself needs a real Node
// 22 binary to inject into and runs on the release machines, not here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, describe, it } from 'node:test';

import { hostHas } from '../host-tools.mjs';
import {
  SENTINEL_FUSE,
  archiveName,
  codesignArgs,
  injectOptions,
  nodeVersionProblem,
  parseBuildArgs,
  runtimeFiles,
  runtimeManifest,
  seaConfig,
  tarGz,
  unloadableImports,
} from './build.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'ordewell-sea-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('the Node the build embeds', () => {
  it('accepts 22.17 and any later 22.x', () => {
    assert.equal(nodeVersionProblem('v22.17.0'), undefined);
    assert.equal(nodeVersionProblem('v22.23.4'), undefined);
  });

  it('refuses an earlier 22, and any other major', () => {
    for (const version of ['v22.16.0', 'v22.0.0', 'v20.19.0', 'v23.11.0', 'v24.1.0']) {
      assert.match(nodeVersionProblem(version) ?? '', new RegExp(version.replace(/\./g, '\\.')), version);
    }
  });
});

describe('the archive name', () => {
  it('names the version, the OS and the architecture', () => {
    assert.equal(archiveName('0.12.6', 'darwin', 'arm64'), 'ordewell-0.12.6-darwin-arm64.tar.gz');
    assert.equal(archiveName('0.12.6', 'darwin', 'x64'), 'ordewell-0.12.6-darwin-x64.tar.gz');
    assert.equal(archiveName('1.0.0', 'linux', 'x64'), 'ordewell-1.0.0-linux-x64.tar.gz');
    assert.equal(archiveName('1.0.0', 'linux', 'arm64'), 'ordewell-1.0.0-linux-arm64.tar.gz');
  });

  it('refuses a platform the binary is not shipped for', () => {
    assert.throws(() => archiveName('1.0.0', 'win32', 'x64'), /win32-x64/);
    assert.throws(() => archiveName('1.0.0', 'linux', 'ia32'), /linux-ia32/);
  });
});

describe('the runtime files', () => {
  const core = join(scratch, 'core');
  mkdirSync(join(core, 'skills', 'tdd'), { recursive: true });
  mkdirSync(join(core, 'skills', 'deep', 'nested'), { recursive: true });
  mkdirSync(join(core, 'docker'), { recursive: true });
  mkdirSync(join(core, 'src'), { recursive: true });
  writeFileSync(join(core, 'skills', 'tdd', 'SKILL.md'), '# tdd\n');
  writeFileSync(join(core, 'skills', 'deep', 'nested', 'notes.md'), 'x');
  writeFileSync(join(core, 'docker', 'task.Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(core, 'src', 'index.ts'), 'export {};\n');

  it('are every file under skills/ and docker/, relative to core with forward slashes', () => {
    assert.deepEqual(runtimeFiles(core), ['docker/task.Dockerfile', 'skills/deep/nested/notes.md', 'skills/tdd/SKILL.md']);
  });

  it('include the real core\'s container recipe and its skills', () => {
    const files = runtimeFiles(join(import.meta.dirname, '..', '..', 'packages', 'core'));
    assert.ok(files.includes('docker/task.Dockerfile'));
    assert.ok(files.includes('skills/tdd/SKILL.md'));
    assert.ok(files.every((file) => !file.includes('\\')));
  });

  it('are listed in a manifest beside the version', () => {
    assert.deepEqual(runtimeManifest('0.12.6', ['docker/task.Dockerfile']), {
      version: '0.12.6',
      files: ['docker/task.Dockerfile'],
    });
  });

  it('are embedded under runtime/, with the manifest, by the SEA config', () => {
    const config = seaConfig({
      main: join(scratch, 'sea.cjs'),
      output: join(scratch, 'sea-prep.blob'),
      manifest: join(scratch, 'manifest.json'),
      coreDir: core,
      files: ['docker/task.Dockerfile', 'skills/tdd/SKILL.md'],
    });
    assert.deepEqual(config, {
      main: join(scratch, 'sea.cjs'),
      output: join(scratch, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: {
        'runtime/manifest.json': join(scratch, 'manifest.json'),
        'runtime/docker/task.Dockerfile': join(core, 'docker', 'task.Dockerfile'),
        'runtime/skills/tdd/SKILL.md': join(core, 'skills', 'tdd', 'SKILL.md'),
      },
    });
  });
});

describe('the bundle', () => {
  it('may leave built-ins and the optional helpers external, and nothing else', () => {
    const imports = [
      { path: 'node:sqlite', kind: 'require-call', external: true },
      { path: 'fs', kind: 'require-call', external: true },
      { path: 'worker_threads', kind: 'import-statement', external: true },
      { path: 'bufferutil', kind: 'require-call', external: true },
      { path: 'utf-8-validate', kind: 'require-call', external: true },
      { path: 'encoding', kind: 'require-call', external: true },
      { path: 'hono', kind: 'require-call', external: true },
      { path: 'hono', kind: 'import-statement', external: true },
      { path: './chunk.js', kind: 'dynamic-import', external: true },
      { path: 'zod', kind: 'require-call', external: false },
      { path: '@ordewell/web/package.json', kind: 'require-resolve', external: true },
    ];
    assert.deepEqual(unloadableImports(imports), ['./chunk.js', 'hono']);
  });
});

describe('the injection', () => {
  it('uses Node\'s SEA fuse, and the NODE_SEA segment on macOS alone', () => {
    assert.equal(SENTINEL_FUSE, 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
    assert.deepEqual(injectOptions('linux'), { sentinelFuse: SENTINEL_FUSE });
    assert.deepEqual(injectOptions('darwin'), { sentinelFuse: SENTINEL_FUSE, machoSegmentName: 'NODE_SEA' });
  });
});

describe('the macOS signature', () => {
  it('is ad hoc without an identity', () => {
    assert.deepEqual(codesignArgs('/out/ordewell', { entitlements: '/e.plist' }), ['--sign', '-', '--force', '/out/ordewell']);
  });

  it('is a hardened-runtime Developer ID signature, with the JIT entitlements, given one', () => {
    assert.deepEqual(codesignArgs('/out/ordewell', { identity: 'Developer ID Application: X (T)', entitlements: '/e.plist' }), [
      '--sign', 'Developer ID Application: X (T)',
      '--force',
      '--options', 'runtime',
      '--timestamp',
      '--entitlements', '/e.plist',
      '/out/ordewell',
    ]);
  });

  it('entitlements grant the JIT what it needs and nothing past it', () => {
    const plist = readFileSync(join(import.meta.dirname, '..', '..', 'packaging', 'sea', 'entitlements.plist'), 'utf8');
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1]).sort();
    assert.deepEqual(keys, ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']);
  });
});

describe('the build\'s arguments', () => {
  const root = join(scratch, 'repo');

  it('default to an unsigned build into dist-sea/', () => {
    assert.deepEqual(parseBuildArgs([], {}, root), { out: join(root, 'dist-sea'), identity: undefined });
  });

  it('take an output directory and a signing identity, from a flag or the environment', () => {
    assert.deepEqual(parseBuildArgs(['--out', 'x', '--sign', 'ID'], {}, root), { out: join(root, 'x'), identity: 'ID' });
    assert.equal(parseBuildArgs([], { ORDEWELL_SEA_SIGN_IDENTITY: 'Env ID' }, root).identity, 'Env ID');
    assert.equal(parseBuildArgs(['--sign', 'Flag ID'], { ORDEWELL_SEA_SIGN_IDENTITY: 'Env ID' }, root).identity, 'Flag ID');
  });

  it('refuse what they do not know, and a flag without its value', () => {
    assert.throws(() => parseBuildArgs(['--notarize'], {}, root), /--notarize/);
    assert.throws(() => parseBuildArgs(['--out'], {}, root), /--out/);
  });
});

describe('the archive', () => {
  const binary = Buffer.from('#!/bin/sh\necho ordewell\n');
  const archive = tarGz('ordewell', binary, 0o755);

  /** One ustar header field, as the format lays it out. */
  const field = (header, offset, length) => header.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/s, '');

  it('holds one executable regular file at its root, as ustar lays it out', () => {
    const tar = gunzipSync(archive);
    assert.equal(tar.length % 512, 0);
    const header = tar.subarray(0, 512);
    assert.equal(field(header, 0, 100), 'ordewell');
    assert.equal(parseInt(field(header, 100, 8), 8), 0o755);
    assert.equal(parseInt(field(header, 124, 12), 8), binary.length);
    assert.equal(field(header, 156, 1), '0');
    assert.equal(field(header, 257, 6), 'ustar');
    const sum = [...header].reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 0x20 : byte), 0);
    assert.equal(parseInt(field(header, 148, 8), 8), sum);
    assert.deepEqual(tar.subarray(512, 512 + binary.length), binary);
    // Two zero blocks end the archive, after the data's padding.
    const end = 512 + Math.ceil(binary.length / 512) * 512;
    assert.equal(tar.length, end + 1024);
    assert.ok(tar.subarray(end).every((byte) => byte === 0));
  });

  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  it('extracts with the system tar', (t) => {
    if (!hostHas('tar', { present: tar.status === 0 })) return t.skip('no tar on PATH');
    const dir = join(scratch, 'extract');
    mkdirSync(dir);
    writeFileSync(join(scratch, 'a.tar.gz'), archive);
    // Relative to cwd: Git Bash's tar reads `C:\...` as a remote host.
    const result = spawnSync('tar', ['-xzf', join('..', 'a.tar.gz')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(dir, 'ordewell')), binary);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'ordewell')).mode & 0o777, 0o755);
  });
});
