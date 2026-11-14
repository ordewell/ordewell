// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvent, TerminalOpenResult, TerminalOpenSpec } from '../../../../shared/bridge';
import type { FrameApi } from '../../../frame/api';
import { terms, type FakeTerm } from '../../../test/xtermMock';
import { TerminalStore } from '../terminalStore';

/** The grid the panel has room for; a new terminal fits to it, as every terminal in one panel would. */
const panel = vi.hoisted(() => ({ room: { cols: 100, rows: 30 } }));

vi.mock('../xterm', async () => {
  const fake = (await import('../../../test/xtermMock')).fakeXtermModule();
  return {
    createTerm: async (...args: Parameters<typeof fake.createTerm>) => {
      const term = await fake.createTerm(...args) as FakeTerm;
      term.grid = { ...panel.room };
      return term;
    },
  };
});
vi.mock('../../scope/scopeStore', () => ({ scopeStoreFor: () => ({ getSnapshot: () => ({ repo: '.', repos: ['.'], session: undefined }) }) }));

/**
 * Every tab's shell must be told the grid its own terminal is drawn at. A shell
 * that believes another width computes its line editing for it: near a wrap,
 * Backspace stops at the row's start and leaves erased characters on screen
 * (wrapDelete.test.ts shows that with real shells). Only the shown tab is ever
 * refitted, so these switch, resize, hide and close in the orders that once
 * left a tab's shell at another tab's width.
 */

interface Size { cols: number; rows: number }

let opened: TerminalOpenSpec[];
let events: Array<(event: TerminalEvent) => void>;
let resize: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
/** Open calls held until a test lets them answer. */
let held: Array<() => void> | undefined;
let store: TerminalStore;
let host: HTMLElement;

beforeEach(() => {
  terms.length = 0;
  opened = [];
  events = [];
  held = undefined;
  resize = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  const open = vi.fn((spec: TerminalOpenSpec, onEvent: (event: TerminalEvent) => void): Promise<TerminalOpenResult> => {
    opened.push(spec);
    events.push(onEvent);
    const result: TerminalOpenResult = { ok: true, id: opened.length, cwd: '/w', shell: 'zsh' };
    if (!held) return Promise.resolve(result);
    const queue = held;
    return new Promise((resolve) => { queue.push(() => resolve(result)); });
  });
  (window as unknown as { ordewell: unknown }).ordewell = { terminal: { open, write: vi.fn(), resize, close, openLink: vi.fn() } };
  const api = { platform: 'linux', announce: vi.fn(), showBanner: vi.fn(), showTerminal: vi.fn() } as unknown as FrameApi;
  store = new TerminalStore(api);
  host = document.createElement('div');
  // Laid out: the store fits only a host with a width.
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 900 });
  panel.room = { cols: 100, rows: 30 };
});

/** The panel lays out at a new size: every terminal would fit to it, and the observer refits the shown one. */
function layout(cols: number, rows: number): void {
  panel.room = { cols, rows };
  for (const t of terms) t.grid = { ...panel.room };
  store.fit();
}

async function open(): Promise<string> {
  await store.open({ kind: 'checkout' }, '.');
  const tab = store.getSnapshot().tabs.at(-1);
  if (!tab) throw new Error('no tab');
  return tab.key;
}

/** What the shell with this id was last told: its open spec, then each resize. */
function ptySize(id: number): Size {
  const last = (resize.mock.calls as Array<[number, number, number]>).filter(([i]) => i === id).at(-1);
  const spec = opened[id - 1];
  if (!spec) throw new Error(`no shell ${id}`);
  return last ? { cols: last[1], rows: last[2] } : { cols: spec.cols, rows: spec.rows };
}

const keys = (): string[] => store.getSnapshot().tabs.map((tab) => tab.key);
const termOf = (key: string): (typeof terms)[number] => {
  const term = terms[keys().indexOf(key)];
  if (!term) throw new Error(`no terminal for ${key}`);
  return term;
};

/** The shown tab's shell has the grid its terminal is drawn at. */
function expectShownInSync(): void {
  const active = store.getSnapshot().active;
  if (!active) throw new Error('no active tab');
  expect(ptySize(keys().indexOf(active) + 1)).toEqual(termOf(active).size());
}

