import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { Socket } from 'net';

const activeProbes = new Set<() => void>();
const stopOnExit = () => { for (const stop of activeProbes) stop(); };
function watchProbe(stop: () => void): void {
  if (activeProbes.size === 0) process.once('exit', stopOnExit);
  activeProbes.add(stop);
}
function unwatchProbe(stop: () => void): void {
  activeProbes.delete(stop);
  if (activeProbes.size === 0) process.removeListener('exit', stopOnExit);
}

/**
 * The supervisor a Windows probe runs under (ADR-0078). It puts itself in a
 * new job that kills every member when its last handle closes, and only then
 * starts the shell, so the shell and everything it starts are members before
 * they can start anything. Only this process holds that handle (not
 * inheritable, unnamed), so its end, by exit or by being terminated, ends the
 * whole tree. P/Invoke through Reflection.Emit: Add-Type would run the C#
 * compiler on every probe. No double quote and no backslash, so the
 * command-line quoting of `-Command` cannot alter it. The armed line on stderr
 * is how the host learns the job holds the supervisor before the command runs.
 */
const WINDOWS_SUPERVISOR = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'OrdewellProbeJob'), 'Run')",
  "  $type = $assembly.DefineDynamicModule('OrdewellProbeJob').DefineType('OrdewellProbeJob.Native', 'Public, Class')",
  '  $import = [Runtime.InteropServices.DllImportAttribute]',
  '  foreach ($signature in @(',
  "    @('CreateJobObjectW', [IntPtr], @([IntPtr], [IntPtr])),",
  "    @('SetInformationJobObject', [bool], @([IntPtr], [int], [IntPtr], [int])),",
  "    @('AssignProcessToJobObject', [bool], @([IntPtr], [IntPtr])),",
  "    @('GetCurrentProcess', [IntPtr], @())",
  '  )) {',
  "    $method = $type.DefineMethod($signature[0], 'Public, Static, PinvokeImpl', $signature[1], [Type[]]$signature[2])",
  "    $method.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($import.GetConstructor([string]), @('kernel32.dll'), [Reflection.FieldInfo[]]@($import.GetField('SetLastError')), [object[]]@($true))))",
  '  }',
  '  $native = $type.CreateType()',
  '  $marshal = [Runtime.InteropServices.Marshal]',
  '  $job = $native::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)',
  "  if ($job -eq [IntPtr]::Zero) { throw ('CreateJobObject failed: ' + $marshal::GetLastWin32Error()) }",
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit, 112 on
  // 32-bit; LimitFlags sits at offset 16 in both. 0x2000 is KILL_ON_JOB_CLOSE,
  // and no BREAKAWAY flag, so no member can start a process outside the job.
  '  $size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }',
  '  $info = $marshal::AllocHGlobal($size)',
  '  for ($i = 0; $i -lt $size; $i++) { $marshal::WriteByte($info, $i, 0) }',
  '  $marshal::WriteInt32($info, 16, 0x2000)',
  "  if (-not $native::SetInformationJobObject($job, 9, $info, $size)) { throw ('SetInformationJobObject failed: ' + $marshal::GetLastWin32Error()) }",
  "  if (-not $native::AssignProcessToJobObject($job, $native::GetCurrentProcess())) { throw ('AssignProcessToJobObject failed: ' + $marshal::GetLastWin32Error()) }",
  '  $start = New-Object Diagnostics.ProcessStartInfo $env:ORDEWELL_PROBE_SHELL, $env:ORDEWELL_PROBE_LINE',
  '  $start.UseShellExecute = $false',
  '  $armed = $env:ORDEWELL_PROBE_ARMED',
  // powershell.exe rewrites PSModulePath and PATHEXT as it starts; the
  // command gets the values exec would have given it. NAME=value, or a bare
  // NAME for one that was unset.
  '  foreach ($entry in $env:ORDEWELL_PROBE_RESTORE.Split([char]10)) {',
  "    $at = $entry.IndexOf('=')",
  '    if ($at -lt 0) { [Environment]::SetEnvironmentVariable($entry, $null) } else { [Environment]::SetEnvironmentVariable($entry.Substring(0, $at), $entry.Substring($at + 1)) }',
  '  }',
  "  foreach ($name in @('ORDEWELL_PROBE_ARMED', 'ORDEWELL_PROBE_SHELL', 'ORDEWELL_PROBE_LINE', 'ORDEWELL_PROBE_RESTORE')) { [Environment]::SetEnvironmentVariable($name, $null) }",
  '  [Console]::Error.Write($armed + [char]10)',
  '  $child = [Diagnostics.Process]::Start($start)',
  '} catch {',
  '  [Console]::Error.Write($_.Exception.Message + [char]10)',
  '  exit 1',
  '}',
  '$child.WaitForExit()',
  'exit $child.ExitCode',
].join('\n');

/** What powershell.exe 5.1 changes in its own environment as it starts, so its children inherit it. */
const POWERSHELL_REWRITES = ['PSModulePath', 'PATHEXT'];

export interface WindowsProbeLaunch { file: string; args: string[]; env: NodeJS.ProcessEnv; armed: string }

/**
 * How a Windows probe is started: the supervisor, with the command line
 * `child_process.exec` would hand cmd.exe. Exported for its test, which starts
 * it from a host it can kill outright.
 */
