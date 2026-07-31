# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[Security Advisories](https://github.com/ordewell/ordewell/security/advisories/new)
for this repository. That gives us a private thread and a CVE if one is warranted.

You can expect:

- An acknowledgement within **3 working days**.
- An assessment, with a fix or a rejection and the reasoning, within **14 days**.
- Credit in the advisory and the release notes, unless you'd rather not be named.

Please give us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

Ordewell is pre-1.0 and moves quickly. Only the latest released version is
supported; fixes ship forward rather than being backported.

## What is in scope

Ordewell runs on a developer's own machine and drives coding agents against
their own repositories. The parts most worth your attention:

- **The read-only exploration envelope.** The planner researches your workspace
  but must not write to it, and must not read outside it without asking. Any way
  to make the planner mutate the workspace, or silently reach outside it, is a
  vulnerability. The design is in
  [ADR-0008](docs/adr/0008-planner-exploration-envelope.md) and the classifier
  is `packages/core/src/services/commandPolicy.ts`.
- **Command policy bypass.** Prompt content that gets a would-be-refused command
  classified as safe.
- **The local API server.** `@ordewell/web` binds `127.0.0.1` and is
  unauthenticated by design, on the assumption that local access is trusted.
  Anything that makes it reachable off-host, or that lets a web page in a
  browser reach it (DNS rebinding, permissive CORS), is in scope.
- **Credential handling.** API keys are read from the environment and `.env`.
  Any path that writes a key to a log, an error message, a session file under
  `.ordewell/`, or a runner's argv is in scope.
- **Plugin manifests.** Runner plugins are installed from URLs and describe how
  to spawn a process. Injection through a manifest field is in scope.

## What is out of scope

- The behaviour of the coding agents Ordewell spawns (Claude Code, Codex,
  OpenCode). Report those to their maintainers.
- Ordewell executing a task you asked it to execute. Running agents against your
  code is the product, not a flaw — the boundary that matters is the *planner's*
  read-only envelope.
- Vulnerabilities in dependencies with no exploitable path through Ordewell.
  Send a PR bumping the dependency instead.
