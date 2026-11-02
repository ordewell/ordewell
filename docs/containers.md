# Running tasks in containers

> **Experimental, and off in published versions.** Containers are not ready: a
> published Ordewell ignores the `containers` setting below and says so once, and
> your tasks run in local worktrees as ever. The setting is read only in a build run
> from a git checkout of this repository, with `ORDEWELL_CONTAINERS=1` set, and the
> daemon is a process of its own, so it needs that variable as well as your shell.

A task's runner can do whatever you can do on your machine. A container takes that
away: a change task runs in a Docker container, on a copy of its worktree, with your
files out of its reach, a short list of hosts as its only way out, and your API key
left behind on your machine. Its work comes back through one checked route before it
lands on the run's integration branch.

This is opt-in. With the setting below absent, tasks run in local worktrees, as they
always have.

## What you need

The `docker` command and a Docker engine running on this machine, on Linux or on a Mac
with Docker Desktop or Colima. Nothing is mounted from your machine, so a VM's file
sharing does not matter.

Turning containers on asks for that and nothing else, and refuses, saying what to do,
without it. Refused as well:

- an engine elsewhere, by a `docker context` or `DOCKER_HOST` that is not a `unix://`
  socket: the proofs below try your machine's paths and loopback, which mean nothing
  on another machine;
- Windows, and an engine running Windows containers, neither of which has been proven;
- an engine on cgroup v1, since the memory limit is proven on cgroup v2.

## Set it up

The `ordewell containers` command works in steps, and the image and login can follow
once containers are on. A task will not start until all of it is there, and nothing
runs on your machine in its place.

```bash
ordewell containers on                     # needs a Docker that answers
ordewell containers image ordewell-task
ordewell containers login own-sign-in      # or: login broker ANTHROPIC_API_KEY OPENAI_API_KEY
ordewell containers                        # where it stands; starts nothing
ordewell containers check                  # starts a throwaway container and reports what it proved
ordewell containers off
```

In VS Code it is **Ordewell: Containers (experimental)**, shown when the window itself
has `ORDEWELL_CONTAINERS=1`. Both write the same `settings.json`. `off` removes the
whole setting, so the image and login chosen go with it.

`check` exits non-zero if a task could not start, and says what stands in the way. It
keeps apart what its container proved and what is assumed. Proving is not a promise:
each container proves itself again as it opens, and the engine, image and login are
asked again each time a task starts.

## Build the image

Ordewell publishes no image: Anthropic's terms say preinstalling or running Claude
Code in a product or service needs its Commercial Terms. You build your own from
[`task.Dockerfile`](../packages/core/docker/task.Dockerfile), which installs Claude
Code and Codex, and add your project's toolchain to it:

```bash
docker build -t ordewell-task - < packages/core/docker/task.Dockerfile
```

An image of your own needs `git`, `node`, a user with uid 1000, the folders `/task`,
`/mirror` and `/login` owned by that user, and the runner a task uses: `claude` or
`codex`. A task whose image lacks its runner refuses at start and says so. Rebuild
for a newer runner: Codex 0.166.0 is the version proven here.

## Choose a login

Which login you use is up to you, whether API usage or your own subscription, and so
are the terms that come with it: read your provider's. It has no default. The steps
above leave this in `settings.json`:

```json
{
  "containers": {
    "image": "ordewell-task",
    "login": { "kind": "broker", "variables": ["ANTHROPIC_API_KEY"] }
  }
}
```

`broker` takes API keys or cloud credentials, by the name of the variable that holds
them in Ordewell's own environment. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` stay on
your machine: a task's model traffic goes through a gateway here, and the runner holds
a token of that task's that means nothing anywhere else. A task gets the key for its
own runner and not the other's, and refuses at start if the login holds none. To send
that traffic somewhere other than the provider's API, add `ANTHROPIC_BASE_URL` or
`OPENAI_BASE_URL` to the variables. A cloud provider's credentials have to reach its
client, so a runner can read them, and `cred.unreadable` is reported unproven. Put that
provider's hosts in `allow`.

Ordewell never carries a Claude subscription's token, and refuses one that reaches it
as a variable. To use your subscription, sign in yourself, inside a container:

```bash
docker run --rm -it --init --pids-limit 8192 --memory 2g \
  -v ordewell-login-claude-code:/login \
  -e CLAUDE_CONFIG_DIR=/login/claude ordewell-task claude
```

Then set `"login": { "kind": "own-sign-in" }`. The sign-in stays in that volume, which
no task mounts and Ordewell never reads on your machine. A task gets a copy of its own,
made in the engine as it starts, so what it writes there reaches neither the sign-in you
made nor another task. That covers writing, and no more:

- **A runner can read its copy**, and send it to any host a task can reach. Its traffic
  goes straight to Anthropic, so `api.anthropic.com`, `claude.ai` and
  `platform.claude.com` are opened for it, and `cred.unreadable` is reported unproven.
- **A copy stays in the task's volume** until its session is cleaned up, and signing out
  of the original does not reach it.
- **A token a task refreshes stays in that copy.** If refreshing replaces the token, the
  one you made can go stale, and you sign in again. This has not been measured.

### Codex

An API key is the login to use for Codex: `login broker OPENAI_API_KEY`, as OpenAI
itself recommends for automation. Your key stays on your machine.

A ChatGPT sign-in works differently, and is less proven. Make it inside a container,
with its credentials in a file, not a keyring:

