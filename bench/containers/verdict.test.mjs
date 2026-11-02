import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyEngine, describeVerdict, tally, verdict, withOpenCode } from './verdict.mjs';

const file = (name, tests, extra = {}) => ({
  name: `/repo/packages/core/src/services/container/__tests__/${name}`,
  status: tests.some(([, status]) => status === 'failed') ? 'failed' : 'passed',
  assertionResults: tests.map(([fullName, status]) => ({ fullName, title: fullName, status })),
  ...extra,
});

const engine = { kind: 'colima', os: 'Ubuntu 24.04', arch: 'aarch64', kernel: '6.8.0', cgroup: '2', server: '29.5.2', context: 'colima' };

const PROOFS = [
  { harness: 'claude-code', file: 'lease.e2e.test.ts', test: /real harness/ },
  { harness: 'codex', file: 'codex.e2e.test.ts', test: /real Codex/ },
  { harness: 'opencode', file: 'lease.e2e.test.ts', test: /real OpenCode/ },
];

const SUITES = ['lease.e2e.test.ts', 'codex.e2e.test.ts', 'gate.e2e.test.ts'];

/** A run vitest was content with, as its JSON report says so. */
const ran = (...testResults) => tally({ success: true, testResults });

const everyProof = () => ran(
  file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['a real OpenCode task', 'passed']]),
  file('codex.e2e.test.ts', [['two real Codex tasks', 'passed']]),
  file('gate.e2e.test.ts', [['takes the ref alone', 'passed']]),
);

/** The verdict of a run vitest ended cleanly, unless a test says otherwise. */
const judged = (counts, over = {}) => verdict({ engine, counts, proofs: PROOFS, suites: SUITES, vitestStatus: 0, ...over });

describe('what a run of the suites adds up to', () => {
  it('counts a skipped test apart from a passed one, whatever vitest calls it', () => {
    const counts = tally({
      testResults: [file('a.e2e.test.ts', [['ran', 'passed'], ['bad', 'failed'], ['skip', 'skipped'], ['pending', 'pending'], ['todo', 'todo'], ['off', 'disabled']])],
    });
    assert.equal(counts.passed.length, 1);
    assert.deepEqual(counts.failed.map((t) => t.name), ['bad']);
    assert.deepEqual(counts.skipped.map((t) => t.name), ['skip', 'pending', 'todo', 'off']);
  });

  it('counts a file that never loaded as a failure, though it holds no failed test', () => {
    const counts = tally({
      testResults: [{ name: '/repo/broken.e2e.test.ts', status: 'failed', message: 'Cannot find module', assertionResults: [] }],
    });
    assert.equal(counts.failed.length, 1);
    assert.match(counts.failed[0].name, /broken\.e2e\.test\.ts/);
    assert.match(counts.failed[0].name, /Cannot find module/);
  });
});

