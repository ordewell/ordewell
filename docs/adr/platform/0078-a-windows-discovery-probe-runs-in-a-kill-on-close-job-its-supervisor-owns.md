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
And it must not make a probe cost much more than the `exec` it replaces: a
host runs one per agent at startup and on every refresh.

## Decision

**On Windows every discovery probe of a host runs under one long-lived
supervisor, started on the first probe and reused by the next. For each probe
it creates a new job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no
breakaway, starts the shell suspended, assigns it to that job and only then
lets it run. It holds the job's only handle, so closing that handle, or the
supervisor's own end, ends every process the probe started.**

- **The supervisor** is Windows PowerShell 5.1 (`powershell.exe` under
  `%SystemRoot%\System32\WindowsPowerShell\v1.0`, by absolute path), run with
  `-NoProfile -NonInteractive -OutputFormat Text -Command` and a fixed script
  (`SUPERVISOR` in `windowsProbeSupervisor.ts`). The script declares the
  kernel32 calls it needs through `Reflection.Emit` and then serves probes
  until its stdin closes. There is one per host process and per
  `powershell.exe` path, so a host whose `SystemRoot` changes starts its own.
  While no probe is in flight it keeps nothing running (its process and pipes
  are unreferenced), and after two idle minutes the host closes its stdin and
  it exits; the next probe starts a new one.
- **The host talks to it over its stdio,** one line per message, every
  free-form field base64: `start` (it creates the job and the probe's two
  pipes, and answers `listening`), `run` (it starts the shell and answers
  `started`, or `failed` with its error), `kill`, and its own `exit` with the
  shell's exit code. A probe has an ID of the host's choosing, so concurrent
  probes never share a job, a pipe or a message.
- **Owned by handle, from creation.** The supervisor creates the shell with
  `CREATE_SUSPENDED`, assigns it to the probe's job and only then resumes its
  thread, so the shell and everything it starts are members before they can
  start anything. If the assignment or the resume fails it terminates that
  suspended process through the handle `CreateProcess` gave it, which never
  ran, and the probe fails. The job is unnamed and its handle not inheritable.
  Nothing is ever found by PID, image name or command line.
- **The output never passes through the supervisor.** For each probe it
  creates a named pipe for stdout and one for stderr, with one instance each,
  `FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS`; the host
  connects to both before it asks to run, and the shell gets their server
  ends. A name someone else already holds, or a client that took the only
  instance first, fails the probe before the command runs. The shell's stdin is
  a pipe of the supervisor's that nothing writes, as `exec` gives. A
  `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` lets the shell inherit those three
  handles and nothing else, never the supervisor's own stdio or another probe's
  pipes.
- **Armed before it runs, or it never runs.** A supervisor that cannot start
  (no `powershell.exe`, a Constrained Language Mode that refuses
  `Reflection.Emit`) or a probe it cannot set up (the job, the pipes, the
  assignment) fails the probe with "Windows discovery cleanup could not be set
  up" and the reason. Nothing falls back to a plain `exec`.
- **The command runs as `exec` would run it.** The shell is the host's
  `ComSpec` when that names `cmd.exe` (`%SystemRoot%\System32\cmd.exe`
  otherwise), with the command line `"<shell>" /d /s /c "<command>"`. Its
  environment block is the one `exec` would build: Node's Windows rule (keys
  sorted, the first of a case-insensitive duplicate kept), then libuv's (the
  variables Windows programs need taken from the host when missing, sorted).
  Its working directory is the host's at the time of the probe. It starts with
  `CREATE_NO_WINDOW` and `SW_HIDE`, the two halves of `windowsHide`, and the
  supervisor itself is spawned with `windowsHide`. The host keeps the same
  timeout, `maxBuffer`, `killed: true` on a timeout, error fields and exit
  code as before.
- **How it ends.** A timeout, a cancellation (`dispose()`) and an output
  overflow send `kill`, and the supervisor closes that probe's job. When the
  shell exits the supervisor reports its exit code and closes the job too, so
  **a probe that answers and leaves a child behind loses that child**, detached
  or not. POSIX differs here, since it never signals a group whose leader has
  exited.
