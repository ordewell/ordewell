/**
 * What the driver sees of a planning run: the session the TUI's daemon holds,
 * read over the daemon's HTTP API with its bearer token, exactly as the TUI's
 * own client reads it. `classifyTurn` is pure, so the tests prove how the
 * driver reads each kind of turn.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANSWER, CONFIRM } from './config.mjs';
import { planSubmitted, sessionParts } from './metrics.mjs';

/** Where the daemon writes its token: `~/.ordewell/server-<port>.token` (packages/core/src/utils/daemonToken.ts). */
export const tokenPath = (port, home = os.homedir()) => path.join(home, '.ordewell', `server-${port}.token`);

export function readToken(port) {
  try {
    return fs.readFileSync(tokenPath(port), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function daemonClient(port, token) {
  const get = async (route, timeoutMs = 10_000) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GET ${route.split('?')[0]} answered ${res.status}`);
    return res.json();
  };
  return {
    sessions: (workspace) => get(`/api/sessions?workspace=${encodeURIComponent(workspace)}`),
    session: (id, workspace) => get(`/api/sessions/${encodeURIComponent(id)}?workspace=${encodeURIComponent(workspace)}`),
  };
}

const lastOf = (xs) => (xs.length ? xs[xs.length - 1] : undefined);

// An outline offered for confirmation, as planners word the ask.
const OUTLINE = /\b(outline|confirm|proceed|go ahead|look(s)? (right|good|ok)|sounds? (right|good)|shall i|should i (submit|proceed|go)|ready to (submit|plan)|submit (the|this) plan)\b/i;

/**
 * Where a turn left the conversation, given how long the history was when the
 * driver last spoke:
 *   busy      the planner is still in its turn, or has not answered yet
 *   plan      submit_plan landed
 *   error     the turn ended on a failure (a usage limit, a refused start)
 *   outline   it offered an outline and asks to go on: the driver confirms
 *   question  it asked something: the driver answers that it has no preference
 *   stalled   it ended its turn with neither a plan nor anything to reply to
 */
export function classifyTurn(session, { sentAt, sawBusy = false }) {
  const parts = sessionParts(session);
  if (session?.plannerTurnId || (session?.conversation?.pendingTurns ?? []).length > 0) return { state: 'busy' };
  const fresh = parts.history.slice(sentAt);
  const last = lastOf(fresh.filter((m) => m?.role === 'assistant' || m?.kind === 'error'));
  if (planSubmitted({ tasks: parts.tasks, history: fresh })) return { state: 'plan' };
  // A turn that ran and ended with nothing said has left nothing to wait for.
  if (!last) return sawBusy ? { state: 'stalled', text: '', reply: CONFIRM } : { state: 'busy' };
  const text = String(last.content ?? '');
  if (last.kind === 'error') return { state: 'error', text };
  if (OUTLINE.test(text)) return { state: 'outline', text, reply: CONFIRM };
  if (text.includes('?')) return { state: 'question', text, reply: ANSWER };
  return { state: 'stalled', text, reply: CONFIRM };
}

/** The session the run started: the workspace's only one, or its newest. */
export function newestSession(list) {
  const metas = Array.isArray(list) ? list : [];
  return metas.slice().sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0] ?? null;
}