describe('the verdict of a run', () => {
  it('passes only with every proof passed, and nothing failed or skipped', () => {
    const result = judged(everyProof());
    assert.equal(result.outcome, 'verified');
    assert.equal(result.exitCode, 0);
  });

  it('does not verify a run that left a suite out, and names it', () => {
    const counts = ran(
      file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['a real OpenCode task', 'passed']]),
      file('codex.e2e.test.ts', [['two real Codex tasks', 'passed']]),
    );
    const result = judged(counts);
    assert.equal(result.outcome, 'unverified');
    assert.notEqual(result.exitCode, 0);
    assert.match(describeVerdict(result).join('\n'), /gate\.e2e\.test\.ts/);
  });

  it('does not count a suite all of whose tests were skipped as one that ran', () => {
    const counts = ran(
      file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['a real OpenCode task', 'passed']]),
      file('codex.e2e.test.ts', [['two real Codex tasks', 'passed']]),
      file('gate.e2e.test.ts', [['takes the ref alone', 'skipped']]),
    );
    assert.deepEqual(judged(counts).missing, ['gate.e2e.test.ts']);
  });

  it('never verifies a report that does not say it succeeded, though every test in it passed', () => {
    const [lease, codex, gate] = [
      file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['a real OpenCode task', 'passed']]),
      file('codex.e2e.test.ts', [['two real Codex tasks', 'passed']]),
      file('gate.e2e.test.ts', [['takes the ref alone', 'passed']]),
    ];
    for (const report of [{ success: false }, {}]) {
      const result = judged(tally({ ...report, testResults: [lease, codex, gate] }));
      assert.equal(result.outcome, 'failed');
      assert.notEqual(result.exitCode, 0);
    }
  });

  it('never verifies a run vitest did not end cleanly, whatever its report says', () => {
    for (const vitestStatus of [1, null, undefined]) {
      const result = judged(everyProof(), { vitestStatus });
      assert.equal(result.outcome, 'failed');
      assert.notEqual(result.exitCode, 0);
    }
  });

  it('says why a run with no failed test failed', () => {
    const text = describeVerdict(judged(everyProof(), { vitestStatus: 1 })).join('\n');
    assert.match(text, /vitest/i);
    assert.match(text, /status 1/);
  });

  it('reads no engine as unverified and fails the run: nothing ran, so nothing passed', () => {
    const result = verdict({ engine: null, counts: null, proofs: PROOFS, reason: 'docker info: cannot connect' });
    assert.equal(result.outcome, 'unverified');
    assert.notEqual(result.exitCode, 0);
    assert.match(describeVerdict(result).join('\n'), /cannot connect/);
  });

  it('reads a skip as unverified, however much else passed, and names it', () => {
    const counts = ran(
      file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['a real OpenCode task', 'passed'], ['opens a listed host', 'skipped']]),
      file('codex.e2e.test.ts', [['two real Codex tasks', 'passed']]),
      file('gate.e2e.test.ts', [['takes the ref alone', 'passed']]),
    );
    const result = judged(counts);
    assert.equal(result.outcome, 'unverified');
    assert.notEqual(result.exitCode, 0);
    assert.match(describeVerdict(result).join('\n'), /opens a listed host/);
  });

  it('reads a failure as failed, ahead of any skip', () => {
    const result = judged(ran(file('lease.e2e.test.ts', [['ok', 'passed'], ['bad', 'failed'], ['off', 'skipped']])));
    assert.equal(result.outcome, 'failed');
    assert.notEqual(result.exitCode, 0);
  });

  it('holds a harness to its own proof, so a renamed test cannot pass it unseen', () => {
    const counts = ran(
      file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['some OpenCode task', 'passed']]),
      file('codex.e2e.test.ts', [['two real Codex tasks', 'passed']]),
      file('gate.e2e.test.ts', [['takes the ref alone', 'passed']]),
    );
    const result = judged(counts);
    assert.equal(result.outcome, 'unverified');
    assert.deepEqual(result.harnesses, { 'claude-code': 'verified', codex: 'verified', opencode: 'unverified' });
  });

  it('does not read a proof from a like-named test in another file', () => {
    const counts = ran(
      file('lease.e2e.test.ts', [['the real harness takes a turn', 'passed'], ['a real OpenCode task', 'passed']]),
      file('other.e2e.test.ts', [['two real Codex tasks', 'passed']]),
    );
    assert.equal(judged(counts).harnesses.codex, 'unverified');
  });

  it('names what this run cannot speak for, even when everything it ran passed', () => {
    const text = describeVerdict(judged(everyProof())).join('\n');
    assert.match(text, /Docker Desktop/);
    assert.match(text, /native Linux/);
    assert.match(text, /Windows/);
    assert.match(text, /live provider/i);
    assert.doesNotMatch(text.split('Not verified')[1] ?? '', /Colima/);
  });

  it('counts a run on Docker Desktop for Docker Desktop, and leaves Colima unverified', () => {
    const text = describeVerdict(judged(everyProof(), { engine: { ...engine, kind: 'docker-desktop' } })).join('\n');
    assert.match(text.split('Not verified')[1], /Colima/);
    assert.doesNotMatch(text.split('Not verified')[1], /Docker Desktop/);
  });
});

describe('the image the check builds', () => {
  it('turns on the OpenCode line of the Dockerfile a person builds', async () => {
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(new URL('../../packages/core/docker/task.Dockerfile', import.meta.url), 'utf8');
    assert.match(withOpenCode(real), /^RUN npm install -g @opencode\/cli$/m);
  });

  it('stops rather than building an image without OpenCode', () => {
    assert.throws(() => withOpenCode('FROM node:22-slim\n'), /OpenCode/);
  });
});

describe('which engine answered', () => {
  it('knows Colima by its context or name', () => {
    assert.equal(classifyEngine({ context: 'colima', name: 'colima', operatingSystem: 'Ubuntu 24.04.4 LTS', platform: 'darwin' }), 'colima');
    assert.equal(classifyEngine({ context: 'colima-work', name: 'colima-work', operatingSystem: 'Ubuntu 24.04.4 LTS', platform: 'darwin' }), 'colima');
  });

  it('knows Docker Desktop by what it reports as its system, on either host', () => {
    assert.equal(classifyEngine({ context: 'desktop-linux', name: 'docker-desktop', operatingSystem: 'Docker Desktop', platform: 'darwin' }), 'docker-desktop');
    assert.equal(classifyEngine({ context: 'desktop-linux', name: 'docker-desktop', operatingSystem: 'Docker Desktop', platform: 'linux' }), 'docker-desktop');
  });

  it('calls a local engine on a Linux host native, and an unknown one on macOS unknown rather than either', () => {
    assert.equal(classifyEngine({ context: 'default', name: 'runner', operatingSystem: 'Ubuntu 24.04.2 LTS', platform: 'linux', endpoint: 'unix:///var/run/docker.sock' }), 'native-linux');
    assert.equal(classifyEngine({ context: 'default', name: 'orb', operatingSystem: 'OrbStack', platform: 'darwin', endpoint: 'unix:///var/run/docker.sock' }), 'other');
  });

  it('does not call an engine native when a Linux host cannot say it is local', () => {
    for (const endpoint of ['tcp://build-box.example:2376', 'ssh://me@build-box.example', '', undefined]) {
      assert.equal(classifyEngine({ context: 'remote', name: 'build-box', operatingSystem: 'Ubuntu 24.04.2 LTS', platform: 'linux', endpoint }), 'other');
    }
  });
});
