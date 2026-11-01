# Running tasks in containers

A task's runner can do whatever you can do on your machine. A container takes your
files out of its reach: a change task runs in a Docker container, on a copy of its
worktree, and its work comes back through one checked route before it lands on the
run's integration branch.

This is opt-in. With the setting below absent, tasks run in local worktrees, as they
always have.

> **A container does not limit the network yet.** It hides your files from a runner,
> not the internet from it, and a runner can still reach services on your machine's
> loopback through the engine's default network. Ordewell says so as the first
> container opens. Do not rely on it to keep a secret in the repository from leaving.

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

A person chooses this, and it has no default. In `settings.json`:

```json
{
  "containers": {
    "image": "ordewell-task",
    "login": { "kind": "broker", "variables": ["ANTHROPIC_API_KEY"] }
  }
}
```

`broker` hands the container API keys or cloud credentials, by the name of the
variable that holds them in Ordewell's own environment. A runner can read a key
handed over this way, and the task's report says so.

Ordewell never carries a Claude subscription's token, and refuses one that reaches it
as a variable. To use your subscription, sign in yourself, inside a container:

```bash
docker run --rm -it --init --pids-limit 8192 --memory 2g \
  -v ordewell-login-claude-code:/login \
  -e CLAUDE_CONFIG_DIR=/login/claude ordewell-task claude
```

Then set `"login": { "kind": "own-sign-in" }`. The sign-in stays in that volume, which
Ordewell mounts and never reads. A runner can read it too. Check Anthropic's terms for
your use before relying on this.

## The other settings

| Setting | Default | |
| --- | --- | --- |
| `memory` | `"4g"` | The limit on memory and swap together. A process past it is killed, and the task says so. |
| `caches` | `["npm"]` | Package caches kept in the engine between attempts: `npm`, `pip`, `cargo`, `go`. |
| `required` | `["fs.hostHidden", "fs.writeScope", "limits.memory"]` | What must be proven as each container opens, or the task does not start. |

## What it proves

Nothing here is declared. Each container runs a probe as it opens, and a guarantee in
`required` that the probe cannot prove stops the task:

| Guarantee | What the probe does |
| --- | --- |
| `fs.hostHidden` | Looks for a marker on your machine and the task's own path, and accounts for every mount. |
| `fs.writeScope` | Tries to write to the root filesystem and the mirror, and to the workspace. |
| `limits.memory` | Reads the limits from the container's own cgroup. |
| `kernel.separate` | Compares the container's kernel with your machine's: true in a VM, not on Linux itself. |
| `net.noMetadata` | Tries to reach a cloud metadata address. |
| `cred.unreadable` | Looks for what its runner could read. Not proven for any login above. |
| `net.allowlist` | Never proven yet. Requiring it stops every task. |

## What runs where

- **In a container:** change tasks on Claude Code.
- **On your machine, as ever:** planners, read-only tasks under their seal, script
  tasks and subplanners. A script that runs your project's code runs what a container
  wrote, on your machine.
- **Refused, with the reason:** a task on another runner, an ops task, which works in
  your checkout, and a run without worktree isolation.

A setting Ordewell cannot use refuses every task rather than running it on your
machine instead. So does a repository with git hooks that a landing would fire, since
they would run what a container wrote, and a worktree setup command for the same
reason: remove or unset it for that session. Dependencies are the runner's to install
inside the container, which is what the caches are for.

`apply_patch` is not available in a container, and your workspace's own variables
(`.env`, `direnv`) do not reach one.
