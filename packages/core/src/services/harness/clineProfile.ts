import { CLINE_ACP_ARGS, CLINE_ACP_ENV, CLINE_CREDENTIALS, CLINE_MANIFEST } from '../../plugins/builtin/cline.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';

/** Cline names an MCP tool `<server>__<tool>`, in what it shows the model and in the title of its requests. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}__`;

/**
 * Cline's CLI over ACP (`cline --acp`), checked against the recordings in
 * `__tests__/fixtures/acp/cline/` (ADR-0060).
 *
 * It runs read-only tasks but does not plan: it reaches Ordewell's server only
 * once a prompt runs, and a planner's first turn is the goal (ADR-0060, R5).
 */
export const CLINE_PROFILE: AcpProfile = {
  manifest: CLINE_MANIFEST,
  args: CLINE_ACP_ARGS,
  // Discovery starts Cline with the same env and key (ADR-0060, R9).
  env: CLINE_ACP_ENV,
  credentials: CLINE_CREDENTIALS,
  // The version the recordings were made on.
  minVersion: '3.0.74',
  // Cline advertises no HTTP MCP capability, so `session/new` cannot carry the
  // server; it reads its MCP servers from a settings file named in its env,
  // written into the attempt's private directory so the token is never on a
  // command line (ADR-0060, R4).
  mcpConfig: {
    kind: 'file',
    fileName: 'cline_mcp_settings.json',
    render: (mcp) =>
      JSON.stringify({ mcpServers: { [mcp.name]: { type: 'streamableHttp', url: mcp.url, headers: mcp.headers } } }, null, 2),
    pass: { env: 'CLINE_MCP_SETTINGS_PATH' },
  },
  // Cline connects to its MCP servers only once the first prompt is running,
  // so the attach is judged on that turn (ADR-0060, R5).
  attach: 'firstTurn',
  // Cline has no instruction file or `_meta` slot that an ACP start reads, so
  // the contract rides in the first prompt, as the task's own words.
  instructions: { kind: 'prompt' },
  // `--auto-approve` is Cline's only permission switch and defaults to true,
  // so it is passed on every start: a person's approval is never left to
  // Cline's default (ADR-0001).
  mode: { kind: 'args', args: (flags) => ['--auto-approve', flags.permissionMode === 'autoApprove' ? 'true' : 'false'] },
  // The request's title is `<tool>` or `<tool>: <summary>`, where the tool is
  // the name Cline gave it and the summary is drawn from the model's
  // arguments. A tool's name has no colon, so only the text before the first
  // one is read, and only a call to the server named `ordewell` matches. The
  // kind is not read: Cline gives `other` to its own edits and to MCP calls alike.
  ordewellTool: ({ request }) => {
    const title = request.title;
    if (typeof title !== 'string') return null;
    const separator = title.indexOf(':');
    const name = separator === -1 ? title : title.slice(0, separator);
    return name.startsWith(SERVER_PREFIX) ? name.slice(SERVER_PREFIX.length) : null;
  },
  toolName: (tool) => `${SERVER_PREFIX}${tool}`,
  // Cline has no allow or deny list of its own, so what keeps a read-only task
  // from writing is that it asks: with `--auto-approve false` every edit and
  // command is a request, which the restricted start refuses, as the
  // read-only recordings show, and nothing reaches the worktree. Cline runs
  // the hooks in `.clinerules/hooks/` of the directory it starts in, and
  // CLINE_DIR does not keep them out; started in a directory of its own, it
  // runs none (ADR-0028).
  restricted: { args: ['--auto-approve', 'false'], privateCwd: true },
  roles: { plans: false, readOnly: true },
};
