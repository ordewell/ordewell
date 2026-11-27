---
status: accepted
---

# 0078 — A Windows discovery probe runs in a kill-on-close job its supervisor owns

## Problem

A discovery probe (`discoveryExec`, used by `ModelDiscovery` and
`RunnerInstallation`) runs one shell command: `claude --version`,
`opencode models`. On POSIX it runs in its own process group, and a timeout, a
cancellation, an output overflow or the host's exit signals that group. On
Windows it ran through `child_process.exec`, which on a timeout or an abort
terminates only `cmd.exe` (#243). The agent behind a `.cmd` shim, and anything
that agent started, kept running after the probe had been given up on. On
Windows 11 Pro 10.0.26300 with Node 22.17.1, `exec` with a 2000 ms timeout and
`windowsHide` of a Node script that starts a 30 s grandchild called back with
`killed: true` and both the script and the grandchild still running, directly
and through a `.cmd` shim alike.

The fix must not make things worse. A PID can be reused once its process has
exited, and a Windows tree walk by parent PID can reach a process that only
inherited a dead parent's number, so a kill by PID, image name or command line
can end a process the probe never started. The fix also has to work on every
surface core runs in: the CLI's daemon (plain Node), the VS Code extension
host, and the desktop app's daemon, an Electron utility process whose
`process.execPath` is the app itself with `runAsNode` fused off
([ADR-0063](../surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).

## Decision

**On Windows a discovery probe runs under a supervisor that first puts itself
in a new job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway,
and only then starts the shell. Ending the supervisor, through the handle
libuv holds for it, ends every process the probe started.**

- **The supervisor** is Windows PowerShell 5.1 (`powershell.exe` under
  `%SystemRoot%\System32\WindowsPowerShell\v1.0`, by absolute path), run with
  `-NoProfile -NonInteractive -OutputFormat Text -Command` and a fixed script
  (`WINDOWS_SUPERVISOR` in `discoveryExec.ts`). The script declares
  `CreateJobObjectW`, `SetInformationJobObject` and `AssignProcessToJobObject`
  through `Reflection.Emit`, creates an unnamed job whose handle is not
  inheritable, and assigns itself to it. Only it holds the job's handle, so the
  job closes, and every member is terminated, when the supervisor ends, by
  exiting or by being terminated. Jobs nest on Windows 8 and later, so this works
  although libuv has already put the supervisor in the host's own job.
- **Armed before it runs.** Once it is in the job, the supervisor writes a
  token the host chose for this probe, with a line break, on stderr, and then
  starts the shell. The host takes that line off stderr. Without it the command
  never ran: the probe fails with "Windows discovery cleanup could not be set
  up", giving the supervisor's own message, and nothing falls back to a plain
  `exec`. That covers a missing `powershell.exe`, a Constrained Language Mode
  that refuses `Reflection.Emit`, and a job that refuses the nesting.
- **The command runs as `exec` would run it.** The shell is the host's
  `ComSpec` when that names `cmd.exe` (`%SystemRoot%\System32\cmd.exe`
  otherwise), given `/d /s /c "<command>"` verbatim. It inherits the
  supervisor's standard handles, so its output reaches the host directly. Its
  environment is the probe's, minus the supervisor's own variables, and with
  `PSModulePath` and `PATHEXT` put back as they were given, since
  `powershell.exe` rewrites both as it starts. The supervisor exits with the
  shell's exit code. The host keeps the same timeout, `maxBuffer`, `killed:
  true` on a timeout, error fields and `windowsHide` as before.
- **How it ends.** A timeout, a cancellation (`dispose()`), an output overflow
  and the host's normal exit (its exit hook) all call `ChildProcess.kill()` on
  the supervisor. That is `TerminateProcess` on the handle libuv holds, and it
  does nothing once the supervisor has exited, so no reused PID is touched.
- **A probe that answers and leaves a child behind loses that child.** The
  supervisor exits once the shell does, and its job closes, so a child the
  probe left running, detached or not, is terminated as the probe's result is
  returned. A probe's processes stop when its answer arrives. POSIX differs here, since
  it never signals a group whose leader has exited.
- **An abrupt host kill also ends the tree.** libuv puts the supervisor in the
  host's own job, which also kills on close. The probe's job is nested inside
  it, so the probe's processes are members of the host's job too, and the host's
  death closes that job and terminates them.

## Testing decisions

The seam is `discoveryExec`, run natively on Windows against `probe-tree`, a
fake CLI: a Node script with `.cmd` and `.ps1` shims put on PATH by
`pathWithFake`. It starts a grandchild and writes both PIDs. Every fixture
process ends on its own, so a cleanup that fails leaves nothing behind for long,
and a test only asks whether a PID is alive and never kills by one. A
bystander `node.exe` that the probe did not start must survive every case.
`windowsProbeLaunch` is exported so that a test can start the supervisor from a
host process it then ends or kills outright. A parity test compares the
environment and the exit details a command sees under the supervisor with what
it sees under `exec`. `probeSpawnsHidden.test.ts` pins `windowsHide` on the
supervisor's spawn.

## Out of scope

- A process the probe has a broker start (WMI, Task Scheduler, a COM server, a
  service) is not its descendant and is not in its job.
- Stopping a runner stays with `killTree` and its `taskkill /T`
  ([ADR-0010](0010-windows-support.md)). Codex's app-server and the ACP
  model probes go through `RunnerProcess`, not `discoveryExec`.

## Considered options

- **Keep `exec`.** Rejected: its timeout and its abort end only `cmd.exe`, the
  defect in #243.
- **`taskkill /T` by PID, as `utils/processTree.ts` stops runners.** Rejected:
  a PID can be reused, and a walk by parent PID can reach a process that is not
  the probe's.
- **A small Node intermediate relying on libuv's job.** libuv puts each child
  it spawns in a per-process kill-on-close job. Rejected: that job sets
  `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so the shell's own children are not
  members. On the host above, terminating such an intermediate left the
  probe's script and its grandchild running. The desktop daemon also has no
  Node binary to run it with (ADR-0063).
- **`Add-Type` with C# in the supervisor.** Rejected: Windows PowerShell
  compiles it with `csc.exe` on every probe, a much slower start than
  `Reflection.Emit`.
- **A helper executable, or a native addon.** Rejected for now: it would be a
  binary to build, sign and ship for each architecture, or a native dependency
  in core, when the PowerShell that every supported Windows has can do the job.

## Consequences

- Every Windows probe also starts a Windows PowerShell process, so a probe
  takes longer to start than a bare `cmd.exe` does.
- Where Windows PowerShell is missing or locked down (Constrained Language
  Mode under WDAC or AppLocker), Windows discovery fails with an explicit
  error and runs nothing, so installed agents read as not found there.
- A descendant that asks to break away from its job (`CREATE_BREAKAWAY_FROM_JOB`)
  fails to start under a probe.
- A security product may report a hidden PowerShell process that declares
  P/Invoke methods.

## History

- 2026-11-27 — accepted (#243).
