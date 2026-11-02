# Running tasks in containers

> **Experimental, and off in published versions.** Containers are not ready: a
> published Ordewell ignores the `containers` setting below and says so once, and
> your tasks run in local worktrees as ever. The setting is read only in a build run
> from a git checkout of this repository, with `ORDEWELL_CONTAINERS=1` set, and the
> daemon is a process of its own, so it needs that variable as well as your shell.
> Delegation is held out the same way, by `ORDEWELL_DELEGATION=1`: a child plan's tasks
> run in containers only where both are on. [Checking it yourself](#checking-it-yourself)
> says what has been run so far, and what has not.

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
Code and Codex, and add your project's toolchain to it. For OpenCode, which is
MIT-licensed, add its package too:

```dockerfile
RUN npm install -g @opencode/cli
```

```bash
docker build -t ordewell-task - < packages/core/docker/task.Dockerfile
```

An image of your own needs `git`, `node`, a user with uid 1000, the folders `/task`,
`/mirror` and `/login` owned by that user, and the binary of every runner you assign
tasks to: `claude`, `codex` or `opencode`. A task whose image lacks its runner is
refused at start and says so: the runner's binary is asked of the image before its
worktree is made, and asked again in the container it runs in. For `own-sign-in` with
Claude Code it also needs a `claude` that has `claude auth status`, which is how
Ordewell asks whether a sign-in is held, and `sh`, `cat`, `cp` and `cksum`.

An image keeps the runners it was built with, and Docker reuses that step of the
build. For a newer one, add `--no-cache`. The versions last proven here are Claude Code
2.1.316, Codex 0.166.0 and OpenCode 2.2.5.

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

Name one login. `ANTHROPIC_API_KEY` beside `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` is
refused: Claude Code ranks those over the key, so a task would not run on the login
you meant.

Only an Anthropic key takes the gateway. An OpenCode task on another provider — an
OpenRouter key, say — has that key handed to the runner, so it can read it, and its
provider's hosts are opened for it. A model id whose provider Ordewell does not know
needs its hosts in `allow`.

Ordewell never carries a Claude subscription's token, and refuses one that reaches it
as a variable. To use your subscription, sign in yourself, inside a container, for the
runner you will assign:

```bash
# Claude Code
docker run --rm -it --init --pids-limit 8192 --memory 2g \
  -v ordewell-login-claude-code:/login \
  -e CLAUDE_CONFIG_DIR=/login/claude ordewell-task claude auth login

# OpenCode: its data directory holds every provider's login
docker run --rm -it --init --pids-limit 8192 --memory 2g \
  -v ordewell-login-opencode:/login \
  -e HOME=/login -e XDG_DATA_HOME=/login ordewell-task opencode auth login
```

It needs `-it`: without it, the command prints nothing and waits. It cannot open a
browser from a container, so open the address it prints on your machine, sign in there,
and paste the code you are given at its prompt. Starting and leaving it stores no
sign-in, and `ordewell containers` says so.

A Claude Console sign-in with no API key is kept outside that folder, so it goes with
the container. For Console usage, use an API key with `broker`.

Then set `"login": { "kind": "own-sign-in" }`. The sign-in stays in that runner's
volume, which no task mounts and Ordewell never reads on your machine. Its model
traffic and token refreshes go straight to the provider through the sidecar, not
through a gateway. A task gets a copy of its own, made in the engine as it first
starts, so what it writes there reaches neither the sign-in you made nor another task.
That covers writing, and no more:

- **A runner can read its copy**, and send it to any host a task can reach. Its traffic
  goes straight to the provider, so the hosts its login and its model need are opened
  for it — Anthropic's for Claude Code; OpenCode's own and the providers its login flow
  offers — and `cred.unreadable` is reported unproven. A provider outside that list
  needs its hosts in `allow`.
- **A copy stays in the task's volume** until its session is cleaned up, and signing out
  of the original does not reach it.
- **A check shows a sign-in is held, not that it still works.** `ordewell containers`
  and a task's start ask Claude Code, which answers from the files alone.
- **Every copy is one login.** A token a task refreshes stays in that task's copy, and
  nothing brings it back: that would be a way for one task to write what the next signs
  in with. So where refreshing replaces the token, the first task to refresh leaves the
  sign-in you made, and every other copy of it, dead. Tasks that run for long, or side
  by side, are steadier on an API key.

That last one was measured with Claude Code 2.1.316 against a stand-in for Anthropic
whose refresh tokens work once. People report that Anthropic's behave this way, and
Anthropic does not document it. Under the stand-in, the first task carried on, the next
failed with `OAuth session expired and could not be refreshed`, and Claude Code cleared
that task's copy. No real account took part, so how often it happens is not known.

When a sign-in has died, run the command above again. A task keeps the copy it has
until there is a new sign-in, which reaches it at its next start or Continue, with its
conversation kept.

A surface's check is satisfied when any runner holds a sign-in it can ask about; a task
asks for its own runner's at start, and refuses naming the one it needs.

### OpenCode

OpenCode's server is driven the same way as on your machine, but the host reaches it
through the lease's relay: it listens on the container's own loopback and no port is
published. Three things differ from Claude Code:

- **Only an Anthropic key is gated.** A broker login with `ANTHROPIC_API_KEY` points
  OpenCode's `anthropic` provider at the lease gateway. Any other provider's key is
  handed to the runner, and that provider's hosts are opened; a provider Ordewell does
  not know needs them in `allow`.
- **Its own sign-in is its whole data directory**, copied to the task's volume as it
  first starts. Every provider login it holds travels with it, and the hosts its login
  flow offers are opened. A provider outside that list needs its hosts in `allow`.
- **The model id is the plan's**, passed through unchanged; a model OpenCode's catalog
  does not list is refused by OpenCode at its first call, not by Ordewell.

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
- **`ordewell containers` shows only that the volume is there.** Codex has no way to
  say what it holds without its service, so what is in the volume is judged at a task's
  start, as above.
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
| `cred.unreadable` | Looks for an API key the gateway holds in every environment the container can read. Not proven for `own-sign-in` of any runner, for anything handed to a runner by name, or by `check`, which holds no login. |

## What nothing here proves

- **Tasks share a kernel.** On Linux it is your machine's. On a Mac it is the VM's, one
  for every task, so `kernel.separate` means separate from your machine, never from
  another task. A kernel flaw reaches every task on the engine. Docker Desktop and
  Colima both work this way, so a container here is not a boundary between tasks that
  a VM for each task would be.
- **A `unix://` socket is taken for an engine on this machine.** A socket forwarded from
  elsewhere looks the same.
- **Memory and process counts are limited, CPU and disk are not.** A task can fill the
  engine's disk or take its CPU.
- **`containers.memory` above what the engine has** starts and limits nothing, so it is
  refused. On a Mac that is the VM's memory, not the Mac's. Colima's VM starts smaller
  than the default limit: give it more, or lower `memory`.
- **The sidecar tries one address.** It connects to the first address a listed name
  resolves to and no other, so a name whose first answer has no route from your engine
  fails, even where a later answer would have worked.
- **A relay killed for memory reads as killed.** A task whose relay ran out of memory
  says it was killed, not why.

## Checking it yourself

These checks need this repository, since containers are held to a checkout. They are
for someone changing this code, or deciding whether to trust it on their machine.

### With a controlled model

This runs the container suites against the engine your `docker` command talks to, with
the real Claude Code, Codex and OpenCode in an image it builds, and a stand-in model on
your machine in place of each provider. It needs no key and no account, and it builds
a large image the first time:

```bash
npm ci
npm run test:containers
```

It ends by saying one of three things, and exits non-zero on the last two:

| Outcome | What it means |
| --- | --- |
| `VERIFIED` | Every test ran and passed, on this engine, and each harness's real binary was proven. |
| `FAILED` | A test failed. |
| `UNVERIFIED` | No engine answered, a test was skipped, or a real binary was not proven. A skipped test is never a pass, so nothing here reads as passing. |

CI runs this on Linux, in the `real-engine` job. It does not run on a Mac there, so on
a Mac it is yours to run. With Colima:

```bash
colima start --cpu 6 --memory 16     # what it was run at: Colima's default VM is smaller than a task's default limit
docker context use colima
npm run test:containers
```

With Docker Desktop, give it the same under *Settings → Resources*, then:

```bash
docker context use desktop-linux
npm run test:containers
```

It says which engine it ran against, so keep that line with the result. `--image <tag>`
(after `--`, through npm) uses an image you built, which must hold all three runners. A
run that is interrupted can leave volumes and networks behind, as
[Cleaning up](#cleaning-up) says.

### What has been run

Last run on 2026-11-02, with Claude Code 2.1.316, Codex 0.166.0 and OpenCode 2.2.5,
against controlled models only:

- **Colima on an Apple silicon Mac:** `VERIFIED`, nothing skipped.
- **A Linux engine nested in that Colima VM**, arm64, as a non-root user with a fresh
  install, the closest this could come to the CI job: `VERIFIED`, nothing skipped.

Not run, so not known:

- **The `real-engine` job on GitHub's runners**, which are amd64, until a push runs it.
- **Docker Desktop**, on any machine, and an Intel Mac.
- **A rootless engine**, and Podman.
- **Any real provider account**, on any runner: see below.
- **Windows** is refused, as above.

### With your own login

No automated check here holds a real account, so these are by hand. Each needs a
provider's own terms read first, and spends that account's usage. Run them in a
throwaway repository with one small change task, then read what each step says rather
than assuming it:

```bash
export ORDEWELL_CONTAINERS=1
ordewell containers on
ordewell containers image ordewell-task
```

1. **Claude Code, API key.** `ordewell containers login broker ANTHROPIC_API_KEY`, then
   `ordewell containers check`. Run the task. It should land, and `docker inspect` of
   its container, while it runs, should show no `ANTHROPIC_API_KEY`.
2. **Claude Code, your subscription.** Sign in as [Choose a login](#choose-a-login) says,
   then `ordewell containers login own-sign-in`. `ordewell containers` should say a
   sign-in is held. Run the task, and run a second one beside it: one failing with
   `OAuth session expired` is the one-login limit above, so note how long that took.
3. **Codex, API key.** `ordewell containers login broker OPENAI_API_KEY`. Give the task
   Full access. Started at Guarded, it should wait and say why, having asked the model
   nothing.
4. **Codex, a ChatGPT sign-in.** Sign in as [Codex](#codex) says. A real turn here is the
   thing not yet measured, so note whether it lands and when it stops working.
5. **OpenCode, an Anthropic key**, then **its own sign-in**, as [OpenCode](#opencode)
   says. A key should go through the gateway; a sign-in carries every provider it holds.

With delegation as well, `ORDEWELL_DELEGATION=1` and `ordewell delegation on`, one
delegated task should run its child plan's tasks in containers, and Stop and a Continue
should reach them.

### A child plan in a real VS Code window

The automated tests drive VS Code's host and its webview apart, so the two together are
by hand. In a checkout with `ORDEWELL_DELEGATION=1` set for the window, run a plan with
a delegated task whose child plan delegates again, then:

1. Open each child plan from its row, and read a task's log.
2. Answer a question from depth two, and see it lands on that plan.
3. Message a subplanner, and see the message stays with it.
4. Reload the window with a child's tab open. The child reads as ended, which is by
   design: a restart reopens nothing by reading it. Continue its task, and it comes back.

## What runs where

- **In a container:** change tasks on Claude Code and OpenCode, and on Codex at Full
  access, script tasks, and in a delegated task, the tasks of its child plan and the
  repair of its conflicts.
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

A mirror that stays busy through a clean-up is reported and left in place, and no later
clean-up takes it: remove it yourself with `docker volume rm` once nothing uses it.

Without the `containers` setting Ordewell does not ask Docker for anything, so if you
remove the setting first, clear what is left yourself. List it with:

```bash
docker volume ls --filter name=ordewell-
```
