# @ordewell/web

The local API server for **[Ordewell](https://ordewell.ai)**: a Hono HTTP +
WebSocket daemon bound to `127.0.0.1:3742` that the Ordewell CLI and terminal UI
drive. The VS Code extension does not use it: it runs core's `Session`
in-process, and the two share the saved-session store in `.ordewell/sessions/`.

**This is not a website, and it has no frontend.** It serves JSON. Opening the
port in a browser will show you an API response, not a dashboard. A browser UI
may come later; it does not exist today.

You almost certainly do not need to install this directly.
[@ordewell/cli](https://www.npmjs.com/package/@ordewell/cli) depends on it and
starts it on demand.

```bash
ordewell web            # foreground
ordewell web --daemon   # background; logs to ~/.ordewell/server.log
```

## Routes

`/api/sessions`, `/api/plans`, `/api/runners`, `/api/models`, `/api/settings`,
`/api/commands`, `/api/workspaces`, `/api/approvals`, plus a WebSocket stream
for live planner and execution events. Execution controls (run, stop or retry a
task, skip, mark complete, message) are one `POST /api/plans/:id/execute-command`
whose body is core's `ExecutionCommand`. Mark complete and Mark not done on an
AI or script task are refused while a run could advance the task, and otherwise
need `"confirmed": true`, the user's yes (with `"seen"`, the task status they
were asked about); a manual task's sign-off needs neither. What waits on a
person (ADR-0053) is `GET /api/plans/:id/escalations`, and on every status
update; `POST /api/plans/:id/escalations/answer` answers one by its id.

Skills are read by the planner and the task orchestrator, not served as a
route; the format is in [Writing skills](https://github.com/ordewell/ordewell/blob/main/docs/skills.md).

## Security

The server binds the loopback interface only, and admits a request only when it
carries the bearer token minted at startup (clients read it from
`~/.ordewell/server-<port>.token`), names a loopback `Host` at the daemon's own
port, and carries no `Origin` header. Local access is **not** assumed to be
trusted. If you find a way to reach it off-host, or from a browser page, that's
a vulnerability; see
[SECURITY.md](https://github.com/ordewell/ordewell/blob/main/SECURITY.md).

Licensed under the [Apache License 2.0](./LICENSE).
