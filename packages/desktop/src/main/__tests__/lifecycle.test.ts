import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findLiveRuns, type DaemonGet } from '../daemon/liveRuns';
import { closePrompt, guardClose, onLastWindowClosed, quitPrompt, runsQuitStops } from '../lifecycle';
import { isInside } from '../paths';

const run = { sessionId: 's1', goal: 'Ship it', workspace: '/w' };
const joined = { sessionId: 's9', goal: 'Joined', workspace: '/w', elsewhere: true as const };

/**
 * The app's daemon as it answers mid-run: s1's plan saved approved, at work in
 * this daemon; s9 held by another host, known by its lease; s2 settled.
 */
function daemonMidRun(options: { s1Live?: boolean; s9Live?: boolean } = {}): DaemonGet {
  const { s1Live = true, s9Live = false } = options;
  const rows = [
    { id: 's1', status: 'approved', goal: 'Ship it', ...(s1Live ? { run: { live: true, done: 1, total: 2 } } : {}) },
    { id: 's2', status: 'approved', goal: 'Settled' },
    { id: 's9', status: 'approved', goal: 'Joined', ...(s9Live ? { run: { live: true } } : {}) },
  ];
  const sessions: Record<string, unknown> = {
    s1: { meta: { status: 'approved' }, run: { tasks: [], activity: { starting: false, running: s1Live, scheduled: false, advancesOnItsOwn: s1Live } } },
    s9: { meta: { status: 'approved' } },
  };
  return async (routeId, params) => {
    if (routeId === 'workspaces.list') return { ok: true, data: { workspaces: ['/w'] } };
    if (routeId === 'sessions.list') return { ok: true, data: rows };
    const id = params && typeof params === 'object' ? Reflect.get(params, 'id') : undefined;
    return routeId === 'sessions.get' && typeof id === 'string' && id in sessions ? { ok: true, data: sessions[id] } : { ok: false };
  };
}

describe('closing the last window, as the daemon answers (ADR-0063 H5)', () => {
  it('keeps the tray under a run whose plan is saved approved, and quits once it settled', async () => {
    expect(onLastWindowClosed(await findLiveRuns(daemonMidRun()), 'linux')).toBe('tray');
    expect(onLastWindowClosed(await findLiveRuns(daemonMidRun({ s1Live: false })), 'linux')).toBe('quit');
  });

  it('keeps the tray under a joined session\'s run: the app is how the user gets back to it', async () => {
    expect(onLastWindowClosed(await findLiveRuns(daemonMidRun({ s1Live: false, s9Live: true })), 'win32')).toBe('tray');
  });

  it('keeps the tray when the daemon cannot be read', async () => {
    expect(onLastWindowClosed(await findLiveRuns(async () => ({ ok: false })), 'linux')).toBe('tray');
  });
});

describe('quitting, as the daemon answers (ADR-0063 H5)', () => {
  it('asks to stop an owned daemon\'s run whose plan is saved approved, and stops only that one', async () => {
    const live = await findLiveRuns(daemonMidRun({ s9Live: true }));
    const prompt = quitPrompt(live, true);
    expect(prompt?.message).toBe('A run is in progress. Quit and stop it?');
    expect(prompt?.detail).toContain('• Ship it (/w)');
    expect(prompt?.detail).toContain('Another host holds this one, so it goes on:\n• Joined (/w)');
    expect(prompt?.confirmLabel).toBe('Stop and quit');
    expect(runsQuitStops(live, true)).toEqual([run]);
  });

  it('says a run another host holds goes on, though this app owns its daemon', () => {
    const prompt = quitPrompt([joined], true);
    expect(prompt?.message).toBe('A run is in progress. Quit Ordewell?');
    expect(prompt?.detail).toContain('• Joined (/w)');
    expect(prompt?.detail).toContain('Another host holds it, so it goes on');
    expect(prompt?.detail).not.toContain('stops the daemon');
    expect(prompt?.confirmLabel).toBe('Quit');
    expect(runsQuitStops([joined], true)).toEqual([]);
  });

  it('stops nothing in a daemon it attached to, or when the runs could not be checked', () => {
    expect(runsQuitStops([run], false)).toEqual([]);
    expect(runsQuitStops(undefined, true)).toEqual([]);
  });
});

describe('onLastWindowClosed (ADR-0063 H5)', () => {
  it('keeps the app in the tray while a run is live, or when that cannot be told', () => {
    expect(onLastWindowClosed([run], 'linux')).toBe('tray');
    expect(onLastWindowClosed([run], 'darwin')).toBe('tray');
    expect(onLastWindowClosed(undefined, 'win32')).toBe('tray');
  });

  it('quits with nothing live, except on macOS where the app stays in the Dock', () => {
    expect(onLastWindowClosed([], 'linux')).toBe('quit');
    expect(onLastWindowClosed([], 'win32')).toBe('quit');
    expect(onLastWindowClosed([], 'darwin')).toBe('stay');
  });

  it('keeps the app in the tray when the user asked it to, even with nothing live', () => {
    expect(onLastWindowClosed([], 'linux', true)).toBe('tray');
    expect(onLastWindowClosed([], 'win32', true)).toBe('tray');
    expect(onLastWindowClosed([], 'darwin', true)).toBe('stay');
    expect(onLastWindowClosed([run], 'linux', false)).toBe('tray');
  });
});

