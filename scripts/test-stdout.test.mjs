import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DefaultSerializer } from 'node:v8';

// node --test runs each file in a child and reads v8-serialized messages from
// its stdout. Node 22's reader takes the bytes right after a message, in the
// same read, for the next message's length, so a raw write that lands in one
// read with a message crashes the file ("Unable to deserialize cloned data").
// Whether the two share a read depends on how busy the parent is, which is why
// it failed on main's push CI and passed in the same tree's other runs.
const header = (() => {
  const serializer = new DefaultSerializer();
  serializer.writeHeader();
  return serializer.releaseBuffer();
})();

async function strayStdout(file) {
  const { stdout } = await promisify(execFile)(process.execPath, [file], {
    encoding: 'buffer',
    env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const stray = [];
  for (let at = 0; at < stdout.length;) {
    if (stdout.subarray(at, at + header.length).equals(header)) {
      at += header.length + 4 + stdout.readUInt32BE(at + header.length);
      continue;
    }
    const next = stdout.indexOf(header, at);
    const end = next === -1 ? stdout.length : next;
    stray.push(stdout.subarray(at, end).toString());
    at = end;
  }
  return stray;
}

const temp = [];
after(() => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }); });

describe('what a test file writes to the stdout node:test reads', () => {
  it('finds a raw write between the messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-stdout-'));
    temp.push(dir);
    const file = join(dir, 'raw.test.mjs');
    writeFileSync(file, "import { it } from 'node:test';\nit('writes', () => { process.stdout.write('raw line\\n'); });\n");
    assert.deepEqual(await strayStdout(file), ['raw line\n']);
  });

  // electron-builder logs to process.stdout as it loads a config.
  it('holds nothing else for desktop-package.test.mjs', async () => {
    assert.deepEqual(await strayStdout(fileURLToPath(new URL('./desktop-package.test.mjs', import.meta.url))), []);
  });
});