- **The supervisor's end ends every probe.** Its exit closes every job handle
  it holds, so every probe tree in flight is terminated. The host's normal exit
  terminates it (an exit hook calls `ChildProcess.kill()`, `TerminateProcess` on
  the handle libuv holds), and so does an abrupt host kill: libuv put the
  supervisor in the host's own kill-on-close job. A supervisor that dies while
  probes are in flight, for whatever reason, fails each of them with "Windows
  discovery supervisor exited mid-probe"; the next probe starts a new one.

## Testing decisions

The seam is `discoveryExec`, run natively on Windows against `probe-tree`, a
fake CLI: a Node script with `.cmd` and `.ps1` shims put on PATH by
`pathWithFake`. It starts a grandchild and writes both PIDs. Every fixture
process ends on its own, so a cleanup that fails leaves nothing behind for long,
and a test only asks whether a PID is alive and never kills by one. A
bystander `node.exe` that the probe did not start must survive every case.
The host-exit cases run the probe from a host process of their own, which loads
`windowsProbeSupervisor.ts` with Node's type stripping, and then end it or kill
it outright. `windowsProbeSupervisors()` is exported so that a test can see one
supervisor serve several probes, and end one to see its probes fail and the next
probe start another. A parity test compares the environment and the exit
details a command sees under the supervisor with what it sees under `exec`.
`probeSpawnsHidden.test.ts` pins `windowsHide` on the supervisor's spawn and
`CREATE_NO_WINDOW` with `SW_HIDE` in its script.

## Out of scope

- A process the probe has a broker start (WMI, Task Scheduler, a COM server, a
  service) is not its descendant and is not in its job.
- Stopping a runner stays with `killTree` and its `taskkill /T`
  ([ADR-0010](0010-windows-support.md)). Codex's app-server and the ACP
  model probes go through `RunnerProcess`, not `discoveryExec`.
- Another process of the same user can see a probe's pipe names and read or
  write anything of that user's, so the pipes guard against a mistaken
  client, not a hostile one.

## Considered options

- **Keep `exec`.** Rejected: its timeout and its abort end only `cmd.exe`, the
  defect in #243.
- **`taskkill /T` by PID, as `utils/processTree.ts` stops runners.** Rejected:
  a PID can be reused, and a walk by parent PID can reach a process that is not
  the probe's.
- **One supervisor per probe**, which put itself in a new job and then started
  the shell with its own standard handles. It was the first design (#243).
  Dropped: it started a Windows PowerShell process for every probe, many times
  the cost of the `exec` it replaced, and a host's startup runs several at once.
- **Host spawns the shell and the supervisor assigns it by PID**, with the
  shell held at a `set /p` on stdin until it is in the job. Rejected: the shell
  could die and its PID be reused between the host's spawn and the
  supervisor's `OpenProcess`, and the job would then hold, and later kill, a
  process the probe never started. It also rewrote the probe's command line.
- **The supervisor forwards the probe's output over its own stdout.** Rejected:
  Windows PowerShell has no way to read several pipes at once without a
  runspace per reader, and every byte would cross one more process.
- **A small Node intermediate relying on libuv's job.** libuv puts each child
  it spawns in a per-process kill-on-close job. Rejected: that job sets
  `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, so the shell's own children are not
  members. On the host above, terminating such an intermediate left the
  probe's script and its grandchild running. The desktop daemon also has no
  Node binary to run it with (ADR-0063).
- **`Add-Type` with C# in the supervisor.** Rejected: Windows PowerShell
  compiles it with `csc.exe`, a much slower start than `Reflection.Emit`.
- **A helper executable, or a native addon.** Rejected for now: it would be a
  binary to build, sign and ship for each architecture, or a native dependency
  in core, when the PowerShell that every supported Windows has can do the job.

## Consequences

- A host's first Windows probe also waits for Windows PowerShell to start;
  later ones reuse it, and an idle host keeps one PowerShell process for two
  minutes after its last probe.
- Where Windows PowerShell is missing or locked down (Constrained Language
  Mode under WDAC or AppLocker), Windows discovery fails with an explicit
  error and runs nothing, so installed agents read as not found there.
- A descendant that asks to break away from its job (`CREATE_BREAKAWAY_FROM_JOB`)
  fails to start under a probe.
- At most 63 probes of one host run at once; one more fails explicitly.
- A security product may report a hidden PowerShell process that declares
  P/Invoke methods and starts processes suspended.

## History

- 2026-11-27 — accepted (#243).
- 2026-11-28 — one long-lived supervisor per host, a job and two named pipes per probe, replacing one supervisor per probe.
