import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  EXPECTED_FUSES,
  UNPACKED_ENTRIES,
  checkResources,
  expectedInstallers,
  fuseDrift,
  fuseTarget,
  missingInstallers,
  resourcesDirs,
  smokeDaemon,
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

describe('checkResources', () => {
  const fill = (resources) => {
    touch(join(resources, 'app.asar'));
    for (const entry of UNPACKED_ENTRIES) touch(join(resources, 'app.asar.unpacked', entry));
    for (const notice of ['LICENSE', 'NOTICE', 'AUTHORS.md']) touch(join(resources, notice));
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
