import { basename } from 'node:path';
import { LIVE_WORK_KINDS, type LiveWorkKind } from '../shared/bridge';
import type { LiveRun } from './daemon/liveRuns';
import type { QuitPrompt } from './lifecycle';

/** What main can do with its windows, so the choice below is tested without Electron. */
export interface SwitchPorts<W> {
  /** The key a workspace is known by (`workspaceKey`): one folder, however it was named. */
  keyOf(path: string): string;
  workspaceOf(win: W): string | undefined;
  /** The window this workspace is open in, if any. */
  windowOf(key: string): W | undefined;
  focus(win: W): void;
  /** A window of its own for the workspace; `from` is the window the choice was made in. */
  openNew(key: string, from: W | undefined): void;
  /** This window shows the workspace instead of its own. */
  switchTo(win: W, key: string): void;
  /** What would be left behind if this window stopped showing its workspace, in words. */
  liveWork(win: W, workspace: string): Promise<string[]>;
  ask(win: W, prompt: QuitPrompt): Promise<boolean>;
  /** The folder goes to the top of the recents. */
  remember(key: string): void;
}

export interface OpenRequest<W> {
  /** The window the folder was chosen in: undefined from the Dock, or with no window focused. */
  from: W | undefined;
  path: string;
  /** The person asked for a window of its own. */
  newWindow?: boolean;
}

export type OpenOutcome = 'focused' | 'opened' | 'switched' | 'cancelled';

/**
 * Where a folder chosen in a window opens (ADR-0063 H6). An open one is
 * focused, wherever it is. A project window with nothing live switches to it
 * in place, as an editor does; one with live work is never left behind
 * mid-way, so the folder gets a window of its own once the person agrees, and
 * Cancel leaves everything, the recents included, as it was.
 */
export async function openProject<W>(ports: SwitchPorts<W>, request: OpenRequest<W>): Promise<OpenOutcome> {
  const key = ports.keyOf(request.path);
  const existing = ports.windowOf(key);
  if (existing) {
    ports.focus(existing);
    ports.remember(key);
    return 'focused';
  }
  const from = request.from;
  const current = from === undefined ? undefined : ports.workspaceOf(from);
  if (from !== undefined && current !== undefined && !request.newWindow) {
    const live = await ports.liveWork(from, current);
    if (live.length === 0) {
      ports.switchTo(from, key);
      ports.remember(key);
      return 'switched';
    }
    if (!(await ports.ask(from, switchPrompt(key, live)))) return 'cancelled';
  }
  ports.openNew(key, from);
  ports.remember(key);
  return 'opened';
}

function switchPrompt(key: string, live: readonly string[]): QuitPrompt {
  return {
    message: `This window has work in progress. Open “${basename(key) || key}” in a new window?`,
    detail: `${live.join('\n')}\n\nIt goes on in this window; nothing is stopped.`,
    confirmLabel: 'Open in New Window',
  };
}

/** A page's report, kept to the kinds there are: anything else it sends is dropped. */
export function parseLiveWork(value: unknown): LiveWorkKind[] {
  if (!Array.isArray(value)) return [];
  return LIVE_WORK_KINDS.filter((kind) => value.includes(kind));
}

export interface LiveWorkFacts {
  /** What the window's page last reported. */
  reported: readonly LiveWorkKind[];
  /** The daemon's live runs in this workspace, or undefined when it could not be checked. */
  runs: readonly LiveRun[] | undefined;
  busyTerminals: number;
}

/**
 * What switching a window away would leave behind, in words, from the page
 * and from main's own sources: the daemon may hold a run the page has not
 * drawn yet, and a terminal's process ends with its page.
 */
export function liveWorkReasons(facts: LiveWorkFacts): string[] {
  const reasons: string[] = [];
  if (facts.runs && facts.runs.length > 0) reasons.push(`A run is in progress: ${facts.runs.map((run) => run.goal).join(', ')}.`);
  else if (facts.reported.includes('run')) reasons.push('A run is in progress.');
  else if (facts.runs === undefined) reasons.push('Ordewell could not check the daemon for runs.');
  if (facts.reported.includes('needsYou')) reasons.push('Something in Needs you is waiting for your answer.');
  if (facts.reported.includes('checkpoint')) reasons.push('A checkpoint is waiting for your answer.');
  if (facts.reported.includes('planner')) reasons.push('The planner is in the middle of a turn.');
  if (facts.busyTerminals === 1) reasons.push('A terminal is running a process; switching would end it.');
  else if (facts.busyTerminals > 1) reasons.push(`${facts.busyTerminals} terminals are running a process; switching would end them.`);
  return reasons;
}
