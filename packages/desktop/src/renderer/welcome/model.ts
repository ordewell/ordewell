import type { AiProvider } from '@ordewell/core';
import {
  describeSignInWays, RUNNER_INSTALL_DOCS, signInAction, signInOfVerdict, TERMINAL_UI_SIGN_IN,
} from '@ordewell/core/plan-utils';
import type { StatusId } from '@ordewell/ui/design';
import type { DaemonCallResult, RecentGit } from '../../shared/bridge';
import type { RunnerLine } from '../runners';

/**
 * What the welcome window (design W1) draws, worked out from the daemon's
 * answers and the app's store without touching the DOM, so each state is
 * testable on its own.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "4 minutes ago", "yesterday"; empty for a time that does not parse. */
export function relativeTime(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.round((now.getTime() - at) / 1000);
  if (seconds < 60) return 'just now';
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return RELATIVE.format(-Math.floor(seconds / size), unit);
  }
  return 'just now';
}

/** The relative time's tooltip: the date in full. */
export function fullDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}

/**
 * A path cut in its middle, so both the root and the folder's own name stay
 * (checklist O2). The card's narrowest width holds about this many monospace
 * characters; CSS still ends-ellipsis anything wider.
 */
export const PATH_CHARS = 34;

export function middleEllipsis(text: string, max = PATH_CHARS): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** GET /api/git/repos as the one line a card shows; undefined when the answer is not that shape. */
export function gitFromRepos(data: unknown): RecentGit | undefined {
  if (!isRecord(data) || !Array.isArray(data.repos)) return undefined;
  const repos = data.repos.filter(isRecord);
  if (repos.length === 0) return { kind: 'none' };
  // A single repository is the folder itself; anything else is a group (ADR-0014).
  if (repos.length === 1 && repos[0].repo === '.') {
    const branch = repos[0].branch;
    return typeof branch === 'string' && branch !== '' ? { kind: 'branch', name: branch } : { kind: 'detached' };
  }
  return { kind: 'repos', count: repos.length };
}

export function gitLine(git: RecentGit): string {
  switch (git.kind) {
    case 'branch': return git.name;
    case 'detached': return 'Detached HEAD';
    case 'repos': return git.count === 1 ? '1 repository' : `${git.count} repositories`;
    case 'none': return 'Not a git repository';
  }
}

export interface SessionLook {
  status: StatusId;
  word: string;
}

/** A plan's status (SessionMeta) as a status shape and the word the Sessions list uses. */
export function sessionLook(status: string): SessionLook {
  switch (status) {
    case 'running': return { status: 'running', word: 'Running' };
    case 'completed': return { status: 'passed', word: 'Settled' };
    case 'approved': return { status: 'not-started', word: 'Approved' };
    case 'rejected': return { status: 'blocked', word: 'Rejected' };
    case 'draft': return { status: 'not-started', word: 'Draft' };
    default: return { status: 'not-started', word: status === '' || status === 'unknown' ? 'Unknown' : status };
  }
}

/**
 * The Needs you count across the sessions asked about. A session nobody holds
 * answers 404 (it is not live, so nothing waits on the user) and adds nothing;
 * any other failure makes the count unknown rather than a guessed zero.
 */
export function needsYouCount(results: DaemonCallResult[]): number | undefined {
  let count = 0;
  for (const result of results) {
    if (!result.ok) {
      if (result.status === 404) continue;
      return undefined;
    }
    if (!isRecord(result.data) || !Array.isArray(result.data.escalations)) return undefined;
    count += result.data.escalations.length;
  }
  return count;
}

/** How long the runner row waits before it says the daemon did not answer, rather than "Checking…" for ever. */
export const RUNNERS_TIMEOUT_MS = 15_000;

/** A call that has not answered in `ms` settles as a failure with no status. */
export function withTimeout(call: Promise<DaemonCallResult>, ms: number, what: string): Promise<DaemonCallResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `${what} did not answer within ${Math.round(ms / 1000)} seconds.` }), ms);
    call.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error: unknown) => { clearTimeout(timer); resolve({ ok: false, error: error instanceof Error ? error.message : String(error) }); },
    );
  });
}

/** The daemon's own words for a failed call, as the shared error banner gives them. */
export function failureMessage(result: DaemonCallResult & { ok: false }): string {
  if (isRecord(result.data) && typeof result.data.error === 'string' && result.data.error !== '') return result.data.error;
  return result.error;
}

export type RunnerTone = 'passed' | 'attention' | 'idle' | 'failed';

export interface RunnerCardModel {
  id: string;
  tone: RunnerTone;
  word: string;
  version?: string;
  hint?: string;
  /** A command to show in the mono face, under the hint. */
  command?: string;
  /** The runner's own install page, for a missing one. */
  docs?: string;
  /** The button a signed-out agent gets: its login, or the key entry. */
  action?: 'login' | 'key';
  /** The vendor a key entry is for. */
  provider?: AiProvider;
  /** The agent's name, for the key entry's wording. */
  runnerLabel?: string;
}

/** Each runner's own install page, from core's manifest, opened through main's https-only `shell.openExternal`. */
export const INSTALL_DOCS: Readonly<Record<string, string>> = RUNNER_INSTALL_DOCS;

export function runnerCard(line: RunnerLine, name: string): RunnerCardModel {
  const version = line.version ? { version: line.version } : {};
  // An agent Ordewell cannot start is no better for being signed in, and a login
  // or key would not help it, so its reason is the whole card.
  if (line.unavailable && line.state !== 'off' && line.state !== 'missing') {
    return { id: line.id, tone: 'failed', word: 'Unavailable', ...version, hint: line.unavailable };
  }
  switch (line.state) {
    case 'signed-in':
      return { id: line.id, tone: 'passed', word: 'Signed in', ...version };
    case 'signed-out': {
      // The agent's own ways in, worded once by core (ADR-0052): a key-based
      // agent names the key entry, never a CLI sign-in it does not have.
      const signIn = line.signIn ?? signInOfVerdict(line.id, name, line.loginCommand ? { loginCommand: line.loginCommand } : undefined);
      const hint = signIn ? describeSignInWays(signIn, TERMINAL_UI_SIGN_IN) : '';
      const action = signInAction(signIn);
      return {
        id: line.id,
        tone: 'attention',
        word: 'Signed out',
        ...version,
        ...(hint ? { hint } : {}),
        ...(line.loginCommand ? { command: line.loginCommand.join(' ') } : {}),
        ...(action ? { action } : {}),
        ...(action === 'key' && signIn?.key ? { provider: signIn.key.provider, runnerLabel: name } : {}),
        ...(action === 'login' ? { runnerLabel: name } : {}),
      };
    }
    case 'unknown':
      return { id: line.id, tone: 'idle', word: 'Not checked', ...version, ...(line.detail ? { hint: line.detail } : {}) };
    case 'off':
      return { id: line.id, tone: 'idle', word: 'Off in Settings', ...version };
    case 'missing':
      return {
        id: line.id,
        tone: 'failed',
        word: 'Not installed',
        hint: `Install ${name}, then Retry.`,
        ...(Object.hasOwn(INSTALL_DOCS, line.id) ? { docs: INSTALL_DOCS[line.id] } : {}),
      };
  }
}

/** The runner row is empty only when every runner is turned off: a missing one still has its install hint to show. */
export function noRunnerOn(lines: RunnerLine[]): boolean {
  return lines.length > 0 && lines.every((line) => line.state === 'off');
}

/** The recent cards shown before *Show all*. */
export const MAX_CARDS = 9;

/** The shortcut's modifier as the platform writes it. */
export function modKey(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl+';
}
