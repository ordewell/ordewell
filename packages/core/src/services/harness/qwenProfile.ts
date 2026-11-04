import { QWEN_ACP_ARGS, QWEN_CODE_MANIFEST } from '../../plugins/builtin/qwen.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';
import { qwenCredentials } from './qwenCredentials';

/** Qwen names an MCP tool `mcp__<server>__<tool>`, in what it shows the model and in `_meta.toolName` of its requests. */
const SERVER_PREFIX = `mcp__${ORDEWELL_MCP_SERVER_NAME}__`;

/**
 * Qwen Code over ACP (`qwen --acp`), the second ACP runner after Copilot
 * (ADR-0060), checked against the recordings in
 * `__tests__/fixtures/acp/qwen-code/`.
 *
 * It is a task-only runner: `roles` is absent because no recording shows its
 * `plan` mode, or any restriction, refusing a write and a command (ADR-0046).
 */
export const QWEN_CODE_PROFILE: AcpProfile = {
  manifest: QWEN_CODE_MANIFEST,
  args: QWEN_ACP_ARGS,
  // The version the recordings were made on; an older Qwen has no
  // `session/set_config_option` for its mode and model.
  minVersion: '0.26.6',
  // Qwen has no instruction file or `_meta` slot to carry the contract
  // privately, so it rides in the first prompt, as the task's own words.
  instructions: { kind: 'prompt' },
  // Qwen offers its mode as a config option, which the adapter sets by that
  // id and checks the answer of; the plan's mode is Qwen's own mode id.
  mode: { kind: 'session-mode' },
  // The request's title is the call's arguments as JSON, which the model
  // writes, so it is never read. `_meta.toolName` is the name Qwen gave the
  // tool: a native tool is bare (`write_file`) and an MCP tool carries its
  // server's name, so only a call to the server named `ordewell` matches. The
  // kind is not read either: Qwen guesses it for an MCP tool.
  ordewellTool: ({ request }) => {
    const name = request._meta?.toolName;
    return typeof name === 'string' && name.startsWith(SERVER_PREFIX) ? name.slice(SERVER_PREFIX.length) : null;
  },
  toolName: (tool) => `${SERVER_PREFIX}${tool}`,
  // `--model` takes the id as `session/new` lists it, provider suffix or not.
  modelArgs: (model) => ['--model', model],
  // A provider key configured in Ordewell signs Qwen in through its `openai`
  // auth, so it needs no sign-in of its own (ADR-0060, R9).
  credentials: qwenCredentials,
  signInRoute: 'set the key of an OpenAI-compatible provider, such as OpenRouter, in Ordewell with `/key`',
};
