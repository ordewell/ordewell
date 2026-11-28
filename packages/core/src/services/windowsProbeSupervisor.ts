import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { connect, type Socket } from 'net';
import * as path from 'path';

/**
 * The supervisor every Windows discovery probe of this host runs under
 * (ADR-0078): one Windows PowerShell process, started on the first probe and
 * reused by the next. For each probe it creates an unnamed kill-on-close job,
 * starts the shell suspended, assigns it to that job and only then lets it
 * run, so the shell and everything it starts are members before they can
 * start anything. It holds every job's only handle, so closing one, or its own
 * end, terminates that probe's whole tree. Nothing is found by PID or name.
 *
 * The host talks to it over its stdio, one line per message, every free-form
 * field base64. The probe's output never passes through it: it creates a named
 * pipe for stdout and one for stderr, with one instance each and
 * `FILE_FLAG_FIRST_PIPE_INSTANCE`, the host connects to both, and the shell
 * gets their server ends. Its stdin is a pipe of the supervisor's that nothing
 * writes, as `exec` gives, and the handle list lets it inherit those three
 * handles and nothing else.
 *
 *   host → supervisor           supervisor → host
 *   start <id> <out> <err>      ready (once, as it starts)
 *   run <id> <app> <line>       listening <id>
 *       <env> <cwd>             started <id>
 *   kill <id>                   failed <id> <message>
 *                               exit <id> <code>
 *
 * P/Invoke through Reflection.Emit: Add-Type would run the C# compiler. No
 * double quote and no backslash, so the command-line quoting of `-Command`
 * cannot alter it.
 */