```bash
docker run --rm -it --init -v ordewell-login-codex:/login -e CODEX_HOME=/login/codex \
  ordewell-task sh -c 'mkdir -p /login/codex && codex -c cli_auth_credentials_store=file login --device-auth'
```

Device sign-in has to be turned on in your ChatGPT security settings or workspace
permissions. Then set `"login": { "kind": "own-sign-in" }`. A task refuses at start if
what it finds is an API key, or has expired, or holds no tokens. All of the above holds,
with these differences:

- **A task's copy holds no refresh token.** Refresh tokens rotate, so one spent by a
  copy would end the sign-in for every other, and OpenAI says not to share an
  `auth.json` across concurrent jobs. Each task gets the access token alone, for as long
  as it lasts.
- **Nothing renews your sign-in.** Ordewell does not refresh it, and no task can. When
  it runs out, a task refuses at start, or fails where a long one outlives it, and you
  sign in again. How long that takes depends on your account.
- **A runner can read that access token**, and send it to any host a task can reach.
  `chatgpt.com` is opened for it, `auth.openai.com` is not, and `cred.unreadable` is
  reported unproven.
- **It has not been run against OpenAI's service.** A task's copy was taken through a
  starting Codex with stand-in tokens, but a real turn on a ChatGPT account has not been
  measured. OpenAI's guide for `auth.json` in automation does not
  describe a copy like this one: it covers trusted private runners, and says not to
  use it for public or open-source repositories. Read it first:
  [Maintain Codex account auth in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

A ChatGPT Enterprise workspace's Codex access token (`CODEX_ACCESS_TOKEN`) is not
supported yet: a broker login refuses a Codex task that names it without
`OPENAI_API_KEY`.

## The other settings

| Setting | Default | |
| --- | --- | --- |
| `memory` | `"4g"` | The limit on memory and swap together, for every container of a task. A process past it is killed, and the task says so. |
| `caches` | `["npm"]` | Package caches kept in a task's own volume between its attempts: `npm`, `pip`, `cargo`, `go`. No two tasks share one, so each task downloads for itself. |
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
`required` that the probe cannot prove stops the task. A session says once what its
first container proved:

| Guarantee | What the probe does |
| --- | --- |
| `fs.hostHidden` | Looks for a marker on your machine and the task's own path, and accounts for every mount. |
| `fs.writeScope` | Tries to write to the root filesystem and the mirror, and to the workspace. |
| `limits.memory` | Reads the limits from the container's own cgroup. |
| `net.allowlist` | Tries to reach the internet and a listener on your machine's loopback, directly and through the sidecar, and to resolve a name outside. All of it must fail. |
| `net.noMetadata` | Tries to reach a cloud metadata address, directly and through the sidecar. |
| `kernel.separate` | Compares the container's kernel with your machine's: true in a VM, not on Linux itself. |
| `cred.unreadable` | Looks for an API key the gateway holds in every environment the container can read. Not proven for `own-sign-in` of either runner, for anything handed to a runner by name, or by `check`, which holds no login. |

## What nothing here proves

- **Tasks share a kernel.** On Linux it is your machine's. On a Mac it is the VM's, one
  for every task, so `kernel.separate` means separate from your machine, never from
  another task. A kernel flaw reaches every task on the engine.
- **A `unix://` socket is taken for an engine on this machine.** A socket forwarded from
  elsewhere looks the same.
- **Memory and process counts are limited, CPU and disk are not.** A task can fill the
  engine's disk or take its CPU.
- **`containers.memory` above what the engine has** starts and limits nothing, so it is
  refused. On a Mac that is the VM's memory, not the Mac's.

## What runs where

- **In a container:** change tasks on Claude Code, and on Codex at Full access, script
  tasks, and in a delegated task, the tasks of its child plan and the repair of its
  conflicts.
- **On your machine, as ever:** planners, subplanners and read-only AI tasks. Their
  commands run sealed. A sealed command can run what a container wrote, inside that seal.
- **Refused, with the reason:** a task on another runner, a Codex task at Guarded, an
  ops task on a runner, which works in your checkout, and a run without worktree
  isolation.

Codex's Guarded mode is its own sandbox, which needs namespaces a hardened container
does not give, and loosening the container would give up more than that sandbox adds.
So a change task on Codex asks for Full access in a container. There the container is
what holds it: Full access switches off Codex's sandbox, not the limits on this page.
Ordewell does not change a task's mode for you. A Codex task planned at Guarded, which
is what a plan gets until you choose `/auto full`, waits with the reason and asks the
model nothing: give it Full access or another runner, and start it again.

A setting Ordewell cannot use refuses every task rather than running it on your
machine instead. The setting is read once, as a session starts, for it and every
delegated task under it: changing it takes effect in the next session.

A session with containers runs git on your machine with hooks off, since a hook that
tests or lints would run what a container wrote. So that no check of yours goes
silently, a repository with hooks a landing would fire refuses every task instead:
remove them for that session. A worktree setup command is refused for the same reason.
Dependencies are the runner's to install inside the container, which is what a task's
cache is for.

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
mirror. Once no session of the project holds a pin, the mirror goes too, with any cache
volume an earlier build left. Your own sign-in volume is never touched.

Without the `containers` setting Ordewell does not ask Docker for anything, so if you
remove the setting first, clear what is left yourself. List it with:

```bash
docker volume ls --filter name=ordewell-
```
