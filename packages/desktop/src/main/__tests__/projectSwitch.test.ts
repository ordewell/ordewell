import { describe, expect, it } from 'vitest';
import { liveWorkReasons, openProject, parseLiveWork, type SwitchPorts } from '../projectSwitch';

/** One app's windows, as main sees them: a welcome window, or one holding a workspace. */
interface FakeWindow { name: string; workspace?: string }

function harness(windows: FakeWindow[], live: Record<string, string[]> = {}, answer = true) {
  const log: string[] = [];
  const asked: { message: string; detail: string; confirmLabel: string }[] = [];
  const recents: string[] = [];
  const ports: SwitchPorts<FakeWindow> = {
    keyOf: (path) => path.replace(/\/$/, ''),
    workspaceOf: (win) => win.workspace,
    windowOf: (key) => windows.find((win) => win.workspace === key),
    focus: (win) => { log.push(`focus ${win.name}`); },
    openNew: (key, from) => {
      log.push(`new ${key}${from ? ` from ${from.name}` : ''}`);
      windows.push({ name: `w${windows.length}`, workspace: key });
    },
    switchTo: (win, key) => { log.push(`switch ${win.name} to ${key}`); win.workspace = key; },
    liveWork: (win) => Promise.resolve(live[win.name] ?? []),
    ask: (_win, prompt) => { asked.push(prompt); return Promise.resolve(answer); },
    remember: (key) => { recents.push(key); },
  };
  return { ports, log, asked, recents, windows };
}

describe('openProject', () => {
  it('focuses the window a folder is already open in, and moves it to the top of the recents', async () => {
    const h = harness([{ name: 'a', workspace: '/repo/a' }, { name: 'b', workspace: '/repo/b' }]);
    const outcome = await openProject(h.ports, { from: h.windows[0], path: '/repo/b/' });
    expect(outcome).toBe('focused');
    expect(h.log).toEqual(['focus b']);
    expect(h.recents).toEqual(['/repo/b']);
  });

  it('switches a project window with nothing live to the folder, as an editor does', async () => {
    const h = harness([{ name: 'a', workspace: '/repo/a' }]);
    const outcome = await openProject(h.ports, { from: h.windows[0], path: '/repo/c' });
    expect(outcome).toBe('switched');
    expect(h.log).toEqual(['switch a to /repo/c']);
    expect(h.asked).toEqual([]);
    expect(h.recents).toEqual(['/repo/c']);
  });

  it('asks before leaving live work, and opens a new window on yes so nothing is stopped', async () => {
    const h = harness([{ name: 'a', workspace: '/repo/a' }], { a: ['A run is in progress.'] }, true);
    const outcome = await openProject(h.ports, { from: h.windows[0], path: '/repo/c' });
    expect(outcome).toBe('opened');
    expect(h.log).toEqual(['new /repo/c from a']);
    expect(h.asked).toEqual([{
      message: 'This window has work in progress. Open “c” in a new window?',
      detail: 'A run is in progress.\n\nIt goes on in this window; nothing is stopped.',
      confirmLabel: 'Open in New Window',
    }]);
    expect(h.windows[0].workspace).toBe('/repo/a');
    expect(h.recents).toEqual(['/repo/c']);
  });

  it('does nothing on Cancel, and leaves the recents as they were', async () => {
    const h = harness([{ name: 'a', workspace: '/repo/a' }], { a: ['A task is waiting for your approval.'] }, false);
    const outcome = await openProject(h.ports, { from: h.windows[0], path: '/repo/c' });
    expect(outcome).toBe('cancelled');
    expect(h.log).toEqual([]);
    expect(h.recents).toEqual([]);
  });

  it('opens a new window without asking when one was asked for', async () => {
    const h = harness([{ name: 'a', workspace: '/repo/a' }], { a: ['A run is in progress.'] });
    expect(await openProject(h.ports, { from: h.windows[0], path: '/repo/c', newWindow: true })).toBe('opened');
    expect(h.log).toEqual(['new /repo/c from a']);
    expect(h.asked).toEqual([]);
  });

  it('opens a new window from the welcome window, or with no window at all', async () => {
    const welcome = harness([{ name: 'welcome' }]);
    expect(await openProject(welcome.ports, { from: welcome.windows[0], path: '/repo/c' })).toBe('opened');
    expect(welcome.log).toEqual(['new /repo/c from welcome']);
    const none = harness([]);
    expect(await openProject(none.ports, { from: undefined, path: '/repo/c' })).toBe('opened');
    expect(none.log).toEqual(['new /repo/c']);
  });

  it('focuses its own window when the folder chosen is the one it shows', async () => {
    const h = harness([{ name: 'a', workspace: '/repo/a' }], { a: ['A run is in progress.'] });
    expect(await openProject(h.ports, { from: h.windows[0], path: '/repo/a' })).toBe('focused');
    expect(h.log).toEqual(['focus a']);
    expect(h.asked).toEqual([]);
  });
});

describe('liveWorkReasons', () => {
  const run = { sessionId: 's1', goal: 'Ship it', workspace: '/repo/a' };

  it('finds nothing live in an idle window', () => {
    expect(liveWorkReasons({ reported: [], runs: [], busyTerminals: 0 })).toEqual([]);
  });

  it('names what the page reports, a run the daemon has here, and busy terminals', () => {
    expect(liveWorkReasons({ reported: ['needsYou', 'checkpoint', 'planner'], runs: [run], busyTerminals: 2 })).toEqual([
      'A run is in progress: Ship it.',
      'Something in Needs you is waiting for your answer.',
      'A checkpoint is waiting for your answer.',
      'The planner is in the middle of a turn.',
      '2 terminals are running a process; switching would end them.',
    ]);
  });

  it('says a run once, whether the page or the daemon saw it', () => {
    expect(liveWorkReasons({ reported: ['run'], runs: [], busyTerminals: 1 })).toEqual([
      'A run is in progress.',
      'A terminal is running a process; switching would end it.',
    ]);
  });

  it('counts a daemon it could not check as live', () => {
    expect(liveWorkReasons({ reported: [], runs: undefined, busyTerminals: 0 })).toEqual(['Ordewell could not check the daemon for runs.']);
  });
});

describe('parseLiveWork', () => {
  it('keeps only the kinds it knows, each once, from whatever a page sends', () => {
    expect(parseLiveWork(['run', 'planner', 'run', 'rm -rf', 3])).toEqual(['run', 'planner']);
    expect(parseLiveWork('run')).toEqual([]);
    expect(parseLiveWork(undefined)).toEqual([]);
  });
});
