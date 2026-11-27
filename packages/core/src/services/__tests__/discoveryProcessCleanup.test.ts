import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunnerInstallation } from '../RunnerInstallation';
import { pathWithFake, patient, removeDir, setEnv } from '../../testing';

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

it('cancels a running discovery command when its owner is disposed', async () => {
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

it('stops an active installation process tree on disposal', async () => {
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

// Windows keeps child_process.exec's shell semantics under its job supervisor
// (ADR-0078). A finite command, so a regression cannot leave a long-lived
// descendant.
it.skipIf(process.platform !== 'win32')('retains the native exec result on Windows', async () => {
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

/**
 * Windows tree cleanup (ADR-0078), through the fake CLI `probe-tree`: a Node
 * script with `.cmd` and `.ps1` shims on PATH, which starts a grandchild and
 * writes both PIDs. Every process here ends on its own within LIFETIME, so a
 * cleanup that fails leaves nothing running for long, and no test kills by PID.
 * A PID is only asked whether it is alive. A bystander node.exe the probe did
 * not start must outlive every cleanup.
 *
 * #243's repro under the plain `exec` this replaced (Windows 11 Pro
 * 10.0.26300, Node 22.17.1): timeout 2000 with windowsHide, a Node script that
 * starts a 30 s grandchild. killed: true, signal SIGTERM, callback after about
 * 2015 ms, and both the script and the grandchild still running. A `.cmd` shim
 * between cmd.exe and node gave the same result. Every cleanup case below failed there.
 */
describe.skipIf(process.platform !== 'win32')('Windows discovery process cleanup', () => {
  const LIFETIME = 20_000;
  const TREE = `
const { spawn } = require('child_process'); const fs = require('fs');
const [mode, pidfile] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${LIFETIME})'], mode === 'leave' ? { stdio: 'ignore', detached: true } : { stdio: 'ignore' });
fs.writeFileSync(pidfile, JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));
if (mode === 'flood') process.stdout.write('x'.repeat(4096));
if (mode === 'leave') { grandchild.unref(); process.stdout.write('answer'); } else setTimeout(() => {}, ${LIFETIME});
`;
  let dir = '';
  let bin = '';
  let pidfile = '';
  let bystander: ChildProcess | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-win-'));
    bin = join(dir, 'bin'); mkdirSync(bin);
    pidfile = join(dir, 'pids.json');
    const script = join(bin, 'probe-tree.js');
    writeFileSync(script, TREE);
    writeFileSync(join(bin, 'probe-tree.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    writeFileSync(join(bin, 'probe-tree.ps1'), `& "${process.execPath}" "${script}" @args\r\nexit $LASTEXITCODE\r\n`);
    bystander = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${LIFETIME})`], { stdio: 'ignore' });
  });
  afterEach(async () => { bystander?.kill(); await removeDir(dir); });

  const env = () => ({ ...process.env, PATH: pathWithFake(bin, 'probe-tree') });
  const pids = async (): Promise<{ self: number; grandchild: number }> => {
    await vi.waitFor(() => expect(existsSync(pidfile)).toBe(true));
    return JSON.parse(readFileSync(pidfile, 'utf8'));
  };
  const expectTreeEnded = async (tree: { self: number; grandchild: number }) => {
    await vi.waitFor(() => { expect(alive(tree.self)).toBe(false); expect(alive(tree.grandchild)).toBe(false); });
    expect(alive(bystander?.pid ?? 0)).toBe(true);
  };

  it.each([
    ['a .cmd shim', () => `probe-tree hold "${pidfile}"`],
    ['node itself', () => `"${process.execPath}" "${join(bin, 'probe-tree.js')}" hold "${pidfile}"`],
  ])('ends a timed-out probe and its descendants, through %s', async (_route, command) => {
    const { discoveryExec } = await import('../discoveryExec');
    await expect(discoveryExec(command(), { env: env(), timeout: 6000 })).rejects.toMatchObject({ killed: true });
    await expectTreeEnded(await pids());
  }, patient(20_000));

  it('ends a cancelled probe and its descendants', async () => {
    const { discoveryExec } = await import('../discoveryExec');
    const abort = new AbortController();
    const result = discoveryExec(`probe-tree hold "${pidfile}"`, { env: env(), timeout: 60_000, signal: abort.signal });
    const tree = await pids();
    abort.abort();
    await expect(result).rejects.toThrow(/cancelled/i);
    await expectTreeEnded(tree);
  }, patient(20_000));

  it('ends a probe whose output overflows, and its descendants', async () => {
    const { discoveryExec } = await import('../discoveryExec');
    await expect(discoveryExec(`probe-tree flood "${pidfile}"`, { env: env(), timeout: 60_000, maxBuffer: 1024 })).rejects.toThrow(/maxBuffer/i);
    await expectTreeEnded(await pids());
  }, patient(20_000));

  it('answers a probe that exits early, and ends the detached child it left behind', async () => {
    const { discoveryExec } = await import('../discoveryExec');
    await expect(discoveryExec(`probe-tree leave "${pidfile}"`, { env: env(), timeout: 60_000 })).resolves.toEqual({ stdout: 'answer' });
    await expectTreeEnded(await pids());
  }, patient(20_000));

  it.each(['exits', 'is terminated'])('ends a running probe tree when its host %s', async (ending) => {
    const { windowsProbeLaunch } = await import('../discoveryExec');
    const launch = windowsProbeLaunch(`probe-tree hold "${pidfile}"`, env());
    const hostScript = join(dir, 'host.js');
    writeFileSync(hostScript, `const { spawn } = require('child_process'); const launch = JSON.parse(process.env.LAUNCH);
spawn(launch.file, launch.args, { env: launch.env, windowsHide: true, stdio: 'ignore' });
setTimeout(() => {}, ${LIFETIME}); process.on('message', () => process.exit(0));`);
    const host = spawn(process.execPath, [hostScript], { env: { ...process.env, LAUNCH: JSON.stringify(launch) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const tree = await pids();
      if (ending === 'exits') host.send('exit'); else host.kill();
      await expectTreeEnded(tree);
    } finally { host.kill(); }
  }, patient(20_000));

  it('hands the command the environment exec would', async () => {
    const { discoveryExec } = await import('../discoveryExec');
    const command = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`;
    for (const given of [process.env, Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))]) {
      const native = JSON.parse(String((await promisify(exec)(command, { env: given })).stdout));
      const supervised = JSON.parse((await discoveryExec(command, { env: given })).stdout);
      expect(supervised).toEqual(native);
    }
  }, patient(20_000));

  it('fails, and runs nothing, when the job cannot be set up', async () => {
    const { discoveryExec } = await import('../discoveryExec');
    const ran = join(dir, 'ran');
    const restore = setEnv({ SystemRoot: join(dir, 'no-windows') });
    try {
      await expect(discoveryExec(`"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], '')" "${ran}"`, { env: process.env, timeout: 10_000 }))
        .rejects.toThrow(/discovery cleanup could not be set up/);
    } finally { restore(); }
    expect(existsSync(ran)).toBe(false);
  });
});
