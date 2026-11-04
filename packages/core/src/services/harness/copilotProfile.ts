import { COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';

/** Copilot names an MCP tool `<server>-<tool>`, in its tool-call reports and in what it shows the model. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}-`;

/**
 * GitHub Copilot CLI over ACP (`copilot --acp --stdio`), the reference ACP
 * runner, checked against the recordings in
 * `__tests__/fixtures/acp/copilot-cli/`.
 */
export const COPILOT_CLI_PROFILE: AcpProfile = {
  manifest: COPILOT_CLI_MANIFEST,
  args: ['--acp', '--stdio'],
  minVersion: '1.0.105',
  // Copilot loads AGENTS.md from each directory this variable lists, so the
  // contract reaches it from a private directory and never the worktree. It
  // replaces whatever directories the user's own environment names there.
  instructions: { kind: 'file', fileName: 'AGENTS.md', pass: { envDir: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS' } },
  // Copilot's ACP session modes include autopilot, which also changes how it
  // works, not only whether it asks: the flag is the permission switch alone.
  mode: { kind: 'args', args: (flags) => (flags.permissionMode === 'allowAll' ? ['--allow-all'] : []) },
  // The report's title is the full `ordewell-task_complete`; an edit or a
  // command carries a title the model wrote, so only kind `other` is an MCP
  // call. The permission request's bare `task_complete` is never trusted.
  ordewellTool: (call) =>
    call.kind === 'other' && call.title?.startsWith(SERVER_PREFIX) ? call.title.slice(SERVER_PREFIX.length) : null,
  toolName: (tool) => `${SERVER_PREFIX}${tool}`,
  modelArgs: (model) => ['--model', model],
  // A denied tool is refused by Copilot itself, ahead of any allow and with
  // no request, which the read-only recording shows holding under ACP. The
  // variable is cleared because an inherited "true" would also trust the
  // worktree and load its hooks.
  restricted: {
    args: ['--deny-tool=write', '--deny-tool=shell', '--deny-tool=url', '--disable-builtin-mcps'],
    env: { COPILOT_ALLOW_ALL: 'false' },
  },
  // Withheld (ADR-0028): under ACP Copilot 1.0.105 runs the shell hooks in
  // the repository's `.github/hooks/` from the first prompt, in a folder it
  // was never told to trust and with `disableAllHooks` set, and no flag turns
  // them off. A planner or a read-only task would run the repository's code.
  roles: { plans: false, readOnly: false },
};
