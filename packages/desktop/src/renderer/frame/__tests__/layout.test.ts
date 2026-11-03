import { describe, expect, it } from 'vitest';
import { activeTab, initialLayout, PANE_BOUNDS, reduceLayout, tabKey, type Layout, type LayoutAction, type TabRef } from '../layout';

const SIZES = { sidebar: 260, right: 360, bottom: 240 };
const file = (id: string): TabRef => ({ kind: 'file', id, title: id });
const run = (...actions: LayoutAction[]): Layout => actions.reduce(reduceLayout, initialLayout(SIZES));
const titles = (layout: Layout, group = 0): string[] => layout.groups[group].tabs.map((tab) => tab.title);

describe('reduceLayout', () => {
  it('starts on the pinned Plan tab, the Plan sidebar and the planner, with the terminal hidden', () => {
    const layout = initialLayout(SIZES);
    expect(titles(layout)).toEqual(['Plan']);
    expect(layout.groups[0].tabs[0].fixed).toBe(true);
    expect(layout).toMatchObject({ activity: 'plan', sidebarOpen: true, rightOpen: true, bottomOpen: false });
  });

  it('replaces a preview with the next preview, and keeps a kept one', () => {
    let layout = run({ type: 'open', tab: file('a'), preview: true }, { type: 'open', tab: file('b'), preview: true });
    expect(titles(layout)).toEqual(['Plan', 'b']);
    layout = reduceLayout(layout, { type: 'keep', group: 0, key: tabKey(file('b')) });
    layout = reduceLayout(layout, { type: 'open', tab: file('c'), preview: true });
    expect(titles(layout)).toEqual(['Plan', 'b', 'c']);
    expect(layout.groups[0].tabs.map((tab) => tab.preview)).toEqual([false, false, true]);
  });

  it('keeps a preview opened again for keeps, and shows an open tab rather than opening it twice', () => {
    const layout = run({ type: 'open', tab: file('a'), preview: true }, { type: 'open', tab: file('a') });
    expect(titles(layout)).toEqual(['Plan', 'a']);
    expect(layout.groups[0].tabs[1].preview).toBe(false);
  });

  it('never closes or moves the Plan tab', () => {
    const plan = tabKey({ kind: 'plan', id: 'plan' });
    let layout = run({ type: 'open', tab: file('a') }, { type: 'close', group: 0, key: plan });
    expect(titles(layout)).toEqual(['Plan', 'a']);
    layout = reduceLayout(layout, { type: 'move', group: 0, key: tabKey(file('a')), to: 0 });
    expect(titles(layout)).toEqual(['Plan', 'a']);
    layout = reduceLayout(layout, { type: 'activate', group: 0, key: plan });
    expect(reduceLayout(layout, { type: 'closeActive' })).toBe(layout);
  });

  it('activates the neighbour of a closed active tab', () => {
    const layout = run(
      { type: 'open', tab: file('a') }, { type: 'open', tab: file('b') }, { type: 'open', tab: file('c') },
      { type: 'activate', group: 0, key: tabKey(file('b')) }, { type: 'closeActive' },
    );
    expect(titles(layout)).toEqual(['Plan', 'a', 'c']);
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
    expect(titles(layout, 0)).toEqual(['Plan', 'b']);
  });

  it('reorders behind the pinned tab and cycles through the focused group', () => {
    let layout = run({ type: 'open', tab: file('a') }, { type: 'open', tab: file('b') });
    layout = reduceLayout(layout, { type: 'move', group: 0, key: tabKey(file('b')), to: 0 });
    expect(titles(layout)).toEqual(['Plan', 'b', 'a']);
    layout = reduceLayout(layout, { type: 'cycle', delta: 1 });
    expect(activeTab(layout.groups[0])?.title).toBe('a');
    layout = reduceLayout(layout, { type: 'cycle', delta: 1 });
    expect(activeTab(layout.groups[0])?.title).toBe('Plan');
  });

  it('hides the sidebar on a click on the active activity, not on its shortcut', () => {
    expect(run({ type: 'activity', activity: 'plan', toggle: true }).sidebarOpen).toBe(false);
    expect(run({ type: 'activity', activity: 'plan' }).sidebarOpen).toBe(true);
    expect(run({ type: 'activity', activity: 'plan', toggle: true }, { type: 'activity', activity: 'git', toggle: true }))
      .toMatchObject({ activity: 'git', sidebarOpen: true });
  });

  it('keeps pane sizes inside their bounds', () => {
    expect(run({ type: 'resize', pane: 'sidebar', size: 5 }).sizes.sidebar).toBe(PANE_BOUNDS.sidebar.min);
    expect(run({ type: 'resize', pane: 'bottom', size: 99_999 }).sizes.bottom).toBe(PANE_BOUNDS.bottom.max);
    expect(initialLayout({ sidebar: 0, right: 0, bottom: 0 }).sizes.right).toBe(PANE_BOUNDS.right.min);
  });

  it('keeps a file open once per view scope', () => {
    const inIntegration: TabRef = { ...file('a'), scope: { kind: 'integration', sessionId: 's1' } };
    const layout = run({ type: 'open', tab: file('a') }, { type: 'open', tab: inIntegration });
    expect(titles(layout)).toEqual(['Plan', 'a', 'a']);
  });
});
