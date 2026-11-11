import type { LiveRun } from './daemon/liveRuns';

/** What closing the last window does: a live run — or the user's tray choice — keeps the app, so its windows can come back to it. */
export function onLastWindowClosed(liveRuns: readonly LiveRun[] | undefined, platform: NodeJS.Platform, keepInTray = false): 'tray' | 'quit' | 'stay' {
  if (keepInTray) return platform === 'darwin' ? 'stay' : 'tray';
  if (liveRuns === undefined || liveRuns.length > 0) return 'tray';
  // A macOS app stays in the Dock with no window, as every app there does.
  return platform === 'darwin' ? 'stay' : 'quit';
}

export interface QuitPrompt {
  message: string;
  detail: string;
  confirmLabel: string;
}

/**
 * Whether quitting asks first, and what it says happens (ADR-0063 H5). With
 * the daemon this app started, quitting stops it and every run in it. With
 * one it attached to, the runs go on there: nothing is stopped. A terminal
 * running a process is asked about in the same dialog, since quitting ends it
 * (ADR-0062 G11); a terminal at its prompt has nothing to lose.
 */
export function quitPrompt(liveRuns: readonly LiveRun[] | undefined, owned: boolean, busyTerminals = 0): QuitPrompt | undefined {
  const terminals = busyTerminals === 1
    ? 'A terminal is running a process, and quitting ends it.'
    : `${busyTerminals} terminals are running a process, and quitting ends them.`;
  const runs = runPrompt(liveRuns, owned);
  if (!runs) {
    return busyTerminals > 0
      ? { message: busyTerminals === 1 ? 'A terminal is running a process. Quit Ordewell?' : `${busyTerminals} terminals are running a process. Quit Ordewell?`, detail: terminals, confirmLabel: 'Quit' }
      : undefined;
  }
  return busyTerminals > 0 ? { ...runs, detail: `${runs.detail}\n\n${terminals}` } : runs;
}

/** Whether closing one window asks first: it ends that window's terminals, and a busy one has work to lose (ADR-0062 G11). */
export function closePrompt(busyTerminals: number): QuitPrompt | undefined {
  if (busyTerminals <= 0) return undefined;
  return {
    message: busyTerminals === 1 ? 'A terminal is running a process. Close this window?' : `${busyTerminals} terminals are running a process. Close this window?`,
    detail: busyTerminals === 1 ? 'Closing the window ends it.' : 'Closing the window ends them.',
    confirmLabel: 'Close',
  };
}

/**
 * A window's `close` handler that holds the close while `ask` waits for an
 * answer, and closes once it is yes. `ask` answers undefined when there is
 * nothing to ask. A close made by the yes is let through, and a click while
 * the question is up asks nothing more.
 */
export function guardClose(
  ask: () => Promise<boolean> | undefined,
  close: () => void,
): (event: { preventDefault(): void }) => void {
  let asking = false;
  let agreed = false;
  return (event) => {
    if (agreed) return;
    if (asking) { event.preventDefault(); return; }
    const answer = ask();
    if (!answer) return;
    event.preventDefault();
    asking = true;
    void answer.then((yes) => {
      asking = false;
      if (!yes) return;
      agreed = true;
      close();
    }, () => { asking = false; });
  };
}

/**
 * The runs quitting stops through the daemon before it goes, so each records
 * a stop rather than a crash: an owned daemon's own. An attached daemon's go
 * on, and so does a run another host holds, whoever owns this daemon (H5).
 */
export function runsQuitStops(liveRuns: readonly LiveRun[] | undefined, owned: boolean): LiveRun[] {
  return owned && liveRuns ? liveRuns.filter((run) => !run.elsewhere) : [];
}

const inProgress = (count: number): string => (count === 1 ? 'A run is' : count > 1 ? `${count} runs are` : 'A run may be');
/** The runs by name, or, with none to name because none could be read, that. */
const named = (runs: readonly LiveRun[]): string => (runs.length > 0
  ? runs.map((run) => `• ${run.goal} (${run.workspace})`).join('\n')
  : 'Ordewell could not check the daemon for runs.');

function runPrompt(liveRuns: readonly LiveRun[] | undefined, owned: boolean): QuitPrompt | undefined {
  if (liveRuns !== undefined && liveRuns.length === 0) return undefined;
  const stops = runsQuitStops(liveRuns, owned);
  if (owned && (liveRuns === undefined || stops.length > 0)) {
    const goesOn = liveRuns?.filter((run) => run.elsewhere) ?? [];
    const elsewhere = goesOn.length === 0 ? '' : `\n\nAnother host holds ${goesOn.length === 1 ? 'this one, so it goes' : 'these, so they go'} on:\n${named(goesOn)}`;
    return {
      message: `${inProgress(stops.length)} in progress. Quit and stop ${stops.length === 1 ? 'it' : 'them'}?`,
      detail: `${named(stops)}\n\nThis app started the daemon these runs belong to, so quitting stops the daemon and the runs with it.${elsewhere}`,
      confirmLabel: 'Stop and quit',
    };
  }
  const runs = liveRuns ?? [];
  // Owned with nothing of its own to stop: every run named is another host's.
  const why = owned
    ? `Another host holds ${runs.length === 1 ? 'it, so it goes' : 'them, so they go'} on.`
    : 'The daemon was already running when this app connected, so it keeps running and the runs go on.';
  return {
    message: `${inProgress(runs.length)} in progress. Quit Ordewell?`,
    detail: `${named(runs)}\n\n${why} Reopen Ordewell, or use the CLI, to follow them.`,
    confirmLabel: 'Quit',
  };
}
