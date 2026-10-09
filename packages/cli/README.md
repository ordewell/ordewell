# @ordewell/cli

The command line and terminal UI for **[Ordewell](https://ordewell.ai)**, task
orchestration for coding agents. One goal becomes an ordered plan of tasks, each on
its own runner, model and branch. Ordewell executes the plan, verifies every task
from evidence, and leaves the final merge to you.

## Installation

```bash
npm install -g @ordewell/cli        # or: npm install -g ordewell
```

**Requirements:** Node.js 20 or newer, at least one of Claude Code, Codex or
OpenCode, and git for task isolation. tmux is optional: only tasks on a
runner with no structured connector use it, to give each a terminal window you
can open. Linux, macOS and Windows are supported; on Windows, run the
terminal UI under WSL.

## Usage

Run `ordewell` in your project to open the terminal UI: the conversation on the
left, the live plan on the right. The first run lets you pick a planner and runners
with `/planner` and `/runners`, and no API key is needed if you plan with a coding
agent you already use.

Every command in the terminal UI is also a subcommand:

```bash
export AI_PROVIDER=claude-code      # plan with Claude Code, Codex or OpenCode

ordewell plan --goal "Add rate limiting to the public API"
ordewell run
ordewell handoff review             # read the diff
ordewell handoff merge              # bring it onto your branch
```

Run `ordewell --help` for the full list, or `ordewell setup` for guided
configuration.

This package also installs `@ordewell/web`, the local API server that the CLI and
terminal UI talk to over `127.0.0.1`. It starts on demand.

## Documentation

Full documentation is at **[ordewell.ai/docs](https://ordewell.ai/docs)**, and the
source is at **[github.com/ordewell/ordewell](https://github.com/ordewell/ordewell)**.

## License

[Apache License 2.0](./LICENSE)
