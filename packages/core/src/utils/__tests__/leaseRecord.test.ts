import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LeaseHost } from '../../services/sessionLease';
import { readLiveHolder } from '../../daemon-client';

const SESSION = 'session-held';

// What a client that is no host reads of a session's holder (ADR-0060): the
// desktop app's main process, deciding whether there is a daemon to join.
describe('readLiveHolder', () => {
  let workspace: string;
  const hosts: LeaseHost[] = [];

  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-holder-')); });
  afterEach(() => {
    for (const host of hosts.splice(0)) host.releaseAll();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function holdBy(options: ConstructorParameters<typeof LeaseHost>[0]): LeaseHost {
    const host = new LeaseHost({ runnerGroups: () => [], ...options });
    hosts.push(host);
    host.lease(() => undefined).claim(SESSION, workspace);
    return host;
  }

  it('names the daemon that holds the session, as the holder wrote it', () => {
    holdBy({ pid: process.pid, kind: () => ({ kind: 'daemon', port: 49213, ownerPid: 48120 }) });

    const holder = readLiveHolder(SESSION, workspace);

    expect(holder?.host).toEqual({ kind: 'daemon', port: 49213, ownerPid: 48120 });
    expect(holder?.pid).toBe(process.pid);
  });

  it('is null when no host holds the session', () => {
    expect(readLiveHolder(SESSION, workspace)).toBeNull();
  });

  it('is null once the holder has stopped refreshing its lease', () => {
    const start = Date.parse('2026-11-04T10:00:00.000Z');
    holdBy({ pid: process.pid, now: () => start, kind: () => ({ kind: 'daemon', port: 49213 }) });

    expect(readLiveHolder(SESSION, workspace, { now: () => start + 61_000 })).toBeNull();
  });

  it('is null when the holder\'s process is gone', () => {
    holdBy({ pid: 999_999_991, kind: () => ({ kind: 'daemon', port: 49213 }) });

    expect(readLiveHolder(SESSION, workspace, { alive: () => false })).toBeNull();
  });
});