const SUPERVISOR = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'OrdewellProbeSupervisor'), 'Run')",
  "  $type = $assembly.DefineDynamicModule('OrdewellProbeSupervisor').DefineType('OrdewellProbeSupervisor.Native', 'Public, Class')",
  '  $import = [Runtime.InteropServices.DllImportAttribute]',
  "  $fields = [Reflection.FieldInfo[]]@($import.GetField('SetLastError'), $import.GetField('CharSet'))",
  '  $values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)',
  '  $P = [IntPtr]; $I = [int]',
  '  foreach ($signature in @(',
  "    @('CreateJobObjectW', $P, @($P, $P)),",
  "    @('SetInformationJobObject', [bool], @($P, $I, $P, $I)),",
  "    @('AssignProcessToJobObject', [bool], @($P, $P)),",
  "    @('CreateNamedPipeW', $P, @([string], $I, $I, $I, $I, $I, $I, $P)),",
  "    @('ConnectNamedPipe', [bool], @($P, $P)),",
  "    @('CreatePipe', [bool], @($P, $P, $P, $I)),",
  "    @('InitializeProcThreadAttributeList', [bool], @($P, $I, $I, $P)),",
  "    @('UpdateProcThreadAttribute', [bool], @($P, $I, $P, $P, $P, $P, $P)),",
  "    @('DeleteProcThreadAttributeList', [void], @($P)),",
  "    @('CreateProcessW', [bool], @([string], $P, $P, $P, [bool], $I, $P, [string], $P, $P)),",
  "    @('ResumeThread', $I, @($P)),",
  "    @('GetExitCodeProcess', [bool], @($P, $P)),",
  "    @('TerminateProcess', [bool], @($P, $I)),",
  "    @('CloseHandle', [bool], @($P))",
  '  )) {',
  "    $method = $type.DefineMethod($signature[0], 'Public, Static, PinvokeImpl', $signature[1], [Type[]]$signature[2])",
  "    $method.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($import.GetConstructor([string]), @('kernel32.dll'), $fields, $values)))",
  '  }',
  '  $native = $type.CreateType()',
  '  $marshal = [Runtime.InteropServices.Marshal]',
  '  $p = [IntPtr]::Size',
  // SECURITY_ATTRIBUTES with bInheritHandle: the handle list below still
  // decides which inheritable handles a probe gets.
  '  $inherit = $marshal::AllocHGlobal(3 * $p)',
  '  $marshal::WriteInt32($inherit, 0, 3 * $p); $marshal::WriteIntPtr($inherit, $p, [IntPtr]::Zero); $marshal::WriteInt32($inherit, 2 * $p, 1)',
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit, 112 on
  // 32-bit; LimitFlags sits at offset 16 in both. 0x2000 is KILL_ON_JOB_CLOSE,
  // and no BREAKAWAY flag, so no member can start a process outside the job.
  '  $limitSize = if ($p -eq 8) { 144 } else { 112 }',
  '  $limit = $marshal::AllocHGlobal($limitSize)',
  '  for ($i = 0; $i -lt $limitSize; $i++) { $marshal::WriteByte($limit, $i, 0) }',
  '  $marshal::WriteInt32($limit, 16, 0x2000)',
  // STARTUPINFOEXW: dwFlags, wShowWindow, the three std handles and the
  // attribute list, at their 64-bit and 32-bit offsets.
  '  $si = if ($p -eq 8) { @{ Size = 112; Flags = 60; Show = 64; In = 80; Out = 88; Err = 96; List = 104 } } else { @{ Size = 72; Flags = 44; Show = 48; In = 56; Out = 60; Err = 64; List = 68 } }',
  "  $startup = $marshal::AllocHGlobal($si['Size'])",
  '  $info = $marshal::AllocHGlobal(2 * $p + 8)',
  '  $scratch = $marshal::AllocHGlobal(2 * $p)',
  '  $handles = $marshal::AllocHGlobal(3 * $p)',
  '  $invalid = [IntPtr](-1)',
  // CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT
  // and CREATE_NO_WINDOW: windowsHide's console half; SW_HIDE is its other.
  '  $CREATE_NO_WINDOW = 0x08000000',
  '  $creation = 0x4 -bor 0x400 -bor 0x80000 -bor $CREATE_NO_WINDOW',
  '  $STARTF_USESTDHANDLES = 0x100; $STARTF_USESHOWWINDOW = 0x1',
  '} catch {',
  '  [Console]::Error.Write($_.Exception.Message + [char]10)',
  '  exit 1',
  '}',
  'function Fail($what) { throw ($what + ' + "' failed: '" + ' + $marshal::GetLastWin32Error()) }',
  'function Text($value) { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($value)) }',
  'function Say($line) { [Console]::Out.Write($line + [char]10) }',
  '$probes = @{}',
  'function Stop-Probe($id) {',
  '  $probe = $probes[$id]',
  '  if ($null -eq $probe) { return }',
  '  $probes.Remove($id)',
  // The job first: closing its only handle terminates every member.
  "  foreach ($name in @('Job', 'Out', 'Err', 'InRead', 'InWrite', 'Process')) { if ($probe[$name] -ne [IntPtr]::Zero) { [void]$native::CloseHandle($probe[$name]); $probe[$name] = [IntPtr]::Zero } }",
  "  if ($probe['Wait']) { $probe['Wait'].Dispose() }",
  '}',
  'function Start-Probe($id, $out, $err) {',
  '  $probe = @{ Job = [IntPtr]::Zero; Out = [IntPtr]::Zero; Err = [IntPtr]::Zero; InRead = [IntPtr]::Zero; InWrite = [IntPtr]::Zero; Process = [IntPtr]::Zero; Wait = $null }',
  '  $probes[$id] = $probe',
  "  $probe['Job'] = $native::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)",
  "  if ($probe['Job'] -eq [IntPtr]::Zero) { Fail 'CreateJobObject' }",
  "  if (-not $native::SetInformationJobObject($probe['Job'], 9, $limit, $limitSize)) { Fail 'SetInformationJobObject' }",
  // PIPE_ACCESS_DUPLEX with FILE_FLAG_FIRST_PIPE_INSTANCE, byte mode with
  // PIPE_REJECT_REMOTE_CLIENTS, one instance: a name someone else holds, or
  // a client that is not the host, fails the probe instead of sharing it.
  "  foreach ($pipe in @(@('Out', $out), @('Err', $err))) {",
  '    $handle = $native::CreateNamedPipeW((Text $pipe[1]), 0x80003, 8, 1, 65536, 65536, 0, $inherit)',
  "    if ($handle -eq $invalid) { Fail 'CreateNamedPipe' }",
  '    $probe[$pipe[0]] = $handle',
  '  }',
  "  Say ('listening ' + $id)",
  '}',
  'function Run-Probe($id, $app, $line, $environment, $cwd) {',
  '  $probe = $probes[$id]',
  "  if ($null -eq $probe) { throw 'unknown probe' }",
  "  $running = 0; foreach ($other in $probes.Values) { if ($other['Wait']) { $running++ } }",
  "  if ($running -ge 63) { throw 'too many concurrent discovery probes' }",
  // The host connected to both before it asked to run, so each returns at
  // once with ERROR_PIPE_CONNECTED.
  "  foreach ($name in @('Out', 'Err')) { if (-not $native::ConnectNamedPipe($probe[$name], [IntPtr]::Zero)) { $code = $marshal::GetLastWin32Error(); if ($code -ne 535) { throw ('ConnectNamedPipe failed: ' + $code) } } }",
  "  if (-not $native::CreatePipe($scratch, [IntPtr]($scratch.ToInt64() + $p), $inherit, 0)) { Fail 'CreatePipe' }",
  "  $probe['InRead'] = $marshal::ReadIntPtr($scratch, 0); $probe['InWrite'] = $marshal::ReadIntPtr($scratch, $p)",
  '  [void]$native::InitializeProcThreadAttributeList([IntPtr]::Zero, 1, 0, $scratch)',
  '  $list = $marshal::AllocHGlobal($marshal::ReadIntPtr($scratch, 0))',
  '  $command = $marshal::StringToHGlobalUni((Text $line))',
  '  $block = [Convert]::FromBase64String($environment)',
  '  $envBlock = $marshal::AllocHGlobal($block.Length)',
  '  $initialized = $false',
  '  try {',
  "    if (-not $native::InitializeProcThreadAttributeList($list, 1, 0, $scratch)) { Fail 'InitializeProcThreadAttributeList' }",
  '    $initialized = $true',
  "    $marshal::WriteIntPtr($handles, 0, $probe['InRead']); $marshal::WriteIntPtr($handles, $p, $probe['Out']); $marshal::WriteIntPtr($handles, 2 * $p, $probe['Err'])",
  // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: the probe inherits these three only.
  "    if (-not $native::UpdateProcThreadAttribute($list, 0, [IntPtr]0x20002, $handles, [IntPtr](3 * $p), [IntPtr]::Zero, [IntPtr]::Zero)) { Fail 'UpdateProcThreadAttribute' }",
  "    for ($i = 0; $i -lt $si['Size']; $i++) { $marshal::WriteByte($startup, $i, 0) }",
  "    $marshal::WriteInt32($startup, 0, $si['Size'])",
  // wShowWindow stays SW_HIDE (0).
  "    $marshal::WriteInt32($startup, $si['Flags'], $STARTF_USESTDHANDLES -bor $STARTF_USESHOWWINDOW)",
  "    $marshal::WriteIntPtr($startup, $si['In'], $probe['InRead']); $marshal::WriteIntPtr($startup, $si['Out'], $probe['Out']); $marshal::WriteIntPtr($startup, $si['Err'], $probe['Err'])",
  "    $marshal::WriteIntPtr($startup, $si['List'], $list)",
  '    $marshal::Copy($block, 0, $envBlock, $block.Length)',
  "    if (-not $native::CreateProcessW((Text $app), $command, [IntPtr]::Zero, [IntPtr]::Zero, $true, $creation, $envBlock, (Text $cwd), $startup, $info)) { Fail 'CreateProcess' }",
  '  } finally {',
  '    if ($initialized) { $native::DeleteProcThreadAttributeList($list) }',
  '    $marshal::FreeHGlobal($list); $marshal::FreeHGlobal($command); $marshal::FreeHGlobal($envBlock)',
  '  }',
  "  $probe['Process'] = $marshal::ReadIntPtr($info, 0)",
  '  $thread = $marshal::ReadIntPtr($info, $p)',
  // Suspended until it is in the job, so it never runs outside it.
  "  if (-not $native::AssignProcessToJobObject($probe['Job'], $probe['Process'])) { $code = $marshal::GetLastWin32Error(); [void]$native::TerminateProcess($probe['Process'], 1); [void]$native::CloseHandle($thread); throw ('AssignProcessToJobObject failed: ' + $code) }",
  "  if ($native::ResumeThread($thread) -eq -1) { $code = $marshal::GetLastWin32Error(); [void]$native::TerminateProcess($probe['Process'], 1); [void]$native::CloseHandle($thread); throw ('ResumeThread failed: ' + $code) }",
  '  [void]$native::CloseHandle($thread)',
  // The probe holds the pipes now; the host sees their end once it and every
  // descendant have let go.
  "  foreach ($name in @('Out', 'Err', 'InRead')) { [void]$native::CloseHandle($probe[$name]); $probe[$name] = [IntPtr]::Zero }",
  '  $wait = New-Object Threading.ManualResetEvent $false',
  '  $own = $wait.SafeWaitHandle',
  "  $wait.SafeWaitHandle = New-Object Microsoft.Win32.SafeHandles.SafeWaitHandle($probe['Process'], $false)",
  '  $own.Dispose()',
  "  $probe['Wait'] = $wait",
  "  Say ('started ' + $id)",
  '}',
  "Say 'ready'",
  '$reader = New-Object IO.StreamReader([Console]::OpenStandardInput())',
  '$read = $reader.ReadLineAsync()',
  'while ($true) {',
  '  $ids = New-Object Collections.Generic.List[string]',
  '  $waits = New-Object Collections.Generic.List[Threading.WaitHandle]',
  '  $waits.Add(([IAsyncResult]$read).AsyncWaitHandle)',
  "  foreach ($entry in $probes.GetEnumerator()) { if ($entry.Value['Wait']) { $ids.Add($entry.Key); $waits.Add($entry.Value['Wait']) } }",
  '  $at = [Threading.WaitHandle]::WaitAny($waits.ToArray())',
  '  if ($at -eq 0) {',
  '    $line = $read.Result',
  // The host's end of stdin closed: it exited or let this go. Exiting
  // closes every job.
  '    if ($null -eq $line) { break }',
  '    $read = $reader.ReadLineAsync()',
  "    $words = $line.Split(' ')",
  '    try {',
  "      if ($words[0] -eq 'start') { Start-Probe $words[1] $words[2] $words[3] }",
  "      elseif ($words[0] -eq 'run') { Run-Probe $words[1] $words[2] $words[3] $words[4] $words[5] }",
  "      elseif ($words[0] -eq 'kill') { Stop-Probe $words[1] }",
  '    } catch {',
  '      if ($words.Length -lt 2) { continue }',
  '      Stop-Probe $words[1]',
  "      Say ('failed ' + $words[1] + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))",
  '    }',
  '  } else {',
  '    $id = $ids[$at - 1]',
  "    $code = if ($native::GetExitCodeProcess($probes[$id]['Process'], $scratch)) { [uint32]('0x' + $marshal::ReadInt32($scratch).ToString('x8')) } else { 1 }",
  // Its job closes with it: a child the shell left running ends here.
  '    Stop-Probe $id',
  "    Say ('exit ' + $id + ' ' + $code)",
  '  }',
  '}',
  'exit 0',
].join('\n');

