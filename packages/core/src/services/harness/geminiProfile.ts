import { GEMINI_ACP_ARGS, GEMINI_CLI_MANIFEST } from '../../plugins/builtin/gemini-cli.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';

/** Gemini names an MCP tool `mcp_<server>_<tool>`, in what it shows the model and at the head of its call ids. */
const SERVER_PREFIX = `mcp_${ORDEWELL_MCP_SERVER_NAME}_`;

/** Gemini's call ids are the tool's name, this, then a counter: `write_file__call_393451`. */
const CALL_SEPARATOR = '__';

/**
 * Gemini CLI over ACP (`gemini --acp`), checked against the recordings in
 * `__tests__/fixtures/acp/gemini-cli/` (ADR-0060).
 *
 * It is a task-only runner: `roles` is absent because no recording shows its
 * `plan` mode, or any restriction, refusing a write and a command (ADR-0046).
 */
export const GEMINI_CLI_PROFILE: AcpProfile = {
  manifest: GEMINI_CLI_MANIFEST,
  // An untrusted folder, which a new worktree is to Gemini, connects no MCP
  // server and refuses `yolo`, so Ordewell's server would never be reached
  // and the plan's autonomous mode never set: the `untrusted` and
  // `untrusted-yolo` recordings. `--skip-trust` trusts the worktree for this
  // process only, and with it Gemini loads the worktree's own `.gemini/`
  // config, as Claude Code and Codex load theirs in a task.
  args: [...GEMINI_ACP_ARGS, '--skip-trust'],
  // The version the recordings were made on.
  minVersion: '0.66.0',
  // Gemini has no instruction file or `_meta` slot to carry the contract
  // privately, so it rides in the first prompt, as the task's own words.
  instructions: { kind: 'prompt' },
  // Gemini offers no config options, so the adapter sets the mode with
  // `session/set_mode`; the plan's mode is Gemini's own mode id.
  mode: { kind: 'session-mode' },
  // The request carries no `_meta` and no raw input, and its title is the
  // call as the model wrote it (`task_complete(summary: ok, status: done)`),
  // so neither is read. The call id begins with the name Gemini looked the
  // tool up by, exactly, which a native tool has bare (`write_file`) and an
  // MCP tool prefixed with its server's name, so only a call to the server
  // named `ordewell` matches. The kind is not read either: Gemini guesses it
  // for an MCP tool.
  ordewellTool: ({ request }) => {
    const end = request.toolCallId.indexOf(CALL_SEPARATOR);
    if (end < 0) return null;
    const name = request.toolCallId.slice(0, end);
    return name.startsWith(SERVER_PREFIX) ? name.slice(SERVER_PREFIX.length) : null;
  },
  toolName: (tool) => `${SERVER_PREFIX}${tool}`,
  // `--model` takes the id as `session/new` lists it; with it on the command
  // line the adapter does not set the model again in the session.
  modelArgs: (model) => ['--model', model],
};
