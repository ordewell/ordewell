import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  EXPECTED_FUSES,
  UNPACKED_ENTRIES,
  asarFile,
  bakedAutoUpdate,
  binaryArchs,
  checkResources,
  expectedArch,
  expectedInstallers,
  fuseDrift,
  fuseTarget,
  missingInstallers,
  ptyEntries,
  resourcesDirs,
  signatureChecks,
  publisherNamesIn,
  signingProblems,
  smokeDaemon,
  smokePty,
} from './desktop-package-check.mjs';

const temp = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-package-check-test-'));
  temp.push(dir);
  return dir;
};
after(() => temp.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const touch = (path, content = 'x') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

describe('expectedInstallers', () => {
  it('names a dmg and a zip per macOS architecture', () => {
    assert.deepEqual(expectedInstallers('1.2.3', 'darwin'), [
      'Ordewell-1.2.3-mac-arm64.dmg',
      'Ordewell-1.2.3-mac-arm64.zip',
      'Ordewell-1.2.3-mac-x64.dmg',
      'Ordewell-1.2.3-mac-x64.zip',
    ]);
  });

  it('names the NSIS installer on Windows and the AppImage and deb on Linux', () => {
    assert.deepEqual(expectedInstallers('1.2.3', 'win32'), ['Ordewell-1.2.3-win-x64.exe']);
    assert.deepEqual(expectedInstallers('1.2.3', 'linux'), ['Ordewell-1.2.3-linux-x64.AppImage', 'Ordewell-1.2.3-linux-x64.deb']);
  });
});

describe('missingInstallers', () => {
  it('reports one that is absent and one that is empty, and nothing else', () => {
    const sizes = { a: 10, b: 0 };
    assert.deepEqual(missingInstallers(['a', 'b', 'c'], ['a', 'b'], (file) => sizes[file]), ['b', 'c']);
  });
});

/** The first bytes of a native binary: a real header, so binaryArchs reads it as the loader would. */
const MACHO = { arm64: 0x0100000c, x64: 0x01000007 };
const header = {
  macho: (arch) => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(MACHO[arch], 4);
    return buf;
  },
  fat: (...archs) => {
    const buf = Buffer.alloc(8 + archs.length * 20);
    buf.writeUInt32BE(0xcafebabe, 0);
    buf.writeUInt32BE(archs.length, 4);
    archs.forEach((arch, i) => buf.writeUInt32BE(MACHO[arch], 8 + i * 20));
    return buf;
  },
  elf: (arch) => {
    const buf = Buffer.alloc(64);
    buf.writeUInt32BE(0x7f454c46, 0);
    buf.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18);
    return buf;
  },
  pe: (arch) => {
    const buf = Buffer.alloc(0x100);
    buf.writeUInt16LE(0x5a4d, 0);
    buf.writeUInt32LE(0x80, 0x3c);
    buf.writeUInt32LE(0x00004550, 0x80);
    buf.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x84);
    return buf;
  },
};
const nativeFor = { darwin: header.macho, linux: header.elf, win32: header.pe }[process.platform];