/** How long an idle supervisor is kept for the next probe. */
const IDLE_MS = 2 * 60_000;

interface ProbeListener {
  message(kind: string, args: string[]): void;
  /** The supervisor is gone: its jobs, and every process in them, with it. */
  gone(error: Error): void;
}

class Supervisor {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  private readonly probes = new Map<string, ProbeListener>();
  private buffer = '';
  private stderr = '';
  private idle: NodeJS.Timeout | undefined;
  private isReady = false;
  private ended = false;
  private readonly stopOnExit = () => { this.child.kill(); };

  private readonly forget: (supervisor: Supervisor) => void;

  constructor(file: string, forget: (supervisor: Supervisor) => void) {
    this.forget = forget;
    this.child = spawn(file, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', SUPERVISOR], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // The host's normal exit ends the supervisor, and with it every job. An
    // abrupt one does too: libuv put the supervisor in the host's own
    // kill-on-close job.
    process.once('exit', this.stopOnExit);
    this.ready = new Promise((resolve, reject) => {
      this.child.stdout?.setEncoding('utf8');
      this.child.stdout?.on('data', (data: string) => {
        this.buffer += data;
        let at: number;
        while ((at = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, at).trim();
          this.buffer = this.buffer.slice(at + 1);
          if (line === 'ready') { this.isReady = true; resolve(); continue; }
          const [kind, id, ...args] = line.split(' ');
          if (id !== undefined) this.probes.get(id)?.message(kind, args);
        }
      });
      this.child.stderr?.setEncoding('utf8');
      this.child.stderr?.on('data', (data: string) => { this.stderr = (this.stderr + data).slice(-4096); });
      const end = (reason: string) => {
        if (this.ended) return;
        this.ended = true;
        process.removeListener('exit', this.stopOnExit);
        if (this.idle) clearTimeout(this.idle);
        this.forget(this);
        const detail = this.stderr.trim() || reason;
        const error = new Error(this.isReady
          ? `Windows discovery supervisor exited mid-probe: ${detail}`
          : `Windows discovery cleanup could not be set up: ${detail}`);
        reject(error);
        for (const probe of [...this.probes.values()]) probe.gone(error);
        this.probes.clear();
      };
      this.child.on('error', error => end(error.message));
      this.child.on('exit', (code, signal) => end(`exited with ${code ?? signal}`));
    });
    // A probe that is abandoned before the supervisor is ready must not
    // leave an unhandled rejection behind.
    this.ready.catch(() => {});
    this.child.stdin?.on('error', () => {});
    this.hold();
  }

  get alive(): boolean { return !this.ended; }

  attach(id: string, listener: ProbeListener): void {
    this.probes.set(id, listener);
    this.hold();
  }

  detach(id: string): void {
    if (!this.probes.delete(id)) return;
    if (this.probes.size === 0) this.release();
  }

  send(line: string): void {
    if (!this.ended) this.child.stdin?.write(`${line}\n`);
  }

  /** A probe in flight keeps the host running, as `exec`'s child would. */
  private hold(): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = undefined; }
    this.child.ref();
    for (const stream of [this.child.stdout, this.child.stderr]) (stream as Socket | null)?.ref?.();
  }

  /** An idle supervisor keeps nothing running and leaves after a while. */
  private release(): void {
    this.child.unref();
    for (const stream of [this.child.stdout, this.child.stderr]) (stream as Socket | null)?.unref?.();
    this.idle = setTimeout(() => {
      if (this.probes.size > 0) return;
      this.forget(this);
      this.child.stdin?.end();
    }, IDLE_MS);
    this.idle.unref();
  }
}

