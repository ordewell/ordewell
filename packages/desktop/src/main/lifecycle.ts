import type { LiveRun } from './daemon/liveRuns';

/** What closing the last window does: a live run keeps the app in the tray, so its windows can come back to it. */
export function onLastWindowClosed(liveRuns: readonly LiveRun[] | undefined, platform: NodeJS.Platform): 'tray' | 'quit' | 'stay' {
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
 * Whether quitting asks first, and what it says happens (ADR-0060 H5). With
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

function runPrompt(liveRuns: readonly LiveRun[] | undefined, owned: boolean): QuitPrompt | undefined {
  if (liveRuns !== undefined && liveRuns.length === 0) return undefined;
  const names = liveRuns && liveRuns.length > 0
    ? liveRuns.map((run) => `• ${run.goal} (${run.workspace})`).join('\n')
    : 'Ordewell could not check the daemon for runs.';
  const count = liveRuns?.length ?? 0;
  const runs = count === 1 ? 'A run is' : count > 1 ? `${count} runs are` : 'A run may be';
  if (owned) {
    return {
      message: `${runs} in progress. Quit and stop ${count === 1 ? 'it' : 'them'}?`,
      detail: `${names}\n\nThis app started the daemon these runs belong to, so quitting stops the daemon and the runs with it.`,
      confirmLabel: 'Stop and quit',
    };
  }
  return {
    message: `${runs} in progress. Quit Ordewell?`,
    detail: `${names}\n\nThe daemon was already running when this app connected, so it keeps running and the runs go on. Reopen Ordewell, or use the CLI, to follow them.`,
    confirmLabel: 'Quit',
  };
}