describe('checkResources', () => {
  const fill = (resources) => {
    touch(join(resources, 'app.asar'));
    for (const entry of [...UNPACKED_ENTRIES, ...ptyEntries()]) touch(join(resources, 'app.asar.unpacked', entry), entry.includes('build/Release') ? nativeFor('x64') : 'x');
    if (process.platform === 'darwin') chmodSync(join(resources, 'app.asar.unpacked', ptyEntries()[1]), 0o755);
    for (const notice of ['LICENSE', 'NOTICE', 'AUTHORS.md', 'THIRD-PARTY-NOTICES.md']) touch(join(resources, notice));
  };

  it('accepts a resources directory with the archive, the daemon closure and the notices', () => {
    const resources = scratch();
    fill(resources);
    assert.deepEqual(checkResources(resources), []);
  });

  it('names a daemon file left inside the archive, which a utility process cannot read', () => {
    const resources = scratch();
    fill(resources);
    rmSync(join(resources, 'app.asar.unpacked', 'node_modules/ws'), { recursive: true });
    const failures = checkResources(resources);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /app\.asar\.unpacked\/node_modules\/ws\/package\.json is missing/);
  });

  it('accepts a dependency nested under web, where Node resolves it from the daemon too', () => {
    const resources = scratch();
    fill(resources);
    const unpacked = join(resources, 'app.asar.unpacked');
    rmSync(join(unpacked, 'node_modules/hono'), { recursive: true });
    assert.match(checkResources(resources).join('\n'), /hono\/package\.json is missing/);
    touch(join(unpacked, 'node_modules/@ordewell/web/node_modules/hono/package.json'));
    assert.deepEqual(checkResources(resources), []);
  });

  it('names a pty addon that was not rebuilt or was left inside the archive', () => {
    const resources = scratch();
    fill(resources);
    rmSync(join(resources, 'app.asar.unpacked', 'node_modules/node-pty'), { recursive: true });
    assert.match(checkResources(resources).join('\n'), /node-pty\/build\/Release\/pty\.node is missing, so the terminal could not start/);
  });

  it('names a macOS spawn-helper that lost its executable bit', () => {
    const resources = scratch();
    fill(resources);
    const failures = checkResources(resources, undefined, 'darwin', () => 0o644);
    assert.match(failures.join('\n'), /spawn-helper is not executable/);
    assert.deepEqual(checkResources(resources, undefined, 'darwin', () => 0o755).filter((f) => f.includes('spawn-helper')), []);
  });

  it('names a native binary built for the wrong architecture', () => {
    const resources = scratch();
    fill(resources);
    const failures = checkResources(resources, undefined, process.platform, undefined, () => ['arm64']);
    assert.match(failures.join('\n'), /pty\.node holds arm64, expected x64/);
    assert.match(checkResources(resources, undefined, process.platform, undefined, () => []).join('\n'), /holds no recognisable machine code, expected x64/);
  });

  it('holds each macOS build to its own architecture, so a host binary in the x64 app is caught', () => {
    const app = (dir) => join(scratch(), dir, 'Ordewell.app', 'Contents', 'Resources');
    const arm = app('mac-arm64');
    const intel = app('mac');
    for (const resources of [arm, intel]) {
      touch(join(resources, 'app.asar'));
      for (const entry of UNPACKED_ENTRIES) touch(join(resources, 'app.asar.unpacked', entry));
      for (const notice of ['LICENSE', 'NOTICE', 'AUTHORS.md', 'THIRD-PARTY-NOTICES.md']) touch(join(resources, notice));
    }
    const put = (resources, arch) => {
      for (const entry of ptyEntries('darwin')) {
        touch(join(resources, 'app.asar.unpacked', entry), header.macho(arch));
        chmodSync(join(resources, 'app.asar.unpacked', entry), 0o755);
      }
    };
    put(arm, 'arm64');
    put(intel, 'x64');
    assert.deepEqual(checkResources(arm, undefined, 'darwin'), []);
    assert.deepEqual(checkResources(intel, undefined, 'darwin'), []);
    put(intel, 'arm64');
    const failures = checkResources(intel, undefined, 'darwin');
    assert.equal(failures.length, 2, 'pty.node and spawn-helper');
    assert.match(failures[0], /holds arm64, expected x64/);
  });

  it('names a missing notice', () => {
    const resources = scratch();
    fill(resources);
    rmSync(join(resources, 'NOTICE'));
    assert.match(checkResources(resources).join('\n'), /NOTICE is not shipped/);
  });
});

describe('where the unpacked app lives', () => {
  it('is per OS, with both macOS architectures', () => {
    assert.deepEqual(resourcesDirs('r', 'darwin'), [
      join('r', 'mac-arm64', 'Ordewell.app', 'Contents', 'Resources'),
      join('r', 'mac', 'Ordewell.app', 'Contents', 'Resources'),
    ]);
    assert.deepEqual(resourcesDirs('r', 'win32'), [join('r', 'win-unpacked', 'resources')]);
    assert.deepEqual(resourcesDirs('r', 'linux'), [join('r', 'linux-unpacked', 'resources')]);
  });

  it('reads fuses from the linux executable electron-builder.yml names, not a guess', () => {
    assert.equal(fuseTarget('r', 'linux'), join('r', 'linux-unpacked', 'ordewell-desktop'));
    assert.equal(fuseTarget('r', 'win32'), join('r', 'win-unpacked', 'Ordewell.exe'));
  });
});