export function windowsProbeLaunch(command: string, env: NodeJS.ProcessEnv, host: NodeJS.ProcessEnv = process.env): WindowsProbeLaunch {
  const root = host.SystemRoot ?? host.windir;
  if (!root) throw new Error('Windows discovery cleanup could not be set up: SystemRoot is not set');
  // exec's shell: the host's ComSpec. One that is not cmd.exe would take
  // `-c` and other quoting; every probe is written for cmd.exe, so that is
  // what runs it.
  const comspec = host.ComSpec;
  const shell = comspec && /^(?:.*\\)?cmd(?:\.exe)?$/i.test(comspec) ? comspec : path.win32.join(root, 'System32', 'cmd.exe');
  const armed = randomBytes(16).toString('hex');
  const restore = POWERSHELL_REWRITES.map(name => {
    const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    return key === undefined || env[key] === undefined ? name : `${key}=${env[key]}`;
  }).join('\n');
  return {
    file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', WINDOWS_SUPERVISOR],
    env: {
      ...env,
      ORDEWELL_PROBE_ARMED: armed,
      ORDEWELL_PROBE_SHELL: shell,
      ORDEWELL_PROBE_LINE: `/d /s /c "${command}"`,
      ORDEWELL_PROBE_RESTORE: restore,
    },
    armed,
  };
}

/**
 * Run a discovery probe through the shell and end everything it started when
 * it times out, is cancelled, overflows its buffer or outlives its host.
 *
 * POSIX runs it in its own process group. Descendants that leave the group or
 * outlive its leader may survive: a recycled group ID cannot be signalled
 * safely. The exit hook runs on normal process exit, not SIGKILL.
 *
 * Windows runs it under a supervisor in a kill-on-close job (ADR-0078):
 * terminating the supervisor through the handle libuv holds ends every
 * process the probe started, a `.cmd` shim's included, and so does the
 * supervisor's own exit once the shell is done, so a probe that answers and
 * leaves a child behind loses that child. Nothing is ever killed by PID or
 * name. If the job cannot be set up the probe fails, and the command never runs.
 */
export function discoveryExec(command: string, options: { timeout?: number; env: NodeJS.ProcessEnv; maxBuffer?: number; signal?: AbortSignal }): Promise<{ stdout: string }> {
  if (options.signal?.aborted) return Promise.reject(new Error('Discovery cancelled'));
  let launch: WindowsProbeLaunch | undefined;
  if (process.platform === 'win32') {
    try { launch = windowsProbeLaunch(command, options.env); } catch (error) { return Promise.reject(error); }
  }
  const limit = options.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    // Until the supervisor says the job holds it, stderr is the supervisor's.
    const armedLine = launch ? `${launch.armed}\n` : '';
    let armed = !launch;
    let setup = '';
    const child = launch
      ? spawn(launch.file, launch.args, { env: launch.env, windowsHide: true })
      : spawn(command, { shell: true, env: options.env, detached: true, windowsHide: true });
    const overflow = () => {
      killTree(); finish(); releasePipes();
      if (!settled) { settled = true; reject(new Error('Discovery output exceeded maxBuffer')); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
      if (Buffer.byteLength(stdout) > limit) overflow();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data: string) => {
      if (!armed) {
        setup += data;
        if (!setup.startsWith(armedLine)) return;
        armed = true;
        data = setup.slice(armedLine.length);
      }
      stderr += data;
      if (Buffer.byteLength(stderr) > limit) overflow();
    });
    child.on('error', error => {
      finish();
      if (settled) return;
      settled = true;
      reject(launch ? new Error(`Windows discovery cleanup could not be set up: ${error.message}`) : error);
    });
    child.on('close', (code, signal) => {
      finish();
      if (settled) return;
      settled = true;
      if (!armed) reject(new Error(`Windows discovery cleanup could not be set up${setup.trim() ? `: ${setup.trim()}` : ''}`));
      else if (code !== 0) reject(Object.assign(new Error(`Discovery command exited with ${code}`), { code, signal, killed: false, stdout, stderr }));
      else resolve({ stdout });
    });
    const killTree = () => {
      if (!child.pid) return;
      try {
        // After exit the leader's ID can be reused, even while a detached
        // descendant holds a pipe. Bound the wait but never signal that ID.
        if (child.exitCode !== null || child.signalCode !== null) return;
        // Windows: TerminateProcess on the supervisor's handle; its job's
        // close ends the rest (ADR-0078).
        if (launch) child.kill(); else process.kill(-child.pid, 'SIGKILL');
      } catch { /* Already exited. */ }
    };
    const releasePipes = () => {
      for (const stream of [child.stdout, child.stderr]) {
        stream.removeAllListeners('data');
        stream.resume();
        if (stream instanceof Socket) stream.unref();
      }
      child.stdin.destroy();
    };
    const cancel = () => { if (settled) return; settled = true; killTree(); finish(); releasePipes(); reject(new Error('Discovery cancelled')); };
    const finish = () => { if (timer) clearTimeout(timer); unwatchProbe(killTree); options.signal?.removeEventListener('abort', cancel); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    watchProbe(killTree);
    if (options.timeout) timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      finish();
      releasePipes();
      reject(Object.assign(new Error(`Discovery command timed out after ${options.timeout}ms`), { killed: true, signal: launch ? 'SIGTERM' : 'SIGKILL' }));
    }, options.timeout);
  });
}
