import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { isNetworkFault, runRetryingNetwork } from './network-retry.mjs';

const sink = () => {
  const chunks = [];
  return Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }), { text: () => Buffer.concat(chunks).toString() });
};

describe('network-retry', () => {
  it('reads the faults CI met as the network\'s', () => {
    for (const output of [
      '  ⨯ Response code 504 (Gateway Time-out)  failedTask=build stackTrace=HTTPError: Response code 504',
      'npm error code ECONNRESET\nnpm error network aborted',
      'npm ERR! network request to https://registry.npmjs.org/x failed',
      'E: Failed to fetch http://deb.debian.org/debian/pool/main/g/git/git_2.39.deb  Could not connect',
      'Err:1 http://deb.debian.org/debian bookworm InRelease\n  Temporary failure resolving \'deb.debian.org\'',
      'Error: getaddrinfo EAI_AGAIN github.com',
      'Error: socket hang up',
      'net/http: TLS handshake timeout',
    ]) assert.equal(isNetworkFault(output), true, output);
  });

  it('leaves a command\'s own failure to it', () => {
    for (const output of [
      'Error: Cannot find module \'electron\'',
      '⨯ cannot execute  cause=exit status 2',
      'AssertionError: expected 504 to equal 200',
      'ERROR: failed to solve: process "/bin/sh -c npm install -g x" did not complete successfully: exit code: 1',
    ]) assert.equal(isNetworkFault(output), false, output);
  });

  describe('runRetryingNetwork', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-network-retry-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    // Fails on the network until it has failed `times` times, counting in a file.
    const flaky = (name, times, fault) => {
      const script = join(dir, `${name}.mjs`);
      writeFileSync(script, [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        `const file = ${JSON.stringify(join(dir, `${name}.count`))};`,
        "const seen = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;",
        'writeFileSync(file, String(seen + 1));',
        `if (seen < ${times}) { console.error(${JSON.stringify(fault)}); process.exit(3); }`,
        "process.stdout.write('packaged');",
      ].join('\n'));
      return script;
    };

    const runFlaky = (script, options = {}) => {
      const stdout = sink();
      const stderr = sink();
      const waits = [];
      const warnings = [];
      return runRetryingNetwork(process.execPath, [script], {
        stdout, stderr, sleep: async (ms) => { waits.push(ms); }, log: (line) => warnings.push(line), ...options,
      }).then((result) => ({ result, stdout: stdout.text(), stderr: stderr.text(), waits, warnings }));
    };

    it('tries again after a growing pause while the network fails it, and streams every try\'s output', async () => {
      const run = await runFlaky(flaky('cdn', 2, 'HTTPError: Response code 504 (Gateway Time-out)'));
      assert.deepEqual(run.result, { status: 0, signal: null, error: undefined });
      assert.deepEqual(run.waits, [15_000, 30_000]);
      assert.equal(run.warnings.length, 2);
      assert.match(run.warnings[0], /failed on the network \(try 1 of 4\); trying again in 15s/);
      assert.equal(run.stdout, 'packaged');
      assert.equal(run.stderr.match(/Response code 504/g).length, 2);
    });

    it('gives up after the last try and returns its exit', async () => {
      const run = await runFlaky(flaky('down', 9, 'getaddrinfo ENOTFOUND github.com'), { tries: 3 });
      assert.equal(run.result.status, 3);
      assert.equal(run.waits.length, 2);
    });

    it('fails once on a failure of the command\'s own', async () => {
      const run = await runFlaky(flaky('broken', 9, 'TypeError: config.linux is not iterable'));
      assert.equal(run.result.status, 3);
      assert.deepEqual(run.waits, []);
      assert.deepEqual(run.warnings, []);
    });

    it('hands each try the same input', async () => {
      const script = join(dir, 'echo.mjs');
      writeFileSync(script, "process.stdin.pipe(process.stdout);");
      const run = await runFlaky(script, { input: 'FROM node:22-slim\n' });
      assert.equal(run.stdout, 'FROM node:22-slim\n');
    });

    it('reports a command that cannot start', async () => {
      const missing = join(dir, 'no-such-binary');
      assert.equal(existsSync(missing), false);
      const { status, error } = await runRetryingNetwork(missing, [], { stdout: sink(), stderr: sink(), log: () => {} });
      assert.equal(status, null);
      assert.match(error.message, /ENOENT/);
    });
  });
});