describe('binaryArchs', () => {
  it('reads thin Mach-O, fat Mach-O, ELF and PE headers', () => {
    assert.deepEqual(binaryArchs(header.macho('arm64')), ['arm64']);
    assert.deepEqual(binaryArchs(header.macho('x64')), ['x64']);
    assert.deepEqual(binaryArchs(header.fat('x64', 'arm64')), ['x64', 'arm64']);
    assert.deepEqual(binaryArchs(header.elf('x64')), ['x64']);
    assert.deepEqual(binaryArchs(header.elf('arm64')), ['arm64']);
    assert.deepEqual(binaryArchs(header.pe('x64')), ['x64']);
    assert.deepEqual(binaryArchs(header.pe('arm64')), ['arm64']);
  });

  it('gives nothing for a file that is not machine code, and names a machine it does not know', () => {
    assert.deepEqual(binaryArchs(Buffer.from('x')), []);
    assert.deepEqual(binaryArchs(Buffer.from('#!/bin/sh\nexit 0\n'.padEnd(80))), []);
    const ppc = header.macho('x64');
    ppc.writeUInt32LE(0x01000012, 4);
    assert.deepEqual(binaryArchs(ppc), ['unknown(1000012)']);
  });

  it('reads the binary node-pty was rebuilt into on this machine', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const pty = 'node_modules/node-pty/build/Release/pty.node';
    if (!existsSync(pty)) return;
    assert.ok(binaryArchs(readFileSync(pty)).length > 0);
  });
});

describe('expectedArch', () => {
  it('is arm64 for the mac-arm64 app and x64 for the mac one, and x64 off macOS', () => {
    const resources = (dir) => join('release', dir, 'Ordewell.app', 'Contents', 'Resources');
    assert.equal(expectedArch(resources('mac-arm64'), 'darwin'), 'arm64');
    assert.equal(expectedArch(resources('mac'), 'darwin'), 'x64');
    assert.equal(expectedArch(join('release', 'win-unpacked', 'resources'), 'win32'), 'x64');
    assert.equal(expectedArch(join('release', 'linux-unpacked', 'resources'), 'linux'), 'x64');
  });
});

describe('fuseDrift', () => {
  // The index of each fuse in a wire, as @electron/fuses numbers them.
  const options = Object.fromEntries(Object.keys(EXPECTED_FUSES).map((name, index) => [name, index]));
  const wire = (overrides = {}) =>
    Object.fromEntries(Object.entries(EXPECTED_FUSES).map(([name, on]) => [options[name], overrides[name] ?? (on ? 49 : 48)]));

  it('is empty when every fuse is as listed', () => {
    assert.deepEqual(fuseDrift(wire(), options), []);
  });

  it('names a fuse that is on when it must be off, and one that was removed from the wire', () => {
    assert.deepEqual(fuseDrift(wire({ RunAsNode: 49, OnlyLoadAppFromAsar: 114 }), options), [
      'RunAsNode is true, expected false',
      'OnlyLoadAppFromAsar is not set, expected true',
    ]);
  });

  it('matches electron-builder.yml, so the two lists cannot drift', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync('packages/desktop/electron-builder.yml', 'utf8');
    const camel = (name) => name[0].toLowerCase() + name.slice(1);
    for (const [name, on] of Object.entries(EXPECTED_FUSES)) {
      assert.match(yml, new RegExp(`^  ${camel(name)}: ${on}$`, 'm'), `${name} in electron-builder.yml`);
    }
  });
});

describe('smokeDaemon', () => {
  it('reports a daemon that answers over HTTP, whatever the status', async () => {
    const dir = scratch();
    const entry = join(dir, 'main.js');
    writeFileSync(entry, [
      "const http = require('node:http');",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "http.createServer((req, res) => { res.statusCode = 401; res.end(); }).listen(port, '127.0.0.1');",
    ].join('\n'));
    assert.deepEqual(await smokeDaemon(entry), { ok: true, status: 401 });
  });

  it('says a daemon that dies at load did, with what it printed', async () => {
    const dir = scratch();
    const entry = join(dir, 'main.js');
    writeFileSync(entry, "throw new Error(\"Cannot find module 'hono'\");");
    const result = await smokeDaemon(entry);
    assert.equal(result.ok, false);
    assert.match(result.message, /exited early.*hono/s);
  });
});

