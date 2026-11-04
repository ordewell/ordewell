import { COPILOT_ACP_ARGS, COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';

/** Copilot names an MCP tool `<server>-<tool>`, in its tool-call reports and in what it shows the model. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}-`;

/**
 * GitHub Copilot CLI over ACP (`copilot --acp --stdio`), the reference ACP
 * runner (ADR-0060, R2), checked against the recordings in
 * `__tests__/fixtures/acp/copilot-cli/`.
 */
export const COPILOT_CLI_PROFILE: AcpProfile = {
  manifest: COPILOT_CLI_MANIFEST,
  args: COPILOT_ACP_ARGS,
  minVersion: '1.0.105',
  // Copilot finds AGENTS.md in each directory this variable lists, so the
  // contract reaches it from a private directory and never the worktree. It
  // replaces whatever directories the user's own environment names there. A
  // restricted start loads it as its start directory's own instead.
  instructions: { kind: 'file', fileName: 'AGENTS.md', pass: { envDir: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS' } },
  // Copilot's ACP session modes include autopilot, which also changes how it
  // works, not only whether it asks: the flag is the permission switch alone.
  mode: { kind: 'args', args: (flags) => (flags.permissionMode === 'allowAll' ? ['--allow-all'] : []) },
  // Copilot's request names an MCP tool bare (`run_plan`) and its report names
  // it on its server (`ordewell-run_plan`). A native call's two titles are
  // Copilot's own fixed words ("Create file", "Creating <path>") or the one
  // description the model wrote, on both, so only a call to the server named
  // `ordewell` carries the pair. The kind is not read: Copilot guesses it
  // from the tool's name, and reports run_plan as `execute` and list_runners
  // as `read`, which a restricted start's refusal by kind would turn away.
  ordewellTool: ({ request, report }) =>
    request.title !== undefined && report?.title === `${SERVER_PREFIX}${request.title}` ? request.title : null,
  toolName: (tool) => `${SERVER_PREFIX}${tool}`,
  modelArgs: (model) => ['--model', model],
  // A denied tool is refused by Copilot itself, ahead of any allow and with
  // no request, which the planner and read-only-in-worktree recordings show
  // holding under ACP. The variable is cleared because an inherited "true"
  // would also trust the worktree and load its hooks.
  // Copilot runs the shell hooks in `.github/hooks/` of the directory it
  // starts in, from the first prompt, trusted or not and with
  // `disableAllHooks` set, and no flag turns them off; under ACP `--add-dir`
  // grants no access and `--disallow-temp-dir` takes none away. Started in a
  // directory of its own, which is its temp directory too, it runs none, and
  // reaches the worktree only by asking, which puts every read to the
  // envelope (ADR-0028). Copilot ends its turn on a refused request, so a
  // read-only task that asks to write stops there and is reminded to call
  // task_complete (ADR-0018 W1).
  restricted: {
    args: ['--deny-tool=write', '--deny-tool=shell', '--deny-tool=url', '--disable-builtin-mcps'],
    env: { COPILOT_ALLOW_ALL: 'false' },
    privateCwd: true,
  },
  roles: { plans: true, readOnly: true },
};
