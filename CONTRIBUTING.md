# Contributing to Ordewell

Thanks for considering it. Bug reports and small, focused pull requests are the
most useful things you can send.

## Before you start on something large

Open an issue first. Ordewell has opinions — about where logic lives, about what
counts as evidence that a task finished — and a PR that cuts against one of them
is a bad outcome for both of us. The [ADRs](docs/adr/README.md), grouped by area,
record most of those opinions, and [CONTEXT.md](CONTEXT.md) is the vocabulary
they're written in. If your change makes a decision they don't cover — hard to
reverse, surprising without context, a real trade-off — add an ADR in the same
pull request; the README says [what qualifies](docs/adr/README.md#should-this-be-an-adr)
and how to write one. A smaller change to a recorded decision edits that ADR.

Small fixes (a typo, a crash, an obviously-wrong branch) need no issue. Just
send them.

## Setup

Node.js **≥ 20** on Linux, macOS, or Windows.

```bash
git clone https://github.com/ordewell/ordewell.git
cd ordewell
npm install
npm run build
```

**Build order matters.** `core` must build before `cli`, `vscode` and `web`,
because the other three consume its emitted `dist/` types. `npm run build` does
them in the right order; if you build one package directly, build `core` first:

```bash
npm run build:core     # always first
npm run build:cli      # then whichever you're working on
```

Put the CLI on your PATH while you work on it:

```bash
npm link -w packages/cli
ordewell --help
```

For the VS Code extension, open the repo in VS Code and press `F5` to launch an
Extension Development Host.

## The checks

Everything CI runs, you can run in one go, in CI's order:

```bash
npm run ci
```

Or one check at a time:

```bash
npm run lint
npm run typecheck
npm test
```

Plus the offline end-to-end drive of the planner conversation loop, which needs
no API key and no network — it runs against a local mock model:

```bash
node bench/live/mock-provider.mjs &     # binds 127.0.0.1:3799
node bench/live/drive-conversation.mjs
```

If you change planner behaviour, run that. It is the fastest way to find out
that a prompt edit broke plan emission.

## Layout

```
packages/
├── core/    Pure TypeScript, zero UI dependencies. Session, PlanStore, Planner,
│            TaskOrchestrator, VerdictEngine, ModelResolver, ModeResolver.
├── cli/     The `ordewell` binary, and tui/ — a pure state reducer and
│            renderer behind a thin raw-mode terminal driver.
├── cli-alias/  Seven lines. Publishes the unscoped `ordewell` package, which
│            just requires @ordewell/cli. Not an npm workspace: the VS Code
│            extension is also named `ordewell` (its Marketplace id is
│            publisher.name = ordewell.ordewell) and npm refuses two
│            workspaces with one name. Install and publish it directly.
├── vscode/  Extension host + React webview.
└── web/     Hono HTTP + WebSocket server. This is the local daemon the CLI and
            TUI talk to over 127.0.0.1 — not a website.
bench/       Offline dev harnesses. Zero dependencies, pure Node.
docs/adr/    Architecture decisions by area, including the ones that were rejected.
```

## Adding a runner

A built-in runner is declared in two places, and every surface — the runner
and planner pickers, `ordewell runners`, help text, model discovery, the VS Code
setting check — reads them. If a runner is missing from a surface, the fix is
not an edit to that surface.

1. **The manifest.** Add `packages/core/src/plugins/builtin/<id>.manifest.ts`
   and list it in `BUILTIN_MANIFESTS` (`plugins/builtin/index.ts`). It names
   the runner (`name` is its id, `displayName` is what every surface shows),
   its command, its modes mapped onto the mode axis, and how its models are
   discovered. List order is picker order. A parser too specific for the
   shared ones is a function in its own file beside the manifest, referenced
   from `modelDiscovery`, not a new name in a shared union.
2. **The connector.** Add the runner's entry to `CONNECTORS`
   (`services/harness/connectors.ts`): the adapter that drives it over its
   programmatic protocol, how it is handed the Ordewell MCP server (ADR-0022),
   and what it would load from a repository (ADR-0028). Having a connector is
   what lets a runner run tasks (ADR-0018), and its `plans` what lets it plan
   (ADR-0009). A usage-limit reader is optional: add `usageLimitReset` only if the runner prints a time.
3. **The tests.**
   - Copy `plugins/__tests__/declaringABuiltinRunner.test.ts` to see the
     contract: a fake runner declared at those two places must show up
     everywhere with nothing else edited. If your runner needs an edit
     elsewhere to appear, that is a bug in the seam; raise it in the issue.
   - Run the connector contract tests
     (`services/__tests__/runnerConnectors.contract.test.ts`) against your
     adapter, and give the adapter its own tests with a fake binary.
   - `npm run ci`.

There is no list to extend in `cli`, `vscode` or `web`. Two runner ids appear
there on purpose and are not a place to add yours: the default runner
(`DEFAULT_RUNNERS`, a product choice), and the legacy per-runner VS Code and
environment toggles, which are migration code for three settings that were
never extended. The `web_search:<provider>` names in the allowlist grammar are
search providers, not runner ids.

### Validate against the real binary first

Before committing to a transport, run the agent's real binary and record what
you saw in the issue. Documentation drifts from the program; ADR-0009's
corrections (Codex's method names, `--verbose`, OpenCode's echo) are what this
catches.

- **Headless transport.** Which programmatic mode, its input and output
  framing, and what happens with no TTY (is stdout dropped?).
- **Empty success.** Whether a turn can report success with an empty response.
- **Multi-turn.** Whether one session takes several turns of input.
- **Interrupt.** Whether a turn can be stopped without ending the session.
- **Approvals.** Whether permission requests arrive as structured events that
  can be answered, since the approval cards depend on them.
- **Usage.** Whether usage is reported, and in what units.
- **Resume.** Whether a session id lets a later process resume it, including
  whether a resumed session starts clean or reports a stale interruption.
- **MCP.** Whether it accepts MCP server configuration on the command line or
  in a per-session file, which is how it receives the Ordewell tools.
- **Read-only.** That read-only is enforced at spawn for a planner, not
  requested in the prompt (ADR-0009).
- **Installation.** The version probe, and what a missing binary looks like.
- **Models.** Whether it lists its own models; if not, the discovery source
  and fallback list the manifest carries (ADR-0004).

If the agent is closed source or auth-bundled, say so in the issue: the
planner must fail before the goal is typed when the agent is unusable.

### An ACP runner

An agent that ships its own Agent Client Protocol server needs no adapter:
`AcpAdapter` drives every ACP runner, and what differs between agents is an
`AcpProfile` (ADR-0060). Five are admitted: GitHub Copilot CLI
(`copilot-cli`), Qwen Code (`qwen-code`), Cline (`cline`), Gemini CLI
(`gemini-cli`) and Cursor (`cursor-agent`). Copilot CLI is the reference: read
`plugins/builtin/copilot-cli.manifest.ts` and
`services/harness/copilotProfile.ts` before writing yours. Read
`services/harness/clineProfile.ts` too if your agent takes MCP servers only
from a settings file of its own, connects to them only on its first turn,
ignores over ACP the login its own CLI stored, or has no list that takes its
own tools away. Read
`services/harness/geminiProfile.ts` if it names a tool only in its call ids,
connects MCP servers only in a folder it trusts, or is restricted by a policy
file of its own. Read
`services/harness/cursorProfile.ts` if its first report of an MCP call does not
name the tool, or it reports no version: a profile then sets no `minVersion`,
since the check refuses an agent that does not say its version. Read it too if
the only list that takes your agent's own tools away is a settings file in its
home of configuration.

- **Native servers only.** The agent's own maintainers must ship its ACP
  server. A third-party shim in front of an agent does not qualify
  (ADR-0060 R2).
- **The manifest** is written the same way as any runner's, as in step 1 above.
  `name` is the runner id, and it shares the planner setting's namespace with
  the API vendors' ids in `services/apiProviders.ts`, so it must not equal
  one of them: `kimi-cli`, not `kimi`.
- **The profile** goes in `services/harness/<id>Profile.ts`, and its connector
  entry is `CONNECTORS['<id>'] = acpConnector(PROFILE)`. It is data: the ACP
  arguments, the `minVersion` you checked where the agent reports one, how
  the agent names Ordewell's tools, how a model reaches it, and the routes its
  instructions and modes take. A behaviour your agent needs becomes a profile field any agent can
  use, never a branch on a runner id in the adapter. Instructions go through
  the agent's own channel outside the worktree, or else as a preamble on the
  first prompt; never as a file in the worktree. The agent must advertise
  `mcpCapabilities.http`, or load MCP servers from a settings file of its own
  that an environment variable can name. Ordewell has no stdio bridge, and an
  agent with neither is refused. For the second, set `mcpConfig`: the
  adapter writes the file per process, owner-only, outside the worktree, and
  removes it with the process. A recording must show the agent connecting from
  that file, and the attach is still judged by the server, so an agent that
  ignores the file is refused (ADR-0060 R4). Such a runner cannot run in a
  container. An agent that connects only once a prompt runs sets
  `attach: 'firstTurn'` (R5), and its first turn, a task's prompt or a
  planner's goal, is then the attach check; one that needs its provider key
  in its environment, or can take the key configured in Ordewell, sets
  `credentials`, and `signInRoute` where the agent's own refusal should name
  that route too (R9). Cline's recordings show all three.
- **Recorded fixtures.** Record every line each side sent in a live run as JSONL
  under `services/__tests__/fixtures/acp/<id>/`, as `{dir, ms, line}`, with
  `dir: "note"` lines for the spawn arguments and for what the run left behind.
  Copilot's recordings show what to cover: discovery, signed out, allow-all,
  an edit and a command asked for, an Ordewell tool call, a cancel, and each
  restricted start. Replay
  them against a live adapter as `copilotCli.test.ts` does. Every claim the
  profile makes about the agent cites a recording. Add the runner to the fakes
  in `services/__tests__/fakeRunners.ts` and to the contract tests' tables.
- **Roles need evidence.** With no `roles`, the runner gets writable tasks
  only. To claim the planner role or a read-only mode (ADR-0060 R3), you need
  all three of these:
  - a `restricted` control that takes the agent's own write and shell tools
    away, as Cursor's deny list in a settings file of the start's own does,
    or, where the agent has no list to take them from, makes it ask before
    every use, as Qwen Code's `--approval-mode default` and Cline's
    `--auto-approve false` do; either shown to hold under ACP;
  - Ordewell's refusal of every edit, delete, move and execute request, which
    the adapter already does;
  - a recording of a write attempt and a shell attempt refused, with nothing
    left behind.

  A planner or a read-only task must also run nothing the repository's config
  names (ADR-0028). An agent that loads hooks or config from the directory it
  starts in, with no switch to stop it, sets `restricted.privateCwd`, as
  Copilot does: it then starts in a private directory of its own and asks for
  every path in the worktree. Record a hook planted in the worktree running on
  a writable start and not on a restricted one, as Copilot's
  `repo-hooks.jsonl`, `planner.jsonl` and `read-only.jsonl` do, Qwen Code's,
  Gemini CLI's and Cursor's `planted-hook.jsonl`, and Cline's
  `repo-hooks.jsonl` and `read-only-hooks.jsonl`. A variable that moves the agent's config home is
  not that switch unless a recording shows it: Cline's `CLINE_DIR` left the
  worktree's hooks running (`repo-hooks-cline-dir.jsonl`).

  An agent made to ask before every use of its tools leaves the adapter to
  refuse each by its kind, a request to switch modes included, and the
  recordings must show it. Never claim a role through the agent's own plan or
  read-only mode if a request to switch modes leaves it, and record that mode
  rather than trust its name: Gemini CLI's own plan mode refused Ordewell's
  tools and let the model write a `.md` file. An agent that defers MCP tools
  until the model loads them names its loading tool in
  `restricted.toolSearch`, so a restricted start's prompt says to load each
  Ordewell tool first.

  An agent with no deny flag, whose controls are a settings file or a hook,
  is handed them in `restricted.files`: each is written 0600 into that
  private directory and named to the agent by a variable, a flag, or another
  of the files. Render each from the directory's path alone, with no key or
  token in it, and name a script's interpreter in the setting that runs it,
  since nothing there is executable. List in `restricted.configDirs` the
  variables that move the agent's config home, so the user's global rules,
  hooks and skills do not load; a file named `<VARIABLE>/<file>` is written
  inside that home, as Cursor's `CURSOR_CONFIG_DIR/cli-config.json` is. Both
  are a layer under Ordewell's refusal by kind, and the role still needs the
  recording above. An agent that refuses a denied tool without asking, as
  Cursor does, sends Ordewell no request to refuse, so its recordings must show
  the refusal in its own words and nothing left behind; deny its reads too if
  its own reads reach past the directory it starts in.

  An agent whose own policy file can deny its tools, as Gemini CLI's can, is
  handed that file in `restricted.files` at every tier it reads one from the
  command line, so a rule the person saved cannot outrank it. The refusal
  must reach the transcript: a rule that hides a tool from the model leaves
  no call to record, so Gemini's rules match every call instead
  (`argsPattern = "."`) and each is refused as a failed tool call. Name
  Ordewell's tools in full, as the agent names them, where it checks an MCP
  call under more than one server name.

## Releasing

Releases are driven by a version tag. Bump every package to the same version
(`cli-alias` pins `@ordewell/cli` exactly), move each changelog's
`[Unreleased]` entries under the new version (`CHANGELOG.md`, and
`packages/vscode/CHANGELOG.md`, which ships in the extension and keeps only
what a VS Code user sees), commit as `release: X.Y.Z`, then:

```bash
git tag v0.4.6 && git push origin v0.4.6
```

The tag triggers `.github/workflows/release.yml`, which first runs the full CI
workflow — every check, the real engine included — so a tag cannot publish a
commit that has not passed all of them. The publish jobs then verify the tag
matches every `package.json`, build and test, then:

- **npm**: publishes in dependency order — `core`, `web`, `cli`, then
  `cli-alias` (not a workspace — see Layout) — each one's `dependencies` must
  already resolve on the registry when it lands.
- **VS Code**: packages the extension, publishes it to the Marketplace, then
  publishes the same `.vsix` to Open VSX so Cursor, VSCodium and Windsurf never
  lag a release.

Secrets required: `NPM_TOKEN` (npm publish access), `VSCE_PAT` (Marketplace
scope) and `OVSX_PAT` (an Open VSX access token). The Open VSX step fails the
job when `OVSX_PAT` is unset, after npm and the Marketplace are already
published — set it before tagging. `prepublishOnly` rebuilds each npm package
first, so `dist/` can never be stale. Versions on npm are immutable — bump
carefully, and keep all versions in lockstep.

## House style

- **No `any`.** The codebase went through a deliberate sweep to remove it; please
  don't reintroduce it. Reach for `unknown` and narrow.
- **Comment the *why*, never the *what*.** Match the density of the file you're
  editing. A comment explaining that a loop iterates will be removed.
- **Deep modules.** One module owns one concept end to end, with a narrow
  interface. If you find yourself threading a flag through four layers, the seam
  is in the wrong place — say so in the issue.
- **Verdicts come from evidence.** A task completes when the runner calls
  `task_complete` bound to the attempt's token. Never make the model the
  tie-breaker.

## Pull requests

- Branch from `main`.
- Keep the diff to one concern.
- While iterating, `npm run test:changed` runs only the tests affected by your
  uncommitted changes (`npm run test:quick` skips the slow real-git e2e files).
  Neither replaces the full suite: make sure
  `npm run ci` passes before pushing. It runs every step of CI's workflow
  locally, the full suite with its per-file coverage floors included.
- CI on a pull request runs what the change can reach (`scripts/change-scope.mjs`):
  a package and those built on it, and everything for a path it cannot judge. A
  docs-only change runs the verify scripts and repository-wide guards. A push to
  `main` and a release tag always run everything. `Required checks` is the one status
  to look at: it fails if a job skipped anything the change owed.
- If you changed anything a container runs, `npm run test:containers` runs the real
  harnesses in a real engine. It needs Docker and builds a large image, so `npm run ci`
  leaves it out and CI's `real-engine` job runs it, on a pull request whenever core
  changed. A skipped test there is not a pass:
  [docs/containers.md](docs/containers.md#checking-it-yourself) says what it reports.
- Describe what you changed and why. If it changes behaviour a user can see, say
  what they'll notice.

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, the same as the rest of the project. Contributors are
credited in [AUTHORS.md](AUTHORS.md).

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
