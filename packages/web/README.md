# @ordewell/web

The local API server for **[Ordewell](https://ordewell.ai)** — a Hono HTTP +
WebSocket daemon bound to `127.0.0.1:3742` that the Ordewell CLI, terminal UI
and VS Code extension all drive.

**This is not a website, and it has no frontend.** It serves JSON. Opening the
port in a browser will show you an API response, not a dashboard. A browser UI
may come later; it does not exist today.

You almost certainly do not need to install this directly —
[@ordewell/cli](https://www.npmjs.com/package/@ordewell/cli) depends on it and
starts it on demand.

```bash
ordewell web            # foreground
ordewell web --daemon   # background; logs to ~/.config/ordewell/server.log
```

## Routes

`/api/sessions`, `/api/plans`, `/api/runners`, `/api/models`, `/api/settings`,
`/api/commands`, `/api/workspaces`, `/api/approvals`, plus a WebSocket stream
for live planner and execution events.

## Security

The server is **unauthenticated by design** and binds the loopback interface
only, on the assumption that local access is trusted. Do not expose it to a
network. If you find a way to reach it off-host, or from a browser page, that's
a vulnerability — see
[SECURITY.md](https://github.com/ordewell/ordewell/blob/main/SECURITY.md).

Licensed under the [Apache License 2.0](./LICENSE).
