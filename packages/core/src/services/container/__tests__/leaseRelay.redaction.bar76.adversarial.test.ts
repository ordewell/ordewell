import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { describe, expect, it } from 'vitest';
import { LeaseRelay } from '../leaseRelay';
import { fakeSecret } from '../../__tests__/fakeSecret';

/**
 * Task #76: a lease container's entry that ends before it starts leaves its
 * stderr tail in the start error (leaseRelay.ts:128, 255), which reaches the
 * task's error, its events and the planner (dockerLease.ts:303). Bar (b): a
 * provider key or a value under a credential name is never shown there.
 * A fake child process, so the test opens no socket. Every value here is fake.
 */
function fakeEntry() {
  const entry = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
  entry.stdin = new PassThrough();
  entry.stdout = new PassThrough();
  entry.stderr = new PassThrough();
  return entry;
}

const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

async function startErrorAfter(stderr: string): Promise<string> {
  const entry = fakeEntry();
  const relay = new LeaseRelay(entry as unknown as ChildProcess);
  entry.stderr.write(stderr);
  await new Promise((resolve) => setImmediate(resolve));
  entry.emit('close', 1, null);
  const err = await relay.ready.then(() => null, (e: Error) => e);
  expect(err?.message).toContain("The container's entry ended");
  return err?.message ?? '';
}

describe("bar (b): a lease container entry's stderr tail in its start error", () => {
  it('keeps a provider key out', async () => {
    const key = fakeSecret('openai');
    const message = await startErrorAfter(`docker: error during connect: OPENAI_API_KEY=${key}\n`);
    expect(shows(message, key), message).toBe(false);
  });

  it('keeps a value under a credential name out', async () => {
    const value = 'qwertyuiopasdfghjklzxcvbnmfake';
    const message = await startErrorAfter(`node: bad option\nGITHUB_TOKEN="${value}"\n`);
    expect(shows(message, value), message).toBe(false);
  });

  it('keeps a private key out', async () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FAKEFAKEFAKE';
    const message = await startErrorAfter(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`);
    expect(shows(message, body), message).toBe(false);
  });
});
