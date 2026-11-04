import { CURSOR_ACP_ARGS, CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';
import { CURSOR_EXTENSION_REQUESTS } from './cursorRequests';

/** Cursor titles its request to call an MCP tool `<server>-<tool>: <tool>`. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}-`;

/** What Cursor's first report of every MCP call is titled, whatever the server and tool. */
const MCP_REPORT_TITLE = 'MCP: tool';

/**
 * Cursor's CLI over ACP (`cursor-agent acp`), checked against the recordings
 * in `__tests__/fixtures/acp/cursor-agent/` (ADR-0060).
 *
 * It is a task-only runner: `roles` and `restricted` are absent because no
 * recording shows its `plan` or `ask` mode, or any flag, refusing a write and
 * a command (ADR-0046). The account it was recorded on had no paid plan, and
 * Cursor ended the plan-mode turn with "Upgrade your plan to continue".
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
  extensionRequests: CURSOR_EXTENSION_REQUESTS,
};
