import { COPILOT_ACP_ARGS, COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';
import { COPILOT_REPO_CONFIG } from './copilotRepoConfig';

/** Copilot names an MCP tool `<server>-<tool>`, in its tool-call reports and in what it shows the model. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}-`;

/**
 * Copilot's tools that start, list or steer another agent or session. The
 * first four are what GitHub's CLI reference lists as its "agent and task
 * delegation tools" for `--excluded-tools`; the rest are names the 1.0.108
 * binary carries for tools behind feature flags or settings (an execution and
 * a code-search subagent, `sessionManagementTools.create`), which no reference
 * lists. Nothing in that binary was seen refusing a name it does not offer, and
 * the live probe (`bench/live/acp-subagent-probe.mjs`) checks Copilot starts
 * with them all (ADR-0026).
 */
const DELEGATION_TOOLS = ['task', 'read_agent', 'write_agent', 'list_agents', 'execution_subagent', 'search_code_subagent', 'create_session', 'send_session_message'];

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
  // task_complete (ADR-0018 W1). A subagent would work outside the adapter's
  // sight, so `--excluded-tools` takes every agent-starting tool out of what
  // the model is shown (ADR-0026). The reference documents the flag for the
  // CLI, not for ACP: no recording shows it holding there yet.
  restricted: {
    args: ['--deny-tool=write', '--deny-tool=shell', '--deny-tool=url', '--disable-builtin-mcps', '--excluded-tools', DELEGATION_TOOLS.join(',')],
    env: { COPILOT_ALLOW_ALL: 'false' },
    privateCwd: true,
  },
  // A restricted start begins outside the worktree, so Copilot loads none of
  // the repository's instruction files itself: they reach it as text in its
  // private directory's AGENTS.md, after Ordewell's own (ADR-0060, R3).
  repoConfig: COPILOT_REPO_CONFIG,
  // Copilot's report of a native call carries no tool name, only its own words
  // or the model's description, so a subagent is known by the `agent_type`
  // its input names, as the binary's own prompts call `task` with. No
  // recording shows the call over ACP: this is unconfirmed, and holds only
  // should a version ask before starting one the flag left in.
  delegation: { tools: ['task'], toolOf: ({ request }) => (typeof inputOf(request.rawInput).agent_type === 'string' ? 'task' : null) },
  roles: { plans: true, readOnly: true },
};

function inputOf(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}
