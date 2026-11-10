import { GEMINI_ACP_ARGS, GEMINI_CLI_MANIFEST } from '../../plugins/builtin/gemini-cli.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import { plannerToolSet, taskToolSet } from '../mcp/tools';
import type { AcpProfile } from './acpProfiles';
import { DELEGATION_REFUSED } from './acpRoles';
import { geminiCredentials } from './geminiCredentials';

/** Gemini names an MCP tool `mcp_<server>_<tool>`, in what it shows the model and at the head of its call ids. */
const SERVER_PREFIX = `mcp_${ORDEWELL_MCP_SERVER_NAME}_`;

/** Gemini's call ids are the tool's name, this, then a counter: `write_file__call_393451`. */
const CALL_SEPARATOR = '__';

/**
 * Gemini's own ways to start another agent. In 0.67.0's source every subagent
 * is reached through one tool, `invoke_agent` (`AGENT_TOOL_NAME`), whose kind
 * is `agent`, which ACP reports as `think`, and the policy engine also checks
 * its call under the `agent_name` it names. The others are the built-in
 * subagents' names, which Gemini's policy docs say earlier versions offered as
 * tools of their own. Whether 0.66.0, the version recorded, offers
 * `invoke_agent` or those is unconfirmed; denying a name it lacks is harmless.
 */
const SUBAGENT_TOOLS = ['invoke_agent', 'codebase_investigator', 'cli_help', 'generalist', 'browser_agent'] as const;

/**
 * Gemini's own tools a restricted start refuses. A deny with no `argsPattern`
 * takes the tool out of what the model is shown, so a call never happens and
 * nothing records the refusal; the model was recorded hunting the private
 * directory for why. With a pattern that matches any call, Gemini keeps
 * offering the tool and refuses each call as a failed tool call, in its own
 * words (`Tool execution for "WriteFile" denied by policy.`), which the
 * transcript shows: the restricted recordings. Over ACP 0.66.0 shows the model
 * those words, not the `denyMessage`, which only a call Gemini's scheduler
 * checks, a subagent's, carries; it is kept for that path. A call with no
 * arguments at all would miss the pattern and ask, which the adapter refuses
 * by kind. Its subagents are denied with no pattern, so they are never offered
 * (`getExcludedTools` in 0.67.0 drops a tool a rule denies without one); a
 * subagent would run outside the adapter's sight, and Gemini's default policy
 * allows `invoke_agent` unasked at a priority this one outranks (ADR-0026).
 */
const REFUSED_NATIVE_TOOLS = `[[rule]]
toolName = ["write_file", "replace"]
argsPattern = "."
decision = "deny"
priority = 999
denyMessage = "Nothing may be written here: this session is read-only."

[[rule]]
toolName = "run_shell_command"
argsPattern = "."
decision = "deny"
priority = 999
denyMessage = "Your own shell is off here. Run commands with ${SERVER_PREFIX}run_command."

[[rule]]
toolName = ["web_fetch", "google_web_search"]
argsPattern = "."
decision = "deny"
priority = 999
denyMessage = "Your own web tools are off here. Read web pages with ${SERVER_PREFIX}fetch and search the web with ${SERVER_PREFIX}web_search."

[[rule]]
toolName = ["enter_plan_mode", "exit_plan_mode"]
decision = "deny"
priority = 999
denyMessage = "This session stays in the mode it was started in."

[[rule]]
toolName = [${SUBAGENT_TOOLS.map((name) => JSON.stringify(name)).join(', ')}]
decision = "deny"
priority = 999
denyMessage = ${JSON.stringify(DELEGATION_REFUSED)}
`;

/**
 * The policy a restricted start runs under. Gemini's `default` mode runs a
 * command it deems safe, a web search and a call a saved rule allows without
 * asking, so no request reaches the adapter to refuse: these rules deny them
 * before Gemini decides. Every tool Ordewell's server may list, whatever the
 * role, still asks, so the adapter answers it as it does unrestricted; every
 * other MCP server's tool is denied, a trusted one included, which would
 * otherwise run unasked. Ordewell's tools are named in full because Gemini
 * checks an MCP call twice, the second time under the server name
 * `mcp_ordewell`, which no `mcpName` rule for `ordewell` matches.
 */
