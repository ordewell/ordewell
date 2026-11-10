import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markerRead, runCommandStub, staleCore } from './acp-subagent-probe-lib.mjs';

const STUB = 'The probe records this call and does nothing else.';

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe-test-'));
  fs.mkdirSync(path.join(dir, 'notes'));
  const marker = path.join(dir, 'notes', 'marker.txt');
  fs.writeFileSync(marker, 'PLANNER-SAW-abc\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  return { dir, marker, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a plain read of the marker is answered with its content', () => {
  const w = workspace();
  try {
    for (const command of ['cat notes/marker.txt', 'head -n 1 notes/marker.txt', `cat "${w.marker}"`, "cat 'notes/marker.txt'", 'cat ./notes/../notes/marker.txt']) {
      assert.equal(runCommandStub({ command }, w.dir, w.marker), 'PLANNER-SAW-abc\n', command);
    }
  } finally { w.done(); }
});

test('every other command keeps the stub', () => {
  const w = workspace();
  try {
    for (const command of [
      'cat README.md', 'cat notes/missing.txt', 'echo hi', 'cat notes/marker.txt > x', 'cat notes/marker.txt | sh',
      'cat notes/marker.txt; touch x', 'cat $(echo notes/marker.txt)', 'rm notes/marker.txt', '', undefined,
    ]) {
      assert.equal(runCommandStub({ command }, w.dir, w.marker), STUB, String(command));
    }
    assert.equal(runCommandStub(undefined, w.dir, w.marker), STUB);
  } finally { w.done(); }
});

test('a read of another workspace file is not answered', () => {
  const w = workspace();
  try {
    fs.writeFileSync(path.join(w.dir, 'other.txt'), 'secret');
    assert.equal(markerRead('cat other.txt', w.dir, w.marker), null);
  } finally { w.done(); }
});

function core() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-probe-core-'));
  const src = path.join(dir, 'src', 'services');
  fs.mkdirSync(src, { recursive: true });
  const dist = path.join(dir, 'dist-index.mjs');
  fs.writeFileSync(path.join(src, 'a.ts'), 'x');
  fs.writeFileSync(dist, 'x');
  return { dir, src: path.join(dir, 'src'), dist, file: path.join(src, 'a.ts'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a build newer than every source is fresh', () => {
  const c = core();
  try {
    const t = new Date();
    fs.utimesSync(c.file, new Date(t - 5000), new Date(t - 5000));
    assert.equal(staleCore(c.dist, c.src), null);
  } finally { c.done(); }
});

test('a build older than a source is stale and names the source', () => {
  const c = core();
  try {
    const t = new Date();
    fs.utimesSync(c.dist, new Date(t - 5000), new Date(t - 5000));
    const why = staleCore(c.dist, c.src);
    assert.match(why, /a\.ts is newer than the build/);
  } finally { c.done(); }
});

test('a missing build is stale', () => {
  const c = core();
  try {
    assert.match(staleCore(path.join(c.dir, 'nope.mjs'), c.src), /is missing/);
  } finally { c.done(); }
});
