import type { McpClientConfig } from '../mcp';

/**
 * The title of the dialog Ordewell's Pi extension opens to ask about one
 * read. Pi has no permission requests of its own, so the extension's dialog
 * over Pi's RPC extension UI is the request, and the adapter's answer is the
 * decision it enforces.
 */
export const PI_READ_ASK = 'ordewell:read';

/** What the extension asks about a read, as the dialog's placeholder carries it. */
export interface PiReadAsk {
  /** Pi's id for the call, which its `tool_execution_*` events carry too. */
  toolCallId: string;
  tool: string;
  /** The path as Pi would resolve it, links followed: what the call reads once allowed. */
  path: string;
  directory: boolean;
}

export interface PiExtensionConfig {
  server: Pick<McpClientConfig, 'name' | 'url' | 'headers'>;
  /**
   * Whether every read asks Ordewell first: a planner's start, decided by the
   * planner's envelope (ADR-0026), and a read-only task's, by
   * `decideReadOnlyTaskPermission` (ADR-0046). A writable task runs Pi's own
   * tools natively.
   */
  asksReads: boolean;
}

/**
 * The module Pi loads with `-e`, written per process into a directory of its
 * own, owner-only, outside the worktree: it holds the attempt's token. It
 * registers Ordewell's MCP server for the session with its tools named
 * directly, and on a restricted start asks before each of Pi's read tools
 * runs.
 *
 * A read is asked about where Pi would read it, so the decision is about the
 * file the tool opens: the path is resolved by Pi's own rules (its Unicode
 * spaces, a leading `@`, `~`, `file://`, a Git Bash drive on Windows), must
 * exist (Pi's read tries near matches for a missing one, which may be a link
 * out), and is followed through links. An allowed call is then given that real
 * path, so Pi reads exactly what was decided. `grep` and `find` start at their
 * path and follow no link below it, so the path bounds what they search. A call
 * the answer does not allow, or that nobody answered, is blocked with the
 * answer's reason, which the model reads as the tool's error.
 *
 * Plain JavaScript in a string: core ships bundled, as a single binary among
 * others, so the extension has no file of its own to point Pi at.
 */
export function piExtensionSource(config: PiExtensionConfig): string {
  return `// Written by Ordewell for one Pi process; removed with it.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = ${JSON.stringify(config)};
const READ_ASK = ${JSON.stringify(PI_READ_ASK)};
${EXTENSION_BODY}`;
}

const EXTENSION_BODY = String.raw`const READ_TOOLS = new Set(['read', 'ls', 'grep', 'find']);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const MISSING = 'This path is not on disk, and Pi would read a near match in its place, so it was not read. Name a file or directory that exists.';
const RESPACED = 'Pi would read this path with its spaces changed, which is not the file that was checked, so it was not read.';
const UNANSWERED = 'Ordewell did not allow this read.';

function windowsShellPath(p) {
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return p;
  const match = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  return match ? match[1].toUpperCase() + ':\\' + (match[2] ? match[2].replaceAll('/', '\\') : '') : p;
}

// Pi's resolveToCwd (utils/paths.js), so the path checked is the path Pi opens.
function piPath(raw, cwd) {
  let p = raw.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (process.platform === 'win32') p = windowsShellPath(p);
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) p = join(homedir(), p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function decision(answer) {
  try {
    const parsed = JSON.parse(answer);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export default function ordewell(pi) {
  pi.registerMcpServer(CONFIG.server.name, { url: CONFIG.server.url, headers: CONFIG.server.headers, exposure: 'direct' });
  if (!CONFIG.asksReads) return;
  pi.on('tool_call', async (event, ctx) => {
    if (!READ_TOOLS.has(event.toolName)) return;
    const raw = typeof event.input.path === 'string' && event.input.path ? event.input.path : '.';
    const cwd = ctx.cwd || process.cwd();
    const abs = piPath(raw, cwd);
    if (!existsSync(abs)) return { block: true, reason: MISSING };
    const real = realpathSync.native(abs);
    if (real.replace(UNICODE_SPACES, ' ') !== real) return { block: true, reason: RESPACED };
    const ask = { toolCallId: event.toolCallId, tool: event.toolName, path: real, directory: event.toolName !== 'read' };
    const answered = decision(await ctx.ui.input(READ_ASK, JSON.stringify(ask), { signal: ctx.signal }));
    if (answered?.decision !== 'allow' && answered?.decision !== 'allowForTask') {
      return { block: true, reason: typeof answered?.note === 'string' && answered.note ? answered.note : UNANSWERED };
    }
    event.input.path = real;
  });
}
`;

/** The extension's ask, from the dialog Pi forwarded; null for any other dialog. */
export function piReadAsk(request: { title?: unknown; placeholder?: unknown }): PiReadAsk | null {
  if (request.title !== PI_READ_ASK || typeof request.placeholder !== 'string') return null;
  try {
    const ask = JSON.parse(request.placeholder) as Partial<PiReadAsk>;
    if (typeof ask.toolCallId !== 'string' || typeof ask.tool !== 'string' || typeof ask.path !== 'string') return null;
    return { toolCallId: ask.toolCallId, tool: ask.tool, path: ask.path, directory: ask.directory === true };
  } catch {
    return null;
  }
}
