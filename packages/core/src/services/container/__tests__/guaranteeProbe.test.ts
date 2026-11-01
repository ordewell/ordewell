import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { judgeProbe, PROBE_SCRIPT, type ProbeExpected, type ProbeFindings } from '../guaranteeProbe';

const expected: ProbeExpected = { mounts: ['/task', '/mirror', '/tmp'], memoryBytes: 1024, pids: 8192, hostKernel: 'Darwin 25.4.0' };

/** A container as a Docker lease leaves it: every guarantee this lease can prove, proven. */
const clean: ProbeFindings = {
  hostPathsFound: [],
  mounts: [{ point: '/', type: 'overlay' }, { point: '/proc', type: 'proc' }, { point: '/etc/hosts', type: 'ext4' }, { point: '/task', type: 'ext4' }, { point: '/mirror', type: 'ext4' }, { point: '/tmp', type: 'tmpfs' }],
  dockerSocket: false,
  writesPassed: [],
  workspaceWritable: true,
  kernel: 'Linux 6.8.0',
  memoryMax: '1024',
  swapMax: '0',
  pidsMax: '8192',
  metadata: 'ECONNREFUSED',
  gateway: 'ECONNREFUSED',
  credentialsVisible: [],
  loginReadable: false,
};

const judge = (over: Partial<ProbeFindings>) => judgeProbe({ ...clean, ...over }, expected, '2026-11-01T00:00:00.000Z');

describe('what a probe proves (ADR-0059 L3)', () => {
  it('proves what the findings show, and how and when', () => {
    const report = judge({});
    expect(report['fs.hostHidden']).toMatchObject({ proven: true, at: '2026-11-01T00:00:00.000Z' });
    expect(report['fs.writeScope'].proven).toBe(true);
    expect(report['limits.memory'].proven).toBe(true);
    expect(report['kernel.separate'].proven).toBe(true);
    expect(report['net.noMetadata'].proven).toBe(true);
    expect(report['cred.unreadable'].proven).toBe(true);
  });

  it.each<[string, Partial<ProbeFindings>, RegExp]>([
    ['a canary of the host that can be read', { hostPathsFound: ['/Users/me/canary'] }, /canary/],
    ['a folder of the host through a shared filesystem', { mounts: [{ point: '/task', type: 'virtiofs' }] }, /virtiofs/],
    ['a mount the lease never asked for', { mounts: [{ point: '/Users', type: 'ext4' }] }, /\/Users/],
    ['the Docker socket', { dockerSocket: true }, /socket/],
  ])('does not prove the host hidden with %s', (_case, over, why) => {
    expect(judge(over)['fs.hostHidden']).toMatchObject({ proven: false, by: expect.stringMatching(why) });
  });

  it('does not prove the write scope when a write got past it', () => {
    expect(judge({ writesPassed: ['/mirror'] })['fs.writeScope']).toMatchObject({ proven: false, by: expect.stringContaining('/mirror') });
  });

  it('does not prove the write scope when the workspace takes no write', () => {
    expect(judge({ workspaceWritable: false })['fs.writeScope'].proven).toBe(false);
  });

  it.each<[string, Partial<ProbeFindings>]>([
    ['a higher memory limit', { memoryMax: '2048' }],
    ['no memory limit', { memoryMax: 'max' }],
    ['swap past the limit', { swapMax: '1024' }],
    ['a cgroup it cannot read', { memoryMax: null }],
    ['a different process limit', { pidsMax: 'max' }],
  ])('does not prove the limits with %s', (_case, over) => {
    expect(judge(over)['limits.memory'].proven).toBe(false);
  });

  it('never proves the allowlist: this lease has none, and says so', () => {
    expect(judge({})['net.allowlist']).toMatchObject({ proven: false, by: expect.stringContaining('egress sidecar') });
    expect(judge({ gateway: 'timed out' })['net.allowlist'].proven).toBe(false);
  });

  it('does not prove the metadata service out of reach once one answers', () => {
    expect(judge({ metadata: 'connected' })['net.noMetadata'].proven).toBe(false);
  });

  it('does not prove a credential unreadable while the runner can read it', () => {
    expect(judge({ credentialsVisible: ['ANTHROPIC_API_KEY'] })['cred.unreadable']).toMatchObject({ proven: false, by: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(judge({ loginReadable: true })['cred.unreadable'].proven).toBe(false);
  });

  it("does not prove a separate kernel on one the host shares", () => {
    expect(judge({ kernel: 'Darwin 25.4.0' })['kernel.separate'].proven).toBe(false);
  });
});

describe('the probe script', () => {
  it('says what it finds as JSON, on any machine with node', () => {
    const run = spawnSync(process.execPath, ['-e', PROBE_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ORDEWELL_PROBE: JSON.stringify({ hostPaths: ['/definitely/not/here', process.execPath], deniedWrites: ['/definitely/not/here'], workspace: '/definitely/not/here', credentials: ['ORDEWELL_TEST_SET', 'ORDEWELL_TEST_UNSET'], login: process.execPath }), ORDEWELL_TEST_SET: '1' },
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ hostPathsFound: [process.execPath], writesPassed: [], workspaceWritable: false, credentialsVisible: ['ORDEWELL_TEST_SET'], loginReadable: true });
  });
});
