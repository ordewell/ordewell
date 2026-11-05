import { describe, expect, it } from 'vitest';
import {
  activeTab, bandDefaults, CENTRE_MIN, initialLayout, PLANNER_TAB, paneBounds, paneSizes, reduceLayout, savedLayout, shown,
  tabKey, widthLimit, type Layout, type LayoutAction, type TabRef, type Viewport,
} from '../layout';

const WIDE: Viewport = { width: 1512, height: 982 };
const file = (id: string): TabRef => ({ kind: 'file', id, title: id });
const run = (...actions: LayoutAction[]): Layout => actions.reduce(reduceLayout, initialLayout(WIDE));
const at = (width: number, height = 900): LayoutAction => ({ type: 'viewport', viewport: { width, height } });
const titles = (layout: Layout, group = 0): string[] => layout.groups[group].tabs.map((tab) => tab.title);

describe('reduceLayout', () => {
  it('starts on the pinned Planner tab, the Sessions sidebar and the plan panel, with the terminal hidden', () => {
    const layout = initialLayout(WIDE);
    expect(titles(layout)).toEqual(['Planner']);
    expect(layout.groups[0].tabs[0]).toMatchObject({ kind: 'planner', fixed: true });
    expect(layout).toMatchObject({ activity: 'sessions', sidebarOpen: true, planOpen: true, terminalOpen: false, drawer: undefined });
    expect(shown(layout)).toEqual({ sidebar: true, plan: true });
  });

  it('swaps a session\'s task and diff tabs out on a switch and brings them back, keeping files', () => {
    const task = (sessionId: string, taskId: string): TabRef => ({ kind: 'task', id: taskId, title: `${sessionId}/${taskId}`, scope: { kind: 'task', sessionId, taskId } });
    const diff: TabRef = { kind: 'diff', id: 'a.ts', title: 'a.ts (Integration)', scope: { kind: 'integration', sessionId: 's1' } };
    let layout = run(
      { type: 'session', sessionId: 's1' },
      { type: 'open', tab: task('s1', 't1') },
      { type: 'open', tab: file('README.md') },
      { type: 'open', tab: diff },
      { type: 'open', tab: task('s1', 't2'), group: 1 },
    );
    layout = reduceLayout(layout, { type: 'activate', group: 0, key: tabKey(task('s1', 't1')) });

    layout = reduceLayout(layout, { type: 'session', sessionId: 's2' });
    expect(layout.groups).toHaveLength(1);
    expect(titles(layout)).toEqual(['Planner', 'README.md']);
    expect(activeTab(layout.groups[0])?.title).toBe('Planner');

    layout = reduceLayout(layout, { type: 'open', tab: task('s2', 't9') });
    layout = reduceLayout(layout, { type: 'session', sessionId: 's1' });
    expect(titles(layout)).toEqual(['Planner', 'README.md', 's1/t1', 'a.ts (Integration)']);
    expect(titles(layout, 1)).toEqual(['s1/t2']);
    expect(activeTab(layout.groups[0])?.title).toBe('s1/t1');

    layout = reduceLayout(layout, { type: 'session', sessionId: 's2' });
    expect(titles(layout)).toEqual(['Planner', 'README.md', 's2/t9']);
    expect(reduceLayout(layout, { type: 'session', sessionId: 's2' })).toBe(layout);
  });

  it('replaces a preview with the next preview, and keeps a kept one', () => {
    let layout = run({ type: 'open', tab: file('a'), preview: true }, { type: 'open', tab: file('b'), preview: true });
    expect(titles(layout)).toEqual(['Planner', 'b']);
    layout = reduceLayout(layout, { type: 'keep', group: 0, key: tabKey(file('b')) });
    layout = reduceLayout(layout, { type: 'open', tab: file('c'), preview: true });
    expect(titles(layout)).toEqual(['Planner', 'b', 'c']);
    expect(layout.groups[0].tabs.map((tab) => tab.preview)).toEqual([false, false, true]);
  });

  it('keeps a preview opened again for keeps, and shows an open tab rather than opening it twice', () => {
    const layout = run({ type: 'open', tab: file('a'), preview: true }, { type: 'open', tab: file('a') });
    expect(titles(layout)).toEqual(['Planner', 'a']);
    expect(layout.groups[0].tabs[1].preview).toBe(false);
  });

  it('never closes or moves the Planner tab', () => {
    const plan = tabKey(PLANNER_TAB);
    let layout = run({ type: 'open', tab: file('a') }, { type: 'close', group: 0, key: plan });
    expect(titles(layout)).toEqual(['Planner', 'a']);
    layout = reduceLayout(layout, { type: 'move', group: 0, key: tabKey(file('a')), to: 0 });
    expect(titles(layout)).toEqual(['Planner', 'a']);
    layout = reduceLayout(layout, { type: 'activate', group: 0, key: plan });
    expect(reduceLayout(layout, { type: 'closeActive' })).toBe(layout);
  });

  it('activates the neighbour of a closed active tab', () => {
    const layout = run(
      { type: 'open', tab: file('a') }, { type: 'open', tab: file('b') }, { type: 'open', tab: file('c') },
      { type: 'activate', group: 0, key: tabKey(file('b')) }, { type: 'closeActive' },
    );
    expect(titles(layout)).toEqual(['Planner', 'a', 'c']);
    expect(activeTab(layout.groups[0])?.title).toBe('c');
  });

  it('splits the active tab into a second group, and drops a group its last tab leaves', () => {
    let layout = run({ type: 'open', tab: file('a') }, { type: 'split' });
    expect(layout.groups).toHaveLength(2);
    expect(titles(layout, 1)).toEqual(['a']);
    expect(layout.focusedGroup).toBe(1);
    layout = reduceLayout(layout, { type: 'closeActive' });
    expect(layout.groups).toHaveLength(1);
    expect(layout.focusedGroup).toBe(0);
  });

  it('opens beside into the other group, creating it once', () => {
    let layout = run({ type: 'open', tab: file('a'), group: 1 });
    expect(titles(layout, 1)).toEqual(['a']);
    expect(reduceLayout(layout, { type: 'open', tab: file('b'), group: 2 })).toBe(layout);
    layout = reduceLayout(layout, { type: 'open', tab: file('b'), group: 0 });
    expect(titles(layout, 0)).toEqual(['Planner', 'b']);
  });

  it('reorders behind the pinned tab and cycles through the focused group', () => {
    let layout = run({ type: 'open', tab: file('a') }, { type: 'open', tab: file('b') });
    layout = reduceLayout(layout, { type: 'move', group: 0, key: tabKey(file('b')), to: 0 });
    expect(titles(layout)).toEqual(['Planner', 'b', 'a']);
    layout = reduceLayout(layout, { type: 'cycle', delta: 1 });
    expect(activeTab(layout.groups[0])?.title).toBe('a');
    layout = reduceLayout(layout, { type: 'cycle', delta: 1 });
    expect(activeTab(layout.groups[0])?.title).toBe('Planner');
  });

  it('hides the sidebar on a click on the active activity, not on its shortcut', () => {
    expect(run({ type: 'activity', activity: 'sessions', toggle: true }).sidebarOpen).toBe(false);
    expect(run({ type: 'activity', activity: 'sessions' }).sidebarOpen).toBe(true);
    expect(run({ type: 'activity', activity: 'sessions', toggle: true }, { type: 'activity', activity: 'git', toggle: true }))
      .toMatchObject({ activity: 'git', sidebarOpen: true });
  });

  it('sizes the panels by the window band until the user drags one', () => {
    expect(bandDefaults(1280)).toEqual({ sidebar: 240, plan: 340, terminal: 240 });
    expect(bandDefaults(1512)).toEqual({ sidebar: 260, plan: 360, terminal: 240 });
    expect(bandDefaults(1920)).toEqual({ sidebar: 280, plan: 380, terminal: 280 });
    let layout = run({ type: 'resize', pane: 'plan', size: 400 });
    expect(paneSizes(layout).plan).toBe(400);
    layout = reduceLayout(layout, at(1920, 1080));
    expect(paneSizes(layout)).toMatchObject({ sidebar: 280, plan: 400 });
  });

  it('keeps pane sizes inside their bounds, and the centre at its minimum', () => {
    expect(paneSizes(run({ type: 'resize', pane: 'sidebar', size: 5 })).sidebar).toBe(200);
    expect(paneSizes(run(at(2560, 1440), { type: 'resize', pane: 'plan', size: 99_999 })).plan).toBe(560);
    const tall = run({ type: 'resize', pane: 'terminal', size: 99_999 });
    expect(paneSizes(tall).terminal).toBe(paneBounds('terminal', WIDE).max);
    expect(paneBounds('terminal', WIDE).max).toBeLessThanOrEqual(WIDE.height * 0.6);
    // 1512 - 52 activity - 260 sidebar - 560 centre leaves the plan 640, over its own 560.
    const layout = run({ type: 'resize', pane: 'plan', size: 99_999 });
    expect(widthLimit(layout, 'plan')).toBe(560);
    const narrow = run(at(1300));
    expect(widthLimit(narrow, 'sidebar')).toBe(1300 - 52 - 340 - CENTRE_MIN);
  });

  it('hides the sidebar first, then turns the plan panel into its rail, as the window narrows', () => {
    // 52 + 240 + 340 + 560: the sidebar's threshold in the 1280 band; 52 + 340 + 560: the plan's.
    expect(shown(run(at(1200)))).toEqual({ sidebar: true, plan: true });
    expect(shown(run(at(1190)))).toEqual({ sidebar: false, plan: true });
    expect(shown(run(at(960)))).toEqual({ sidebar: false, plan: true });
    expect(shown(run(at(950)))).toEqual({ sidebar: false, plan: false });
    // The user's own choices are kept for when the window widens again.
    expect(run(at(950))).toMatchObject({ sidebarOpen: true, planOpen: true });
  });

  it('gives a squeezed panel back only once the window is wider than its threshold by the hysteresis', () => {
    expect(shown(run(at(1190), at(1200))).sidebar).toBe(false);
    expect(shown(run(at(1190), at(1192 + 24))).sidebar).toBe(true);
  });

  it('opens a squeezed panel as a drawer, and closes the drawer on a pick or once it docks', () => {
    let layout = run(at(1000), { type: 'activity', activity: 'git' });
    expect(layout).toMatchObject({ activity: 'git', drawer: 'sidebar', sidebarOpen: true });
    layout = reduceLayout(layout, { type: 'open', tab: file('a') });
    expect(layout.drawer).toBeUndefined();
    layout = run(at(900), { type: 'drawer', drawer: 'plan', filter: 'running' });
    expect(layout).toMatchObject({ drawer: 'plan', planFilter: 'running' });
    expect(reduceLayout(layout, { type: 'closeDrawer' })).toMatchObject({ drawer: undefined, planFilter: undefined });
    expect(reduceLayout(layout, at(1400)).drawer).toBeUndefined();
    // Wide enough for the plan panel to dock while the sidebar is still squeezed: one Plan, not the drawer over the docked panel.
    const docked = reduceLayout(layout, at(1100));
    expect(shown(docked)).toEqual({ sidebar: false, plan: true });
    expect(docked.drawer).toBeUndefined();
    expect(run(at(1100), { type: 'togglePlan', open: false }, { type: 'drawer', drawer: 'plan' }, at(1000)).drawer).toBe('plan');
  });

  it('collapses the plan panel to its rail and back, opening it over the centre when it cannot dock', () => {
    let layout = run({ type: 'togglePlan', open: false });
    expect(shown(layout).plan).toBe(false);
    layout = reduceLayout(layout, { type: 'togglePlan', open: true });
    expect(shown(layout).plan).toBe(true);
    expect(run(at(900), { type: 'togglePlan', open: true }).drawer).toBe('plan');
  });

  it('keeps the user\'s choices, not what the width did, and resets them', () => {
    const layout = run({ type: 'resize', pane: 'sidebar', size: 300 }, { type: 'toggleTerminal' }, { type: 'activity', activity: 'git' }, at(900));
    const saved = savedLayout(layout);
    expect(saved).toEqual({ sidebar: 300, activity: 'git', sidebarOpen: true, planOpen: true, terminalOpen: true });
    const again = initialLayout(WIDE, saved);
    expect(again).toMatchObject({ activity: 'git', terminalOpen: true });
    expect(paneSizes(again).sidebar).toBe(300);
    const reset = reduceLayout(again, { type: 'reset' });
    expect(reset).toMatchObject({ activity: 'sessions', sidebarOpen: true, planOpen: true, terminalOpen: false, userSizes: {} });
    expect(titles(reset)).toEqual(['Planner']);
  });

  it('keeps a file open once per view scope', () => {
    const inIntegration: TabRef = { ...file('a'), scope: { kind: 'integration', sessionId: 's1' } };
    const layout = run({ type: 'open', tab: file('a') }, { type: 'open', tab: inIntegration });
    expect(titles(layout)).toEqual(['Planner', 'a', 'a']);
  });
});
