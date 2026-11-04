import { CLINE_ACP_ARGS, CLINE_MANIFEST } from '../../plugins/builtin/cline.manifest';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';
import type { AcpProfile } from './acpProfiles';
import { clineCredentials } from './clineCredentials';

/** Cline names an MCP tool `<server>__<tool>`, in what it shows the model and in the title of its requests. */
const SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}__`;

/**
 * Cline's CLI over ACP (`cline --acp`), checked against the recordings in
 * `__tests__/fixtures/acp/cline/` (ADR-0060).
 *
 * It is a task-only runner: `roles` and `restricted` are absent because Cline
 * has no shell allow or deny list, and no recording shows its `plan` mode
 * refusing a write and a command (ADR-0046).
 */
export const CLINE_PROFILE: AcpProfile = {
  manifest: CLINE_MANIFEST,
  args: CLINE_ACP_ARGS,
  // Left to choose, Cline may start or join a hub daemon that outlives the
  // attempt and serves other sessions; `local` keeps the session inside the
  // process Ordewell starts and stops.
  env: { CLINE_SESSION_BACKEND_MODE: 'local' },
  // Cline keeps its provider's key in its own store, which an ACP start does
  // not read, so the key is passed in the start's env (ADR-0060, R9).
  credentials: clineCredentials(),
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
};