describe('ptyEntries', () => {
  it('asks for the helper on macOS only', () => {
    assert.deepEqual(ptyEntries('darwin'), ['node_modules/node-pty/build/Release/pty.node', 'node_modules/node-pty/build/Release/spawn-helper']);
    assert.deepEqual(ptyEntries('linux'), ['node_modules/node-pty/build/Release/pty.node']);
    assert.deepEqual(ptyEntries('win32'), ['node_modules/node-pty/build/Release/pty.node']);
  });
});

describe('smokePty', () => {
  // A stand-in for node-pty, so the test needs no native addon of its own.
  const fake = (spawnBody) => {
    const modules = scratch();
    touch(join(modules, 'node-pty', 'index.js'), `exports.spawn = ${spawnBody};`);
    return modules;
  };

  it('passes when the shell\'s output comes back through the pty', () => {
    const modules = fake(`() => ({ onData: (cb) => setImmediate(() => cb('ow-pty-ok\\r\\n')), onExit: () => {} })`);
    assert.deepEqual(smokePty(modules), { ok: true });
  });

  it('fails when the pty ends without the output', () => {
    const modules = fake(`() => ({ onData: () => {}, onExit: (cb) => setImmediate(cb) })`);
    assert.equal(smokePty(modules).ok, false);
  });

  it('fails, and says why, when the addon cannot be loaded', () => {
    const modules = fake(`() => { throw new Error('posix_spawnp failed.') }`);
    assert.match(smokePty(modules).message, /posix_spawnp failed/);
  });

  it('reports a directory with no node-pty', () => {
    assert.equal(smokePty(scratch()).ok, false);
  });
});

/** An asar as electron/asar lays it out: a pickled header holding JSON, then the files' bytes. */
function asar(files) {
  const tree = { files: {} };
  const bodies = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node.files[part] ??= { files: {} };
    const body = Buffer.from(content);
    node.files[parts.at(-1)] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, ...bodies]);
}

describe('asarFile', () => {
  it('reads a file out of an archive by its path', () => {
    const archive = asar({ 'package.json': '{}', 'dist/main/index.js': 'var AUTO_UPDATE_ENABLED = true ;' });
    assert.equal(asarFile(archive, 'dist/main/index.js'), 'var AUTO_UPDATE_ENABLED = true ;');
    assert.equal(asarFile(archive, 'package.json'), '{}');
  });

  it('gives null for a path the archive does not hold', () => {
    assert.equal(asarFile(asar({ 'a.js': 'x' }), 'dist/main/index.js'), null);
  });
});

describe('bakedAutoUpdate', () => {
  it('reads the gate tsup folded into main\'s bundle', () => {
    assert.equal(bakedAutoUpdate('x;\nvar AUTO_UPDATE_ENABLED = true ;\nvar y'), true);
    assert.equal(bakedAutoUpdate('var AUTO_UPDATE_ENABLED = false;'), false);
    assert.equal(bakedAutoUpdate('var AUTO_UPDATE_ENABLED2 = false;'), false);
  });

  it('gives null for a bundle built without the define, where nothing was decided', () => {
    assert.equal(bakedAutoUpdate('var AUTO_UPDATE_ENABLED = typeof __ORDEWELL_AUTO_UPDATE__ === "boolean" ? __ORDEWELL_AUTO_UPDATE__ : false;'), null);
    assert.equal(bakedAutoUpdate(null), null);
  });
});