function restrictedPolicy(): string {
  const served = [
    taskToolSet({}), taskToolSet({ readOnly: true }), taskToolSet({ board: true }), taskToolSet({ readOnly: true, board: true }),
    plannerToolSet({ delegates: true, subplanner: true, research: true }),
  ];
  const names = [...new Set(served.flat().map((tool) => JSON.stringify(`${SERVER_PREFIX}${tool.name}`)))];
  return `${REFUSED_NATIVE_TOOLS}
[[rule]]
toolName = [${names.join(', ')}]
decision = "ask_user"
priority = 999

[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 998
denyMessage = "Only Ordewell's MCP tools are on in this session."
`;
}

/**
 * Gemini CLI over ACP (`gemini --acp`), checked against the recordings in
 * `__tests__/fixtures/acp/gemini-cli/` (ADR-0060).
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
    const name = calledTool(request.toolCallId);
    return name?.startsWith(SERVER_PREFIX) ? name.slice(SERVER_PREFIX.length) : null;
  },
  toolName: (tool) => `${SERVER_PREFIX}${tool}`,
  // `--model` takes the id as `session/new` lists it; with it on the command
  // line the adapter does not set the model again in the session.
  modelArgs: (model) => ['--model', model],
  // A Google key saved in Ordewell signs Gemini in through the API-key auth
  // it already reads from its environment, so it needs no sign-in of its own
  // (ADR-0060, R9).
  credentials: geminiCredentials,
  // The Google key entry is the one Ordewell points at; Gemini CLI takes no
  // other vendor's key.
  signInRoute: { provider: 'google' },
  // Gemini's `plan` mode is no restriction: it denies Ordewell's tools and
  // allows writing a `.md` file, so a restricted start runs `default` under a
  // policy file instead. `default` runs a command it deems safe and a web
  // search unasked, so the policy denies Gemini's write, shell and web tools
  // before it decides, asks for every tool Ordewell's server may list, which
  // the adapter answers by name, and denies every other server's. It is
  // handed at both tiers Gemini takes a file from the command line: the
  // admin's outranks any rule the person saved, but Gemini drops it, with a
  // warning, on a machine whose administrator has policies of their own, and
  // the user tier's then still holds, in place of the person's saved rules
  // rather than beside them. The restricted-write,
  // restricted-shell, restricted-safe-shell and restricted-web recordings show
  // each refused as a failed call with nothing left behind, and the planner
  // and read-only ones Ordewell's tools reached. `--sandbox` was not taken: it
  // confines where a write lands rather than refusing it. Started in its
  // worktree, Gemini runs the hooks the repository's `.gemini/settings.json`
  // names (ADR-0028): in a private directory of its own, also its temp
  // directory, a planted hook was recorded not running. Gemini's own reads are
  // held to that directory, so it reaches the workspace through Ordewell's
  // `run_command` alone. The policy offers none of Gemini's subagents, and a
  // subagent's own calls would be checked by it too (ADR-0026).
  restricted: {
    args: ['--approval-mode', 'default'],
    privateCwd: true,
    files: [
      { fileName: 'ordewell-admin-policy.toml', render: restrictedPolicy, pass: { flag: '--admin-policy' } },
      { fileName: 'ordewell-policy.toml', render: restrictedPolicy, pass: { flag: '--policy' } },
    ],
  },
  // A subagent's call is refused by the name its call id begins with, in case
  // a version offers one the policy does not take away.
  delegation: { tools: SUBAGENT_TOOLS, toolOf: ({ request }) => calledTool(request.toolCallId) },
  roles: { plans: true, readOnly: true },
};

/** The tool a call id names, as Gemini looked it up: `write_file__call_393451` names `write_file`. */
function calledTool(toolCallId: string): string | null {
  const end = toolCallId.indexOf(CALL_SEPARATOR);
  return end < 0 ? null : toolCallId.slice(0, end);
}
