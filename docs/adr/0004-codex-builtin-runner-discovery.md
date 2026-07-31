# 0004 — Codex as a built-in runner; model discovery via `codex app-server`

**Status:** accepted

Codex CLI joins Claude Code and OpenCode as a third built-in runner (`BUILTIN_MANIFESTS`
order: claude-code, codex, opencode — insertion order is picker order). Codex has no
`codex models` subcommand, so the existing `discoveryCommands` (exec + parse stdout)
mechanism cannot discover its catalog. We decided to discover via the **`codex
app-server` stdio JSON-RPC protocol** (`initialize` → `model/list`), falling back to
reading `$CODEX_HOME/models_cache.json` (the same catalog, written by Codex itself),
falling back to hardcoded `fallbackModels` in the manifest.

## Key properties

- **app-server is the primary source.** `model/list` returns the live catalog — id,
  display name, `hidden` flag, `defaultReasoningEffort`, per-model
  `supportedReasoningEfforts` — exactly the `DiscoveredModel` + variants shape Ordewell
  needs. It is the same interface OpenAI's own VS Code extension drives, and the CLI
  ships `generate-ts` / `generate-json-schema` for it, so it is de-facto supported even
  though flagged `[experimental]`.
- **Two fallbacks because the protocol is experimental.** If the JSON-RPC handshake
  breaks on a Codex release, discovery degrades to the on-disk cache file (fresh as of
  the user's last Codex run) rather than straight to a stale hardcoded list. The
  hardcoded list only surfaces on a machine where Codex is installed but has never run
  and the app-server call failed.
- **A new injectable seam, not a new parser.** The stdio JSON-RPC client lives behind an
  injectable implementation in `ModelDiscovery` (like `ExecImpl`), so tests never spawn
  a real app-server. `discoveryCommands`' exec-and-parse contract is untouched.
- **`hidden: true` models are filtered** (e.g. `codex-auto-review`) — they are internal
  to Codex, not assignable executor models.
- **`ultra` joins `EFFORT_LADDER` above `max`.** Codex advertises an `ultra` reasoning
  effort; the shared ladder gains the rung so `clampThinkingEffort` ranks it instead of
  snapping it away. Models without `ultra` still clamp a planner-emitted `ultra` down to
  `max` — per-model variants remain the truth.
- **Reasoning effort has no dedicated CLI flag** — it is passed as
  `-c model_reasoning_effort=<level>`, emitted by a new `{{feature:…}}` token in
  `resolveArgs` (the `resolveClaudeThinkingFlags` precedent; whole-token substitution
  means the template cannot inline `{{thinkingEffort}}` into a compound arg).
- **Modes mirror Claude Code's shape**: `agent` (safe → `--sandbox workspace-write`),
  `plan` (→ `--sandbox read-only`), `fullAccess` (autonomous → `--sandbox
  danger-full-access`), mapped through `permissionModeValues`. `codex exec` is
  non-interactive and has no approval flag, so the sandbox axis is the entire permission
  story for headless runs.

## Considered options

- **Hardcoded model list only.** Rejected: goes stale on every OpenAI model release —
  the exact staleness failure mode already documented for opencode discovery.
- **Read `models_cache.json` as the primary.** Rejected as primary (kept as fallback):
  the cache exists only after Codex itself has run at least once; a fresh install would
  silently show the stale hardcoded list even though a live fetch was available.
- **Replicate the ChatGPT-backend models HTTP endpoint** (auth from
  `~/.codex/auth.json`). Rejected: reverse-engineered and unversioned — strictly worse
  than the app-server protocol, which is at least schema-published by the CLI itself.
- **Approval-policy modes** (`untrusted`/`on-request`/`never` as distinct Ordewell
  modes). Rejected: 6+ modes bloat the planner's mode guide, and the flags don't exist
  on `codex exec`, so headless tasks could never honor them.

## Consequences

- `PluginModelDiscovery` grows an app-server discovery description (command + list
  method) alongside `discoveryCommands`; only the codex manifest uses it.
- `ModelDiscovery` gains the stdio JSON-RPC client behind an injectable seam and a
  cache-file reader; the chain is app-server → cache file → `fallbackModels`.
- `EFFORT_LADDER` is now 8 rungs (`none`→`ultra`); no existing clamp result changes
  (nothing previously mapped to `ultra`).
- The webview runner toggles generalize from the two hardcoded runners to the registry
  list; `enabledRunners` defaults include `codex`.
- Installation detection is unchanged: `codex --version` answers, so absent installs
  filter out everywhere.
