# Running tasks in containers

> **Experimental, and off in published versions.** Containers are not ready: a
> published Ordewell ignores the `containers` setting below and says so once, and
> your tasks run in local worktrees as ever. The setting is read only in a build run
> from a git checkout of this repository, with `ORDEWELL_CONTAINERS=1` set.

A task's runner can do whatever you can do on your machine. A container takes that
away: a change task runs in a Docker container, on a copy of its worktree, with your
files out of its reach, a short list of hosts as its only way out, and your API key
left behind on your machine. Its work comes back through one checked route before it
lands on the run's integration branch.

This is opt-in. With the setting below absent, tasks run in local worktrees, as they
always have.

## What you need

Any engine the `docker` command talks to: Docker, or Colima on a Mac. Nothing is
mounted from your machine, so a VM's file sharing does not matter.

## Build the image

Ordewell publishes no image: Anthropic's terms say preinstalling or running Claude
Code in a product or service needs its Commercial Terms. You build your own from
[`task.Dockerfile`](../packages/core/docker/task.Dockerfile), and add your project's
toolchain to it:

```bash
docker build -t ordewell-task - < packages/core/docker/task.Dockerfile
```

An image of your own needs `git`, `node`, a user with uid 1000, and the folders
`/task`, `/mirror`, `/login` and `/caches/<name>` owned by that user.

## Choose a login

Which login you use is up to you, whether API usage or your own subscription, and so
are the terms that come with it: read your provider's. It has no default. In
`settings.json`:

```json
{
  "containers": {
    "image": "ordewell-task",
    "login": { "kind": "broker", "variables": ["ANTHROPIC_API_KEY"] }
  }
}
```

`broker` takes API keys or cloud credentials, by the name of the variable that holds
them in Ordewell's own environment. `ANTHROPIC_API_KEY` stays on your machine: its
model traffic goes through a gateway here, and the runner holds a token that means
nothing anywhere else. To send that traffic somewhere other than Anthropic's API, add
`ANTHROPIC_BASE_URL` to the variables. A cloud provider's credentials have to reach
its client, so a runner can read them and the task's report says so. Put that
provider's hosts in `allow`.

Ordewell never carries a Claude subscription's token, and refuses one that reaches it
as a variable. To use your subscription, sign in yourself, inside a container:

```bash
docker run --rm -it --init --pids-limit 8192 --memory 2g \
  -v ordewell-login-claude-code:/login \
  -e CLAUDE_CONFIG_DIR=/login/claude ordewell-task claude
```

Then set `"login": { "kind": "own-sign-in" }`. The sign-in stays in that volume, which
Ordewell mounts and never reads. A runner can read it too, and its traffic goes
straight to Anthropic, so `api.anthropic.com`, `claude.ai` and `platform.claude.com`
are opened for it.

## The other settings

| Setting | Default | |
| --- | --- | --- |
| `memory` | `"4g"` | The limit on memory and swap together, for every container of a task. A process past it is killed, and the task says so. |
| `caches` | `["npm"]` | Package caches kept in the engine between attempts: `npm`, `pip`, `cargo`, `go`. |
| `allow` | The registries of your `caches` | The hosts a task can reach, by name or as `*.example.com`. |
| `required` | `["fs.hostHidden", "fs.writeScope", "limits.memory", "net.allowlist", "net.noMetadata"]` | What must be proven as each container opens, or the task does not start. |

## What a task can reach

A task's container sits on an internal network with no route out. Beside it, one small
container, its sidecar, opens encrypted connections to port 443 of the hosts on the
list, and turns everything else down. A client that ignores it reaches nothing.

- **A host on the list is a way out.** Data can leave through any of them, a package
  registry included: a task can publish to one under an account of its own. Keep the
  list short, and set `"allow": []` for none, which leaves model traffic and nothing else.
- **What passes the sidecar is not read.** The list says where a connection goes, and
  no more. A CDN that serves a listed host may serve other sites on the same connection.
