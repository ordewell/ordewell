import { CURSOR_ACP_ARGS, CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';
import { CURSOR_EXTENSION_REQUESTS } from './cursorRequests';

/** Cursor titles its request to call an MCP tool `<server>-<tool>: <tool>`. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}-`;

/** What Cursor's first report of every MCP call is titled, whatever the server and tool. */
const MCP_REPORT_TITLE = 'MCP: tool';

/** The variable Cursor reads its home of configuration from, `~/.cursor` when unset. */
const CURSOR_CONFIG_HOME = 'CURSOR_CONFIG_DIR';

/**
 * Cursor's settings for a restricted start: every read, write and command of
 * its own denied, and nothing allowed, so no list of the user's can let one
 * through. Its own web fetch and search are not in these terms; they ask.
 */
const RESTRICTED_CLI_CONFIG = JSON.stringify({
  version: 1,
  permissions: { allow: [], deny: ['Read(**)', 'Write(**)', 'Shell(*)'] },
  approvalMode: 'allowlist',
  sandbox: { mode: 'disabled' },
});

/**
 * Cursor's CLI over ACP (`cursor-agent acp`), checked against the recordings
 * in `__tests__/fixtures/acp/cursor-agent/` (ADR-0060).
 *
 * It plans and runs read-only tasks in its agent mode, its own tools denied
 * by a settings file of the start's own (ADR-0046; ADR-0060, R3). Its `plan`
 * and `ask` modes are never used: Cursor ended the plan-mode turn recorded on
 * an account with no paid plan with "Upgrade your plan to continue".
 */
export const CURSOR_AGENT_PROFILE: AcpProfile = {
  manifest: CURSOR_AGENT_MANIFEST,
  args: CURSOR_ACP_ARGS,
  // No `minVersion`: Cursor's `initialize` carries no `agentInfo`, so a
  // version check would refuse every start.
  // Cursor has no instruction file or `_meta` slot to carry the contract
  // privately, so it rides in the first prompt, as the task's own words.
  instructions: { kind: 'prompt' },
  // `--force` is the permission switch alone; Cursor's session modes (agent,
  // plan, ask) change what it does, not only whether it asks.
  mode: { kind: 'args', args: (flags) => (flags.permissionMode === 'force' ? ['--force'] : []) },
  // The request names the call `<server>-<tool>: <tool>`; a native call's is
  // the command in backticks or Cursor's own words. The turn's first report of
  // an MCP call is always titled "MCP: tool", and a native call's never is,
  // so the pair is required. The kind is not read: Cursor reports every MCP
  // call as `other`, whatever it does.
  ordewellTool: ({ request, report }) => {
    const { title } = request;
    if (report?.title !== MCP_REPORT_TITLE || !title) return null;
    const at = title.indexOf(': ');
    if (at < 0) return null;
    const tool = title.slice(at + 2);
    return title.slice(0, at) === `${SERVER_PREFIX}${tool}` ? tool : null;
  },
  // No `toolName`: Cursor shows the model a tool by the server's own name,
  // as its report of the call carries it (`toolName: "task_complete"`).
  // No `modelArgs`: `acp --model <id>` was recorded opening on the default
  // model, so the adapter sets the plan's model with
  // `session/set_config_option`. Cursor keeps that as the user's default for
  // its next process, as recorded, so a task with no model opens on whatever
  // the last one set.
  // A model set in a restricted start is kept in that start's own home of
  // configuration, and goes with it.
  extensionRequests: CURSOR_EXTENSION_REQUESTS,
  // Cursor's default mode writes an edit without asking, as recorded, so
  // asking cannot be what stops a write. It refuses a tool its settings deny
  // without asking either, and reports the call completed with no content:
  // the restricted-write, restricted-shell and restricted-delete recordings
  // show each refused, the refusal only in the model's words, and nothing left
  // behind. Reads are denied too, since Cursor's own were seen reaching past
  // the directory it starts in unasked; a read-only task reads through
  // Ordewell's run_command. Its web fetch and search ask, and the restricted
  // start refuses them as any read-only task's (the restricted-fetch and
  // restricted-search recordings). The settings sit in a home of
  // configuration of this start's own, so the user's own `cli-config.json`,
  // which may allow commands or accept web searches unasked, is not read; the
  // sign-in survived the move on macOS, and a start signed out fails as not
  // signed in. `--sandbox disabled` matches the settings, so the deny list
  // alone decides: a shell command was refused with the sandbox on or off.
  // Started in its worktree, Cursor loads the repository's `.cursor/` rules,
  // hooks, MCP servers and permissions, and its AGENTS.md (ADR-0028): in a
  // directory of its own, the planted-hook recording shows none loading. No
  // `toolSearch`: Cursor calls Ordewell's tools without loading them first.
  restricted: {
    args: ['--sandbox', 'disabled'],
    privateCwd: true,
    configDirs: [CURSOR_CONFIG_HOME],
    files: [{ fileName: `${CURSOR_CONFIG_HOME}/cli-config.json`, render: () => RESTRICTED_CLI_CONFIG }],
  },
  roles: { plans: true, readOnly: true },
};
