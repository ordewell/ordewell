import { QWEN_ACP_ARGS, QWEN_CODE_MANIFEST } from '../../plugins/builtin/qwen.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';
import { qwenCredentials, qwenVendorModel } from './qwenCredentials';

/** Qwen names an MCP tool `mcp__<server>__<tool>`, in what it shows the model and in `_meta.toolName` of its requests. */
const SERVER_PREFIX = `mcp__${ORDEWELL_MCP_SERVER_NAME}__`;

/**
 * Qwen Code over ACP (`qwen --acp`), the second ACP runner after Copilot
 * (ADR-0060), checked against the recordings in
 * `__tests__/fixtures/acp/qwen-code/`.
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
  // `--model` takes the id as `session/new` lists it, provider suffix or not,
  // except the runtime form, which Qwen would wrap again: that takes the
  // vendor's own id inside it.
  modelArgs: (model) => ['--model', qwenVendorModel(model) ?? model],
  // A provider key configured in Ordewell signs Qwen in through its `openai`
  // auth, so it needs no sign-in of its own (ADR-0060, R9).
  credentials: qwenCredentials,
  signInRoute: 'set the key of an OpenAI-compatible provider, such as OpenRouter, in Ordewell with `/key`',
  // Qwen has no flag that takes its write or shell tools away, and its plan
  // mode is left by a request to switch modes. In `default` it asks before
  // every write, edit and command, and the adapter refuses each by its kind,
  // switch_mode included, with no person asked; the restricted-write,
  // restricted-shell, planner and read-only recordings show that holding
  // with nothing left behind. Qwen ends its turn on a refused request, so a
  // read-only task that asks to write stops there and is reminded to call
  // task_complete (ADR-0018 W1). Started in its worktree, Qwen loads the
  // repository's `.qwen/settings.json`, whose hooks run the repository's
  // code (ADR-0028): in a private directory of its own, also its temp
  // directory, a planted hook was recorded not running, and Qwen reaches the
  // workspace only by asking, which puts every read to the envelope.
  restricted: { args: ['--approval-mode', 'default'], privateCwd: true, toolSearch: 'tool_search' },
  roles: { plans: true, readOnly: true },
};
