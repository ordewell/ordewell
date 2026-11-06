# Troubleshooting

## Codex sandbox unavailable on this host

Ordewell shows **Codex sandbox unavailable on this host: Guarded mode is off**, and Codex tasks in Guarded mode are refused.

### Cause

Codex's Linux sandbox is bubblewrap (`bwrap`), which needs unprivileged user
namespaces. On Ubuntu 23.10 and later, AppArmor can restrict them
(`kernel.apparmor_restrict_unprivileged_userns=1`, on by default from Ubuntu
24.04), and a stock install has no profile that lets `bwrap` use them. Many
containers restrict them as well. Codex's older Landlock backend did not start
on codex-cli 0.162 either.

On such a host, Ordewell probes the sandbox once per daemon. While it cannot
start:

- Codex's Guarded (`agent`) mode is off. Ordewell's read-only profile (`plan`) remains available: its native shell is off, and commands use Ordewell's run_command.
  Its Full access mode is not sandboxed and stays available.
- A plan or an edit that puts a task in Guarded mode is refused with the reason. A task
  already in one fails at start with the same reason. Ordewell never swaps the
  mode for another.
- A Codex planner still plans: its own shell is off and it reads through
  Ordewell's `run_command` ([ADR-0033](adr/planner-envelope/0033-codex-planner-without-its-sandbox.md)).

### Check it

```bash
bwrap --ro-bind / / true          # no output means bubblewrap can start
codex sandbox -- /bin/true        # the check Ordewell runs; exit status 0 means it works
sysctl kernel.apparmor_restrict_unprivileged_userns
```

`bwrap` printing `loopback: Failed RTM_NEWADDR` or `Operation not permitted`
confirms the cause. A `sysctl` value of `1` points at AppArmor.

### Fix: the narrow one (an AppArmor profile for `bwrap`)

On Ubuntu 24.04 the `apparmor` package carries a profile that lets `bwrap`
create user namespaces, but does not install it:

```bash
sudo apt install apparmor-profiles apparmor-utils
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

Later Ubuntu releases may ship it already loaded; check before installing it.
A profile applies to one binary path. If Codex runs a `bwrap` of its own rather
than `/usr/bin/bwrap`, the profile has to name that path instead.

### Fix: the wide one (the system-wide sysctl)

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

This lifts the restriction for every program on the machine, which is why the
profile above is the better choice. It lasts until reboot; to keep it, put the
setting in a file under `/etc/sysctl.d/`.

### After the fix

Check again with the commands above, then restart the Ordewell daemon, or run
`ordewell runners` (or refresh the runner list in VS Code). Ordewell asks the
host again when the runner list is refreshed, and always on a daemon restart.
Tasks planned while the modes were off keep the mode the plan gave them.

### Without a fix

Give the task Full access, or assign it to another runner. Full access means
Codex runs with no sandbox at all.

Inside a [container](containers.md) none of this applies: Codex's sandbox cannot start
there, whatever this host allows, and a Codex change task runs at Full access.

## Codex's Windows sandbox is not set up

A Codex task's log on Windows says **Codex's Windows sandbox is not set up on
this machine, so Codex runs this task read-only with no sandbox** (or that it
**needs its setup run again**).

### Cause

Codex has a Windows sandbox of its own, which you set up once and which asks
for Administrator. Until you do, Codex opens a task in Guarded (`agent`) mode
as read-only and has nothing to confine its commands with. An edit, and a
command Codex does not judge safe, goes to Codex's reviewer, and what the
reviewer approves runs unconfined. The task still runs and lands its work;
Ordewell keeps the mode the plan gave it and tells the model how to write
through review. A Codex planner is not affected: on Windows it plans with its
own shell off and reads through Ordewell's `run_command`
([ADR-0010](adr/platform/0010-windows-support.md)).

### Fix

Run `codex` in a terminal and choose **Set up default sandbox** when it offers,
or run `/setup-default-sandbox` there. It asks for Administrator once. See
[Codex on Windows](https://developers.openai.com/codex/windows). Ordewell
reads the setup when each Codex task starts, so nothing needs a restart.

Do not choose Codex's non-admin sandbox instead: under it, codex-cli 0.166.0
refuses every command of a Guarded task.

## Planner shell not sandboxed

Ordewell says **The planner's shell runs without an OS sandbox on this
machine**, or **Sealed runs are unavailable on this machine**, once per
planning session.

### Cause

Every command the planner's shell runs (an API planner's `bash`, its research
subagents, a harness planner's `run_command`) runs in an OS sandbox where
nothing outside a scratch directory can be written
([ADR-0011](adr/planner-envelope/0011-sandboxing-the-planners-shell.md)):
Seatbelt on macOS, bubblewrap on Linux. Ordewell checks once per process
whether one can start. When none can, commands run as before, held to the
command rules alone, and planning goes on. The notice names the cause:

- Windows, which has no sandbox Ordewell can use.
- Linux without bubblewrap (`bwrap`) installed.
- Linux where bubblewrap cannot create user namespaces: Ubuntu 24.04's
  AppArmor restriction, or a container, as for
  [Codex's sandbox](#codex-sandbox-unavailable-on-this-host).
- macOS, when Ordewell itself runs inside another sandbox.

Without a sandbox there are no sealed runs either: a command the command rules
refuse, such as a loop, a here-document or a script piped into `python3`, is
refused rather than run sealed
([ADR-0036](adr/planner-envelope/0036-the-planners-shell-sealed-runs-and-native-opt-in.md)).
**Sealed runs are unavailable** means the sandbox starts but its stricter
sealed profile does not: its read list, its limits on processes and address
space, which a shell prelude sets with `ulimit` before the sandbox starts, or
on Linux the `sleep` and the shell's `test -ef` its memory watcher needs. The
notice quotes what failed.

### Check it

```bash
bwrap --unshare-pid --unshare-net --ro-bind / / --dev /dev --proc /proc true   # no output means it starts
```

### Fix

Install bubblewrap: `sudo apt install bubblewrap` (Debian, Ubuntu),
`sudo dnf install bubblewrap` (Fedora), `sudo pacman -S bubblewrap` (Arch).
For the user-namespace restriction, the fixes for
[Codex's sandbox](#fix-the-narrow-one-an-apparmor-profile-for-bwrap) apply:
an AppArmor profile for `/usr/bin/bwrap`, or the sysctl. Then restart
Ordewell (the daemon, or the VS Code window), since the check is made once per
process.

### What the sandbox changes

- A command that runs without asking has no network; one you approve keeps it.
- On macOS, `ps` and `top` cannot start inside it: the kernel will not run a
  setuid program in a sandbox. On Linux, a process listing shows only the
  sandbox's own processes.
- A tool that must write to read fails, such as `cargo metadata` on a crate
  without a committed `Cargo.lock`. The planner is told the sandbox stopped it.
- A sealed run sees only the workspace and the system's own files: a tool
  installed under your home directory (`~/.nvm`, `~/.cargo/bin`) does not
  start in one, and nothing it needs from the network or your accounts works.
  The planner's sealed runs have 60 seconds, and the result says it ran sealed.
  A read-only task's sealed commands get ten minutes instead, the time limit a
  script task gets, since running the project's tests is what its one shell is
  for; one that runs out of time says so. Either way a sealed run may hold
  4 GiB of memory across its processes, and one ended at that says so: run
  fewer test workers. On macOS a test that listens on a socket fails in one,
  loopback included, since it has no network. Once a read-only task has run one command
  sealed, all its later commands run sealed too, allowlisted ones
  included, so a `gh` it runs after that has no network.

## Ordewell needs a newer git

Ordewell says **Ordewell needs git 2.38 or newer, and this is git …** when a run
starts, or **A revert needs git 2.38 or newer** when you revert a task.

### Cause

Ordewell needs git 2.38 or newer, for `git merge-tree --write-tree`, which merges
without touching a worktree. Runs still start on an older git, with less:

| Git | What you lose |
| --- | --- |
| 2.33 to 2.37 | Reverting a task is refused. Merge all goes repository by repository and stops at the first that fails, so a group of repositories can be left part merged. |
| 2.32 and older | The same, and applying another task's patch fails, or reports conflicts that are not there. Older than 2.31 has not been tested. |

Debian 12 ships git 2.39, which does everything. Ubuntu 22.04 ships 2.34.

### Check it

```bash
git --version
```

Ordewell runs the first `git` on the `PATH` of its server, which may not be the
one your shell finds.

### Fix

Install a newer git; on Ubuntu, the [git maintainers' PPA](https://launchpad.net/~git-core/+archive/ubuntu/ppa)
has one. Then restart the Ordewell server, so that it finds the new one.

## Merge all refused: not on the base branch

Ordewell shows **Merged nothing, so every tree is as it was: … is on `<branch>`;
this run started on `<base>`**, and the handoff stays.

### Cause

Merge all lands each repository's integration branch into whatever that
repository has checked out, so it insists every repository of the run, with work
or not, is on the branch the run started on
([ADR-0042](adr/isolation/0042-merge-all-lands-only-on-the-branch-the-run-started-on.md)).
The handoff, `ordewell status` and the Merge confirmation name that branch (as
`main @ a1b2c3d`). In a group of repositories, one on the wrong branch keeps all
of them from merging.

### Fix

```bash
git -C <repo> branch --show-current   # empty means a detached HEAD
git -C <repo> switch <base>           # the branch the notice names
```

Then press Merge all again. Your uncommitted work stays where it is; if it
blocks the switch, commit or stash it first.

### Mid-rebase

If the notice says **in the middle of a rebase**, the rebase detached HEAD.
Finish it (`git rebase --continue`) or abort it (`git rebase --abort`) in the
repository named, check out the base branch, and merge again. A run that
started on a detached HEAD names no branch and is not checked.

## A gateway model is not offered for Claude Code

An edit is refused with **Runner "claude-code" does not offer model
"gproxy/default"**, or `ordewell model set` says the model was not discovered.

The sources Ordewell asks for Claude Code's models, the Anthropic Models API
and `claude --help`, list only Anthropic's models. Ordewell also offers each
model listed in `modelPicker.options` of Claude Code's settings:

```json
{ "modelPicker": { "options": [{ "model": "gproxy/default", "label": "Gateway" }] } }
```

A row needs a `model` string; `label` is optional. As Claude Code does,
Ordewell takes the whole list from the highest file that sets one: the managed
settings file (`managed-settings.json` and its `managed-settings.d/` files in
Claude Code's system directory), then your user settings,
`~/.claude/settings.json` or `settings.json` in `CLAUDE_CONFIG_DIR` when that
is set. `CLAUDE_CONFIG_DIR`, and the `HOME` (`USERPROFILE` on Windows) that
`~` stands for, are read from the environment the workspace's tasks run with,
its `.envrc` or `.ordewell/env` included, so each workspace a daemon serves is
offered its own account's list. Ordewell reads the files when it
discovers Claude's models, so restart it after editing one.

Ordewell does not read a list your organization delivers any other way: from
the claude.ai console or a Claude apps gateway (server-managed settings), a
macOS configuration profile, or the Windows `HKLM` or `HKCU` registry. Such a
list is not offered. And because Claude Code takes the whole list from the
highest source that sets one, such a list also replaces a file's list in
Claude Code's own `/model` picker while Ordewell still offers the file's.
Ordewell ignores a row's `behavesAs` and the list's `replaceBuiltInOptions`
too: it offers the listed models beside Anthropic's own either way.

## A task in a container says to run /login

A task on the `own-sign-in` login fails with **Please run /login**, or **OAuth
session expired and could not be refreshed**.

`/login` cannot help here: a task's container takes no input from you, and
Ordewell's own `/login` signs in on your machine, which no container reads. The
copy of your sign-in that the task holds has expired, been revoked, or lost its
refresh token to another copy; [Choose a
login](containers.md#choose-a-login) says how that happens.

Sign in again with the `docker run` command on that page, then Continue the task.
It takes the new sign-in and keeps its conversation.

`ordewell containers` can still read as ready meanwhile: it shows a sign-in is
held, not that it still works.

## A runner shows as switched off, and tasks are flagged

A task row reads **codex is switched off** or **Opus 4 is not in the allowlist**,
and the planner mentions a `runners_changed` note.

The runner is off in your enabled runners, or the model is off its runner's
allowlist. The task is only flagged: it still runs as assigned, and Ordewell
moves nothing. Switch the runner back on (`/runners`, or **Ordewell: Toggle
Runner**), add the model to the allowlist, or move the task to another runner
or model yourself or ask the planner to
([ADR-0043](adr/routing/0043-a-change-of-scope-reaches-the-planner-and-flags-tasks.md)).

### Runner toggles are now shared between VS Code and the terminal UI

The enabled runners are saved in Ordewell's settings file, so a toggle in VS
Code is the list the terminal UI and the daemon plan with, and the reverse. A
list found in VS Code's old `ordewell.enabledRunners` setting is copied there
once, unless the file already holds a choice, and then cleared; an empty list
there is not copied. If a window shows an older list, refresh the runner list.

## The planner hit its usage limit

The transcript shows a failure line with the limit's reset time, and VS Code
shows **Resending at …** above the composer.

What you sent, and any supervisor wake-up, is kept and goes again as one turn a
minute after the reset
([ADR-0044](adr/planner/0044-the-planners-usage-limit-waits-and-resends.md)). Anything
you send meanwhile is saved and goes with it. To stop the resend, use `/resend
cancel` in the terminal UI, `ordewell resend cancel`, or **Don't resend** in VS
Code: what waits then goes with your next message. If the planner did not say
when the limit resets, or hit it again right after a resend, or you moved the
planner to another runner, nothing is resent on its own: send a message once
the limit has reset.

## The planner is paused on its context

A turn of an API planner (OpenAI, OpenRouter, an OpenAI-compatible server,
Gemini) ends with **The planner is paused**, and the chat offers **Retry
compaction**.

Before every call, such a planner keeps its prompt inside 90% of the model's
window: it trims older file reads first, then condenses the conversation into a
summary written by the same model, which shows as **Context compacted
automatically** in the chat. When the provider still refuses a call as too long,
it compacts once more against what the refusal showed and sends the same call
once more. It pauses only when that leaves the call too large (once a summary
was written, past those 90%), the summary could not be written, or your message
is too long by itself
([ADR-0002](adr/planner/0002-planner-as-conversation-loop.md)). Only the planner
pauses: running tasks carry on and finish. What the call was to send is kept,
and so is your message, so nothing is cut to fit.

- **Retry compaction** attempts recovery: it condenses again and sends the
  call once, whatever the estimate. Switch the planner to a model with a
  larger window first if the same one paused twice. It does not promise the
  turn continues: if the call still does not fit it pauses again, and in the
  cases below it stays paused. In the terminal UI it is `/compact retry`, from
  the shell `ordewell compact retry`, and in VS Code the button above the
  composer.
- **Stop** drops the paused turn and its message; send a shorter one.

Messages you send while it is paused wait behind it. On the live context, a
retry sends the held results without running the turn's completed commands
again, and a call a turn condensed away is answered "not run again" if the
planner asks for it a second time within that turn. Nothing guards a fresh
request you make yourself: if you deliberately ask the planner to do the same
thing again in an intact context, it may.

After a reload, a switch of provider or a switch to a model whose window
Ordewell does not know, the planner no longer holds what the paused turn did. A
turn that only read files starts again from the conversation, its reads made
again. One that ran a command, read the web or started a task is not started
again from a note of what it did, since that could do it twice: Retry
compaction stays paused and lists what already ran. Switch to a model whose
window is known if you only switched models and the live context is still
there, or **Stop** and tell the planner where to pick up.

This needs the model's window: a model whose catalog states none gets no
automatic compaction. A refusal pauses it at once, and Retry compaction uses the
window the provider's refusal states. `/compact` still condenses on request. To
turn automatic compaction off, set `"plannerAutoCompaction": false` in the
global `settings.json` (`~/.ordewell/settings.json`). A harness planner (Claude
Code, Codex, OpenCode) compacts its own context, and is not affected.

## A task waits for your approval

A row reads **waits for your approval** and the scheduler skips it.

The planner added the task after you approved the plan, and autorun was off, so
nothing may start it until you approve it
([ADR-0035](adr/supervision/0035-effects-are-consented-and-recorded.md)). Approve it with
`f` in the terminal UI, `ordewell force-start <id>`, or its card in VS Code;
approve every waiting task with `/run` (or **Approve all** in VS Code). Neither
starts a task before its dependencies finish: it starts once they do, and the
answer says what it waits for. With nothing running, run the plan to start them.
With autorun on in Full nothing waits for you, script tasks included, and the
planner starts the plan or joins what runs without asking. With autorun on under
Guarded, tasks the planner adds in your turn need no approval, a script
task apart: it waits unless your effect allowlist covers every
command in it. Its row shows the commands or the script as written, so read it,
then approve it as above. With autorun off, a script task the planner adds in
the plan waits even when the allowlist covers it.

## Continue is not offered after moving a task to another runner

A saved session belongs to the runner that made it and cannot be opened by
another. Use Retry: it starts a fresh session on the new runner with the earlier
runner's files restored
([ADR-0041](adr/routing/0041-a-tasks-model-follows-the-runners-own-switch.md)).

## A task's model cannot be changed while it runs

Model and effort are locked while a task's runner is up, and so is its runner.
Stop the task, edit, and continue, or use the runner's own `/model` in the task's chat: the plan then
follows it. A model the runner changed by itself is stated in the task log and
is not written to the plan.

## A session is open in another Ordewell host

Loading a session shows **This session is open in another Ordewell host: … has
held it since …**, or **The Ordewell host that last ran this session … is gone,
but runners it started are still running**.

### Cause

One session is run by one host at a time
([ADR-0049](adr/isolation/0049-a-session-has-one-live-host.md)). Every TUI starts
a daemon of its own, and a VS Code window is a host too, so a second one in the
same checkout could otherwise run a session again beside the first, in the same
worktrees. The message names the host that has it: its kind, its pid, and since
when. The desktop app shows the same thing as a banner over a read-only session,
with **Take over…** when you want it there instead.

### Fix

Close the session in that host, or quit it, and load the session again. A host
that crashed or was killed lets the session go once its pid is gone, or a minute
after it last refreshed its lease.

Its runners stop by themselves within seconds of a host dying, so try again
first. If the message still names process groups, or you are on Windows, stop
them before loading again:

```bash
ps -eo pid,pgid,command | awk '$2 == <group>'   # what is still running in that group
kill -TERM -- -<group>
```

## The desktop app will not open

An unsigned build of the desktop app is not notarized by Apple and carries no
Windows code-signing certificate, so Gatekeeper and SmartScreen refuse its first
launch. Releases are unsigned until the project's signing credentials are
configured, and Linux builds always are. The unsigned macOS build is signed ad hoc, so the
system can start it once you allow it.

An app installed with the one-line script (`scripts/install/desktop.sh`) was
downloaded by `curl`, which leaves no quarantine attribute, so macOS may start
it without the prompts below. The script does not add or remove that attribute.

### Fix

- **macOS.** Right-click (or Control-click) Ordewell in Applications, choose
  **Open**, then **Open** again. If you already double-clicked, allow it from
  **System Settings › Privacy & Security › Open Anyway**, or clear the download
  flag:

  ```bash
  xattr -d com.apple.quarantine /Applications/Ordewell.app
  ```

  A dialog that says the app is **damaged** is the same quarantine flag; the
  command above fixes it.
- **Windows.** In SmartScreen, choose **More info**, then **Run anyway**.
- **Linux, from the AppImage.** Make it executable (`chmod +x Ordewell-*.AppImage`)
  and start it. On a distribution without FUSE 2, install `libfuse2`, or run it
  with `--appimage-extract-and-run`.

A signed release opens without these steps. When a release is signed, and how
to check one, is in
[Signed releases](desktop/README.md#signed-releases)
([ADR-0063 H9](adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).

## The desktop app cannot reach its daemon

The window shows a card over its content: **Port 3742 is taken**, **The daemon
refused this app**, **The daemon could not start**, or **Reconnecting to the
daemon…**.

### Cause

The app is a client of the local daemon on `127.0.0.1:3742`, and it either
attaches to one that already runs or starts the one it bundles
([ADR-0063](adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).
Each message names a different problem:

| Card | What happened |
|---|---|
| Port 3742 is taken | Something that is not an Ordewell daemon holds the port. |
| The daemon refused this app | No token file for that port, or one the daemon did not accept. The daemon may belong to another user or install. |
| The daemon could not start | Starting the bundled daemon failed; the card quotes why and names the log. |
| Reconnecting to the daemon… | An attached daemon went away. Nothing is restarted silently. |

### Fix

- **Another port.** Set `ORDEWELL_PORT` before launching the app, which is the
  same variable the CLI reads. A daemon the app starts then uses it too.
- **The token.** The daemon mints its token at startup in
  `~/.ordewell/server-<port>.token`. If that file belongs to another user, run
  the app as that user, or stop that daemon and let the app start its own.
- **The start failure.** Read `~/.ordewell/server.log`; the card names it too.
  Quitting the app and opening it again retries the probe.
- **Reconnecting.** Press **Retry now**, or **Start a daemon** when the port is
  free and the app did not own the one that went away. Runs in a daemon the app
  owned stop with it; a CLI daemon keeps them.

## The desktop app says the daemon is another version

The card reads **The running daemon is another version**, with both contract
numbers and versions.

### Cause

A daemon and a surface exchange a version and a contract number on
`GET /api/server` before the surface drives them
([ADR-0063](adr/surfaces/0063-the-desktop-app-is-an-electron-client-of-the-shared-daemon.md)).
The same contract attaches whatever the patch version; a different one means the
daemon or the app is from another release, and the app will not drive it.

### Fix

Press **Restart daemon**: the app stops that daemon and starts the bundled one,
which it then owns. The restart is refused while the daemon has a live run, and
the card names it; stop the run, or finish it from the CLI, and restart after.
If the daemon is one you want to keep, run the same release's CLI for it instead
of restarting: `ordewell stop --server` stops it in the same way the app does.

## The desktop app's terminal does not open

The terminal panel shows **Could not start …** with the shell's error, and no
prompt.

### Cause

The panel's PTY is `node-pty`, a native addon built for the app's Electron. A
build made without the rebuild — or a package whose unpacked copy is missing —
cannot load it, while the rest of the app works
([ADR-0062](adr/isolation/0062-user-git-actions-are-confirmed-at-a-host-and-a-live-run-holds-only-its-landing-branch.md),
G11).

### Fix

Use an installer from a release, or build one with `npm run desktop:package`:
electron-builder rebuilds `node-pty` for the app once per architecture. On
Linux that build needs `make`, `g++` and `python`. A development run
(`npm run desktop:dev`) uses the copy in `node_modules`, so run `npm install`
there if the package is missing.

The copy in `node_modules` is rebuilt in place, once per installer, so after a
`npm run desktop:package` it is the one for the last architecture packaged: on
Apple Silicon the build above leaves an x64 `pty.node`, and the next
`npm run desktop:dev` cannot load it. Rebuild it for the host's Electron with
`npx electron-rebuild -f -w node-pty`.