const supervisors = new Map<string, Supervisor>();

function supervisorAt(file: string): Supervisor {
  const current = supervisors.get(file);
  if (current?.alive) return current;
  const supervisor = new Supervisor(file, gone => { if (supervisors.get(file) === gone) supervisors.delete(file); });
  supervisors.set(file, supervisor);
  return supervisor;
}

/** The supervisors this host runs. Exported for its test, which ends one to see probes fail and the next one start afresh. */
export function windowsProbeSupervisors(): ChildProcess[] {
  return [...supervisors.values()].map(supervisor => supervisor.child);
}

/**
 * The environment block `child_process.exec` would hand the shell: Node's
 * Windows rule (keys sorted, the first of a case-insensitive duplicate kept,
 * undefined dropped), then libuv's (the variables Windows programs need taken
 * from the host when missing, sorted case-insensitively).
 */
export function windowsEnvironmentBlock(env: NodeJS.ProcessEnv, host: NodeJS.ProcessEnv = process.env): string {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const key of Object.keys(env).sort()) {
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const value = env[key];
    if (value === undefined) continue;
    if (key.includes('\0') || String(value).includes('\0')) throw new TypeError(`The environment variable ${key} contains a null byte`);
    pairs.push([key, String(value)]);
  }
  const present = new Set(pairs.map(([key]) => key.toUpperCase()));
  for (const name of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) {
    if (present.has(name)) continue;
    const key = Object.keys(host).find(candidate => candidate.toUpperCase() === name);
    const value = key === undefined ? undefined : host[key];
    if (value !== undefined) pairs.push([name, value]);
  }
  const upper = (key: string) => key.toUpperCase();
  pairs.sort(([a], [b]) => (upper(a) < upper(b) ? -1 : upper(a) > upper(b) ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}\0`).join('') + '\0';
}

const wide = (text: string) => Buffer.from(text, 'utf16le').toString('base64');

export interface WindowsProbeOptions { timeout?: number; env: NodeJS.ProcessEnv; maxBuffer: number; signal?: AbortSignal }

let nextId = 0;

/**
 * Run one probe under the host's supervisor, as `child_process.exec` would
 * run it: the host's `ComSpec` when that names cmd.exe, given
 * `/d /s /c "<command>"`, with exec's environment and the host's working
 * directory. A timeout, a cancellation, an overflow and the supervisor's
 * death end the probe's job; if the job cannot be set up the command never
 * runs and the probe fails.
 */
export function runWindowsProbe(command: string, options: WindowsProbeOptions, host: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string }> {
  const root = host.SystemRoot ?? host.windir;
  if (!root) return Promise.reject(new Error('Windows discovery cleanup could not be set up: SystemRoot is not set'));
  // exec's shell: the host's ComSpec. One that is not cmd.exe would take
  // `-c` and other quoting; every probe is written for cmd.exe, so that is
  // what runs it.
  const comspec = host.ComSpec;
  const shell = comspec && /^(?:.*\\)?cmd(?:\.exe)?$/i.test(comspec) ? comspec : path.win32.join(root, 'System32', 'cmd.exe');
  let environment: string;
  try { environment = Buffer.from(windowsEnvironmentBlock(options.env, host), 'utf16le').toString('base64'); } catch (error) { return Promise.reject(error); }
  const supervisor = supervisorAt(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const id = String(++nextId);
  const pipe = `\\\\.\\pipe\\ordewell-probe-${process.pid}-${randomBytes(16).toString('hex')}`;
  const limit = options.maxBuffer;
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let timer: NodeJS.Timeout | undefined;
    let exitCode: number | undefined;
    let stdout = '';
    let stderr = '';
    const sockets: Socket[] = [];
    let open = 0;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      supervisor.detach(id);
      for (const socket of sockets) socket.destroy();
      outcome();
    };
    // Ends the probe's job, and every process in it, unless it already ended.
    const stop = (error: Error) => settle(() => { supervisor.send(`kill ${id}`); reject(error); });
    const setupFailed = (detail: string) => stop(new Error(`Windows discovery cleanup could not be set up: ${detail}`));
    const finish = () => {
      if (exitCode === undefined || open > 0) return;
      const code = exitCode;
      settle(() => {
        if (code === 0) resolve({ stdout });
        else reject(Object.assign(new Error(`Discovery command exited with ${code}`), { code, signal: null, killed: false, stdout, stderr }));
      });
    };
    const read = (socket: Socket, append: (data: string) => number) => {
      socket.setEncoding('utf8');
      socket.on('data', (data: string) => {
        if (append(data) > limit) stop(new Error('Discovery output exceeded maxBuffer'));
      });
      socket.on('close', () => { open--; finish(); });
    };
    const connectPipes = () => {
      let connected = 0;
      for (const [name, append] of [['out', (data: string) => Buffer.byteLength(stdout += data)], ['err', (data: string) => Buffer.byteLength(stderr += data)]] as const) {
        const socket = connect(`${pipe}-${name}`);
        sockets.push(socket);
        open++;
        socket.on('error', error => { if (!started) setupFailed(error.message); });
        socket.once('connect', () => {
          read(socket, append);
          if (++connected === 2 && !settled) supervisor.send(`run ${id} ${wide(shell)} ${wide(`"${shell}" /d /s /c "${command}"`)} ${environment} ${wide(process.cwd())}`);
        });
      }
    };
    const cancel = () => stop(new Error('Discovery cancelled'));
    supervisor.attach(id, {
      message(kind, args) {
        if (settled) return;
        if (kind === 'listening') connectPipes();
        else if (kind === 'started') started = true;
        else if (kind === 'failed') setupFailed(Buffer.from(args[0] ?? '', 'base64').toString('utf8'));
        else if (kind === 'exit') { exitCode = Number(args[0]); finish(); }
      },
      gone(error) { settle(() => reject(error)); },
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.timeout) timer = setTimeout(() => {
      stop(Object.assign(new Error(`Discovery command timed out after ${options.timeout}ms`), { killed: true, signal: 'SIGTERM' }));
    }, options.timeout);
    supervisor.ready.then(
      () => { if (!settled) supervisor.send(`start ${id} ${wide(`${pipe}-out`)} ${wide(`${pipe}-err`)}`); },
      (error: Error) => settle(() => reject(error)),
    );
  });
}