- **A name that resolves to a private address is turned down**, listed or not, so a
  registry on your own network cannot be reached.
- **Plain HTTP and SSH do not leave.** A `git` remote has to be `https`, with its host
  on the list.

If `net.allowlist` is taken out of `required` and the probe cannot prove it, Ordewell
says so as the first container opens.

## What it proves

Nothing here is declared. Each container runs a probe as it opens, and a guarantee in
`required` that the probe cannot prove stops the task:

| Guarantee | What the probe does |
| --- | --- |
| `fs.hostHidden` | Looks for a marker on your machine and the task's own path, and accounts for every mount. |
| `fs.writeScope` | Tries to write to the root filesystem and the mirror, and to the workspace. |
| `limits.memory` | Reads the limits from the container's own cgroup. |
| `net.allowlist` | Tries to reach the internet and a listener on your machine's loopback, directly and through the sidecar, and to resolve a name outside. All of it must fail. |
| `net.noMetadata` | Tries to reach a cloud metadata address, directly and through the sidecar. |
| `kernel.separate` | Compares the container's kernel with your machine's: true in a VM, not on Linux itself. |
| `cred.unreadable` | Looks for an API key the gateway holds in every environment the container can read. Not proven for `own-sign-in`, or for anything handed to a runner by name. |

## What runs where

- **In a container:** change tasks on Claude Code, script tasks, and in a delegated
  task, the tasks of its child plan and the repair of its conflicts.
- **On your machine, as ever:** planners, subplanners and read-only AI tasks. Their
  commands run sealed. A sealed command can run what a container wrote, inside that seal.
- **Refused, with the reason:** a task on another runner, an ops task on a runner, which
  works in your checkout, and a run without worktree isolation.

A setting Ordewell cannot use refuses every task rather than running it on your
machine instead. The setting is read once, as a session starts, for it and every
delegated task under it: changing it takes effect in the next session.

A session with containers runs git on your machine with hooks off, since a hook that
tests or lints would run what a container wrote. So that no check of yours goes
silently, a repository with hooks a landing would fire refuses every task instead:
remove them for that session. A worktree setup command is refused for the same reason.
Dependencies are the runner's to install inside the container, which is what the
caches are for.

`apply_patch` is not available in a container, and your workspace's own variables
(`.env`, `direnv`) do not reach one.

## Work that does not come back

A task's work comes back through a check as its attempt ends. Work that fails it lands
nothing: a bundle git will not take, a change to a hooks folder your repository tracks,
or more than one attempt's work should be. It stays in the task's volume, and the task
waits for you: a Continue or a start fails, saying why, rather than starting over that
work. Retrying the task gives the work up and starts it afresh.

## Script tasks

A script runs in a container, because what it runs over is what containers wrote. Its
exit status is its evidence, as it is on your machine, but a few things differ:

- It runs on a copy of what your checkout has committed, once its merge gate has let
  it start. Your uncommitted changes do not reach it.
- What it writes stays in its container. A script that changes your checkout passes
  with nothing changed, and Ordewell says so the first time.
- It holds no login, and none of your machine's credentials. A `git push` or a deploy
  fails. Run a step like that in a session without containers.
- A script body runs in the container's `sh`, with the image's toolchain. It has no
  `node_modules` of your machine's, so install what it needs as part of it.
- A read-only script has no network at all.

## Cleaning up

Closing a session stops its tasks and removes their containers, sidecars and networks,
and keeps each task's volume for a Continue.

Clean up, Discard and deleting a session take away what that session left in the
engine: its containers, networks and task volumes, and its pins in the repository's
mirror. Once no session of the project holds a pin, the mirror and its caches go too.
Your own sign-in volume is never touched.

Without the `containers` setting Ordewell does not ask Docker for anything, so if you
remove the setting first, clear what is left yourself. List it with:

```bash
docker volume ls --filter name=ordewell-
```