describe('quitPrompt (ADR-0063 H5)', () => {
  it('does not ask when nothing is live', () => {
    expect(quitPrompt([], true)).toBeUndefined();
    expect(quitPrompt([], false)).toBeUndefined();
  });

  it('says an owned daemon\'s runs stop with the app', () => {
    const prompt = quitPrompt([run], true);
    expect(prompt?.message).toBe('A run is in progress. Quit and stop it?');
    expect(prompt?.detail).toContain('• Ship it (/w)');
    expect(prompt?.detail).toContain('quitting stops the daemon and the runs with it');
    expect(prompt?.confirmLabel).toBe('Stop and quit');
  });

  it('says an attached daemon\'s runs go on', () => {
    const prompt = quitPrompt([run, { ...run, sessionId: 's2' }], false);
    expect(prompt?.message).toBe('2 runs are in progress. Quit Ordewell?');
    expect(prompt?.detail).toContain('keeps running and the runs go on');
    expect(prompt?.confirmLabel).toBe('Quit');
  });

  it('still asks when the runs could not be checked', () => {
    const prompt = quitPrompt(undefined, true);
    expect(prompt?.message).toBe('A run may be in progress. Quit and stop them?');
    expect(prompt?.detail).toContain('could not check the daemon');
  });
});

describe('isInside', () => {
  const root = resolve('/bundle/renderer');

  it('accepts a file under the root', () => {
    expect(isInside(root, join(root, 'index.html'))).toBe(true);
    expect(isInside(root, join(root, 'assets', 'a.js'))).toBe(true);
  });

  it('refuses the root itself, a sibling and anything above', () => {
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, resolve('/bundle/renderer-evil/x.js'))).toBe(false);
    expect(isInside(root, resolve(root, '..', 'main', 'index.js'))).toBe(false);
    expect(isInside(root, resolve('/etc/passwd'))).toBe(false);
  });

  it('accepts a file whose name merely starts with two dots', () => {
    expect(isInside(root, join(root, '..hidden'))).toBe(true);
  });
});

describe('quitPrompt with terminals (ADR-0062 G11)', () => {
  it('does not ask for a terminal sitting at its prompt', () => {
    expect(quitPrompt([], true, 0)).toBeUndefined();
  });

  it('asks when a terminal is running a process, with no run live', () => {
    const one = quitPrompt([], false, 1);
    expect(one?.message).toBe('A terminal is running a process. Quit Ordewell?');
    expect(quitPrompt([], false, 3)?.message).toBe('3 terminals are running a process. Quit Ordewell?');
  });

  it('asks the run question and the terminal one together', () => {
    const prompt = quitPrompt([run], true, 2);
    expect(prompt?.message).toBe('A run is in progress. Quit and stop it?');
    expect(prompt?.detail).toContain('2 terminals are running a process');
    expect(prompt?.confirmLabel).toBe('Stop and quit');
  });
});

describe('closing a window with a terminal at work (ADR-0062 G11)', () => {
  it('asks only when one of the window\'s terminals is running a process', () => {
    expect(closePrompt(0)).toBeUndefined();
    expect(closePrompt(1)).toEqual({
      message: 'A terminal is running a process. Close this window?',
      detail: 'Closing the window ends it.',
      confirmLabel: 'Close',
    });
    expect(closePrompt(2)?.message).toBe('2 terminals are running a process. Close this window?');
  });

  function closing(answers: Array<boolean | undefined>) {
    let answer: (ok: boolean) => void = () => undefined;
    const asked = vi.fn(() => {
      const next = answers.shift();
      return next === undefined ? undefined : new Promise<boolean>((resolve) => { answer = resolve; });
    });
    const close = vi.fn();
    const onClose = guardClose(asked, close);
    const attempt = () => { const event = { preventDefault: vi.fn() }; onClose(event); return event; };
    return { asked, close, attempt, answer: (ok: boolean) => answer(ok) };
  }

  it('lets a window with nothing to lose close at once', () => {
    const { attempt } = closing([undefined]);
    expect(attempt().preventDefault).not.toHaveBeenCalled();
  });

  it('holds the close for the answer, and closes once the person agrees', async () => {
    const { attempt, answer, close } = closing([true]);
    expect(attempt().preventDefault).toHaveBeenCalled();
    // A second click while the question is up asks nothing more.
    expect(attempt().preventDefault).toHaveBeenCalled();
    answer(true);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    // The close it makes is not asked about again.
    expect(attempt().preventDefault).not.toHaveBeenCalled();
  });

  it('keeps the window and its terminals on Cancel, and asks again next time', async () => {
    const { attempt, answer, close, asked } = closing([true, true]);
    attempt();
    answer(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).not.toHaveBeenCalled();
    expect(attempt().preventDefault).toHaveBeenCalled();
    expect(asked).toHaveBeenCalledTimes(2);
  });
});
