import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunnerInstallation } from '../RunnerInstallation';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
describe.skipIf(process.platform === 'win32')('discovery process cleanup', () => {
  it('terminates descendants when an installation probe times out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-tree-'));
    const file = join(dir, 'probe'); const pidfile = join(dir, 'pid');
    writeFileSync(file, `#!${process.execPath}\nconst {spawn}=require('child_process'); const fs=require('fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(pidfile)},String(c.pid)); setInterval(()=>{},1000);\n`, { mode: 0o755 });
    let pid = 0;
    try {
      const registry = { getManifest: () => ({ runner: { command: file } }) } as never;
      const result = await new RunnerInstallation(registry).isInstalled('fake');
      expect(existsSync(pidfile)).toBe(true);
      pid = Number(readFileSync(pidfile, 'utf8'));
      expect(result).toBe(false);
      for (let i = 0; i < 50 && alive(pid); i++) await new Promise(r => setTimeout(r, 20));
      expect(alive(pid)).toBe(false);
    } finally { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});

it('marks a timed-out command as killed so discovery can retry', async () => {
  const { discoveryExec } = await import('../discoveryExec');
  await expect(discoveryExec(`"${process.execPath}" -e "setTimeout(()=>{},1200)"`, { env: process.env, timeout: 200 })).rejects.toMatchObject({ killed: true });
});

it.skipIf(process.platform === 'win32')('cancels a running discovery command when its owner is disposed', async () => {
  const { discoveryExec } = await import('../discoveryExec');
  const abort = new AbortController();
  const result = discoveryExec(`"${process.execPath}" -e "setInterval(()=>{},1000)"`, { env: process.env, timeout: 5000, signal: abort.signal });
  abort.abort();
  await expect(result).rejects.toThrow(/cancelled|abort/i);
});

it('preserves command output and nonzero exit details', async () => {
  const { discoveryExec } = await import('../discoveryExec');
  const command = `"${process.execPath}" -e "process.stdout.write('answer'); process.stderr.write('problem'); process.exit(7)"`;
  await expect(discoveryExec(command, { env: process.env })).rejects.toMatchObject({ code: 7, stdout: 'answer', stderr: 'problem', killed: false });
});

it.skipIf(process.platform === 'win32')('stops an active installation process tree on disposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-dispose-'));
  const file = join(dir, 'probe.js'); const pidfile = join(dir, 'pid');
  writeFileSync(file, `const {spawn}=require('child_process'); const fs=require('fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(pidfile)},String(c.pid)); setInterval(()=>{},1000);`);
  const registry = { getManifest: () => ({ runner: { command: `"${process.execPath}" "${file}"` } }) } as never;
  const service = new RunnerInstallation(registry);
  let pid = 0;
  try {
    const result = service.isInstalled('fake');
    for (let i = 0; i < 200 && !existsSync(pidfile); i++) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(pidfile)).toBe(true);
    pid = Number(readFileSync(pidfile, 'utf8'));
    service.dispose();
    expect(await result).toBe(false);
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise(r => setTimeout(r, 20));
    expect(alive(pid)).toBe(false);
  } finally { service.dispose(); if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
}, 10000);

it.skipIf(process.platform === 'win32')('does not signal a recycled group after its leader exits', async () => {
  const { discoveryExec } = await import('../discoveryExec');
  const dir = mkdtempSync(join(tmpdir(), 'probe-exited-'));
  const script = join(dir, 'probe.js'); const pidfile = join(dir, 'pid');
  writeFileSync(script, `const {spawn}=require('child_process'); const fs=require('fs'); const c=spawn(process.execPath,['-e',"setInterval(()=>process.stdout.write('.'),100)"],{stdio:'inherit'}); fs.writeFileSync(${JSON.stringify(pidfile)},String(c.pid)); c.unref();`);
  let pid = 0;
  try {
    await expect(discoveryExec(`exec "${process.execPath}" "${script}"`, { env: process.env, timeout: 700 })).rejects.toMatchObject({ killed: true });
    pid = Number(readFileSync(pidfile, 'utf8'));
    await new Promise(r => setTimeout(r, 300));
    expect(alive(pid)).toBe(true);
  } finally { if (pid && alive(pid)) process.kill(pid, 'SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
}, 5000);

// Windows deliberately keeps child_process.exec's shell semantics; it has no
// safe job-object-backed tree cleanup yet. Use a finite command so this test
// cannot leave a long-lived descendant when the shell is stopped.
it.skipIf(process.platform !== 'win32')('retains the native exec result on Windows', async () => {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const { discoveryExec } = await import('../discoveryExec');
  const command = `"${process.execPath}" -e "process.stdout.write('answer'); process.stderr.write('problem'); process.exit(7)"`;
  const native = await promisify(exec)(command, { env: process.env }).catch(error => error);
  const result = await discoveryExec(command, { env: process.env }).catch(error => error);
  expect(result).toMatchObject({ code: native.code, stdout: native.stdout, stderr: native.stderr, killed: native.killed, signal: native.signal });
});

it('returns stdout from a successful probe', async () => {
  const { discoveryExec } = await import('../discoveryExec');
  await expect(discoveryExec(`"${process.execPath}" -e "process.stdout.write('model-one\\n')"`, { env: process.env })).resolves.toEqual({ stdout: 'model-one\n' });
});

it('bounds stderr as well as stdout', async () => {
  const { discoveryExec } = await import('../discoveryExec');
  const command = `"${process.execPath}" -e "process.stderr.write('x'.repeat(2048))"`;
  await expect(discoveryExec(command, { env: process.env, maxBuffer: 1024, timeout: 5000 })).rejects.toThrow(/maxBuffer/i);
});