describe('signingProblems', () => {
  const unsigned = { platform: 'darwin', signing: null, notarized: false, autoUpdate: false };
  const shipped = { platform: 'darwin', signing: 'certificate', notarized: true, autoUpdate: true };

  it('accepts an unsigned build with updates off and a signed, notarized one with them on', () => {
    assert.deepEqual(signingProblems(unsigned, false, 'darwin'), []);
    assert.deepEqual(signingProblems(shipped, true, 'darwin'), []);
    assert.deepEqual(signingProblems({ platform: 'win32', signing: 'azure', notarized: false, autoUpdate: true }, true, 'win32'), []);
  });

  it('names a build with no manifest, or one made for another OS', () => {
    assert.match(signingProblems(null, false, 'darwin').join('\n'), /signing\.json/);
    assert.match(signingProblems({ ...unsigned, platform: 'linux' }, false, 'darwin').join('\n'), /linux/);
  });

  it('names an app whose baked gate is missing or disagrees with what the build was', () => {
    assert.match(signingProblems(unsigned, null, 'darwin').join('\n'), /not baked/);
    assert.match(signingProblems(unsigned, true, 'darwin').join('\n'), /updates on/);
    assert.match(signingProblems(shipped, false, 'darwin').join('\n'), /updates off/);
  });

  it('names updates on where the build is not signed, or on macOS not notarized, or on Linux at all', () => {
    assert.match(signingProblems({ ...unsigned, autoUpdate: true }, true, 'darwin').join('\n'), /not signed/);
    assert.match(signingProblems({ ...shipped, notarized: false }, true, 'darwin').join('\n'), /not notarized/);
    assert.match(signingProblems({ platform: 'linux', signing: null, notarized: false, autoUpdate: true }, true, 'linux').join('\n'), /Linux/);
  });
});

describe('signatureChecks', () => {
  const release = '/r';
  const commands = (checks) => checks.map(({ file, args }) => [file, ...args].join(' '));

  it('runs nothing for an unsigned build, which keeps the checks above', () => {
    assert.deepEqual(signatureChecks({ platform: 'darwin', signing: null, notarized: false }, release, '1.0.0', 'darwin'), []);
    assert.deepEqual(signatureChecks({ platform: 'win32', signing: null, notarized: false }, release, '1.0.0', 'win32'), []);
  });

  it('verifies both macOS apps deeply and strictly, their hardened runtime, and Gatekeeper and the stapled ticket when notarized', () => {
    const apps = ['/r/mac-arm64/Ordewell.app', '/r/mac/Ordewell.app'];
    const signed = commands(signatureChecks({ platform: 'darwin', signing: 'certificate', notarized: false }, release, '1.0.0', 'darwin'));
    for (const app of apps) {
      assert.ok(signed.includes(`codesign --verify --deep --strict --verbose=2 ${app}`));
      assert.ok(signed.includes(`codesign --display --verbose=2 ${app}`));
    }
    assert.ok(!signed.some((command) => command.startsWith('spctl')));
    const notarized = commands(signatureChecks({ platform: 'darwin', signing: 'certificate', notarized: true }, release, '1.0.0', 'darwin'));
    for (const app of apps) {
      assert.ok(notarized.includes(`spctl --assess --type execute --verbose=2 ${app}`));
      assert.ok(notarized.includes(`xcrun stapler validate ${app}`));
    }
  });

  it('holds the hardened runtime check to the flags codesign prints', () => {
    const [, display] = signatureChecks({ platform: 'darwin', signing: 'certificate', notarized: false }, release, '1.0.0', 'darwin');
    assert.equal(display.accept({ status: 0, stdout: '', stderr: 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1' }), true);
    assert.equal(display.accept({ status: 0, stdout: '', stderr: 'CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1' }), false);
  });

  it('asks Windows for a valid Authenticode signature on the app and the installer', () => {
    const checks = signatureChecks({ platform: 'win32', signing: 'azure', notarized: false }, release, '1.0.0', 'win32');
    const targets = checks.map(({ args }) => args.at(-1));
    assert.ok(targets.some((command) => command.includes(join('/r', 'win-unpacked', 'Ordewell.exe'))));
    assert.ok(targets.some((command) => command.includes(join('/r', 'Ordewell-1.0.0-win-x64.exe'))));
    assert.equal(checks[0].accept({ status: 0, stdout: 'Valid\r\n', stderr: '' }), true);
    assert.equal(checks[0].accept({ status: 0, stdout: 'NotSigned\r\n', stderr: '' }), false);
  });
});

describe('publisherNamesIn', () => {
  it('reads one name, several, and quoted ones from app-update.yml', () => {
    assert.deepEqual(publisherNamesIn('provider: github\npublisherName: Ordewell\nupdaterCacheDirName: x\n'), ['Ordewell']);
    assert.deepEqual(publisherNamesIn('publisherName:\n  - Ada Lovelace\n  - "Acme, Inc."\n  - \'O\'\'Brien\'\nupdaterCacheDirName: x\n'), ['Ada Lovelace', 'Acme, Inc.', "O'Brien"]);
    assert.deepEqual(publisherNamesIn('provider: github\n'), []);
  });
});