describe('each tab\'s shell follows its own terminal\'s grid', () => {
  it('starts the shell at the grid the panel shows it at, with no resize after', async () => {
    store.setHost(host);
    await open();
    expect(opened[0]).toMatchObject({ cols: 100, rows: 30 });
    expect(resize).not.toHaveBeenCalled();
  });

  it('resizes a tab\'s shell when it is shown again after the panel changed size behind it', async () => {
    store.setHost(host);
    const a = await open();
    await open();
    layout(60, 30);
    expect(ptySize(2)).toEqual({ cols: 60, rows: 30 });
    expect(ptySize(1)).toEqual({ cols: 100, rows: 30 });

    store.select(a);
    expect(termOf(a).size()).toEqual({ cols: 60, rows: 30 });
    expect(ptySize(1)).toEqual({ cols: 60, rows: 30 });
  });

  it('resizes the neighbour\'s shell when closing the shown tab reveals it', async () => {
    store.setHost(host);
    await open();
    const b = await open();
    layout(72, 18);
    store.close(b);
    expect(close).toHaveBeenCalledWith(2);
    expect(ptySize(1)).toEqual({ cols: 72, rows: 18 });
  });

  it('sends nothing when a tab is shown at the grid its shell already has', async () => {
    store.setHost(host);
    const a = await open();
    const b = await open();
    resize.mockClear();
    store.select(a);
    store.select(b);
    store.fit();
    expect(resize).not.toHaveBeenCalled();
  });

  it('keeps every shell right through rapid resizes and switches across three tabs', async () => {
    store.setHost(host);
    const tabs = [await open(), await open(), await open()];
    const steps: Array<Size | number> = [
      { cols: 90, rows: 28 }, 0, { cols: 61, rows: 28 }, { cols: 61, rows: 12 }, 2, 1,
      { cols: 140, rows: 40 }, { cols: 139, rows: 40 }, 0, 2, { cols: 80, rows: 24 }, 1, 0,
    ];
    for (const step of steps) {
      if (typeof step === 'number') store.select(tabs[step] as string); else layout(step.cols, step.rows);
      expectShownInSync();
    }
    // The hidden tabs are behind until shown; showing each catches it up.
    for (const key of tabs) { store.select(key); expectShownInSync(); }
    expect(tabs.map((_, i) => ptySize(i + 1))).toEqual([{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { cols: 80, rows: 24 }]);
    // Each resize was a change for the shell it went to.
    const calls = resize.mock.calls as Array<[number, number, number]>;
    for (const [i, call] of calls.entries()) {
      const before = calls.slice(0, i).filter(([id]) => id === call[0]).at(-1);
      const previous = before ? { cols: before[1], rows: before[2] } : { cols: opened[call[0] - 1]?.cols, rows: opened[call[0] - 1]?.rows };
      expect({ cols: call[1], rows: call[2] }).not.toEqual(previous);
    }
  });

  it('catches the shell up when the panel is shown again at another size', async () => {
    store.setHost(host);
    await open();
    resize.mockClear();
    store.setHost(null);
    layout(50, 20);
    expect(resize).not.toHaveBeenCalled();
    store.setHost(host);
    expect(ptySize(1)).toEqual({ cols: 50, rows: 20 });
  });

  it('starts a shell opened while the panel is hidden at its terminal\'s grid, and resizes it when shown', async () => {
    await open();
    expect(opened[0]).toMatchObject({ cols: 80, rows: 24 });
    store.setHost(host);
    expect(ptySize(1)).toEqual({ cols: 100, rows: 30 });
  });

  it('tells a shell that was still starting the grid the panel took meanwhile', async () => {
    store.setHost(host);
    held = [];
    const opening = store.open({ kind: 'checkout' }, '.');
    await vi.waitFor(() => { if (opened.length === 0) throw new Error('not opened yet'); });
    layout(70, 22);
    expect(resize).not.toHaveBeenCalled();
    held.shift()?.();
    await opening;
    expect(ptySize(1)).toEqual({ cols: 70, rows: 22 });
  });

  it('resizes a tab that finished starting behind another when it is shown', async () => {
    store.setHost(host);
    held = [];
    const first = store.open({ kind: 'checkout' }, '.');
    await vi.waitFor(() => { if (opened.length === 0) throw new Error('not opened yet'); });
    const queue = held;
    held = undefined;
    const b = await open();
    layout(64, 30);
    queue.shift()?.();
    await first;
    expect(store.getSnapshot().active).toBe(b);
    expect(ptySize(1)).toEqual({ cols: 100, rows: 30 });
    store.select(keys()[0] as string);
    expect(ptySize(1)).toEqual({ cols: 64, rows: 30 });
  });

  it('sends nothing to a shell that has exited', async () => {
    store.setHost(host);
    await open();
    resize.mockClear();
    events[0]?.({ kind: 'exit', exitCode: 0 });
    layout(40, 10);
    expect(resize).not.toHaveBeenCalled();
  });

  it('sends nothing to a tab closed while it was starting', async () => {
    store.setHost(host);
    held = [];
    const opening = store.open({ kind: 'checkout' }, '.');
    await vi.waitFor(() => { if (opened.length === 0) throw new Error('not opened yet'); });
    store.close(keys()[0] as string);
    held.shift()?.();
    await opening;
    expect(close).toHaveBeenCalledWith(1);
    layout(40, 10);
    expect(resize).not.toHaveBeenCalled();
  });
});
