import type { TerminalEvent, TerminalOpenResult } from '../../../shared/bridge';
import { terminalLabel, terminalScopeDecision, type TerminalScope } from '../../../shared/terminalScope';
import { readClipboardText, writeClipboardText } from '../../clipboard';
import type { FrameApi } from '../../frame/api';
import { isMac } from '../../frame/keys';
import { scopeStoreFor, type ScopeState } from '../scope/scopeStore';
import { createTerm, type TermHandle } from './xterm';

/**
 * The window's terminals. They live here, not in the panel's React tree: the
 * frame unmounts the bottom panel when it is hidden, and hiding a terminal must
 * not end the shell or lose its scrollback (design: Terminal rule). The panel
 * only draws the tab strip and hands this store the element to show the active
 * terminal in.
 */

export type TabPhase = 'starting' | 'running' | 'exited' | 'failed';

export interface TerminalTab {
  key: string;
  scope: TerminalScope;
  repo: string;
  /** The scope as the tab names it: "Your checkout", "Task #3 worktree". */
  scopeLabel: string;
  shell: string | undefined;
  /** What the user renamed it to; the shell's name until then. */
  name: string | undefined;
  phase: TabPhase;
  /** Why it failed to start, or how the process ended. */
  message: string | undefined;
}

export interface TerminalState {
  tabs: TerminalTab[];
  active: string | undefined;
}

/** What a login terminal tells the host that started it: the process or its tab ended. */
export interface LoginTerminal {
  ended: Promise<void>;
}

export const tabTitle = (tab: TerminalTab): string => tab.name ?? tab.shell ?? 'Terminal';

interface Entry {
  term: TermHandle | undefined;
  ptyId: number | undefined;
  /** Closed before it finished starting: whatever arrives is discarded. */
  closed: boolean;
  /**
   * The grid this tab's shell was last told. Each tab's own: only the shown
   * tab is refitted, so a tab shown again after the panel changed size must be
   * compared with what its shell has, not with what another tab's was told.
   */
  pty: { cols: number; rows: number } | undefined;
  /** A login's waiters: the agent's status command is the verdict, not this exit. */
  ended(): void;
}

/**
 * The banner a task-worktree terminal shows once its task is running: the
 * shell is not killed (the user may be mid-command), but the agent and the
 * shell now share one directory.
 */
export function bannerFor(tab: TerminalTab | undefined, scopes: ScopeState): string | undefined {
  if (tab?.scope.kind !== 'task') return undefined;
  const scope = tab.scope;
  const task = scopes.session?.sessionId === scope.sessionId ? scopes.session.tasks.find((t) => t.id === scope.taskId) : undefined;
  if (!task || terminalScopeDecision(scope, task).ok) return undefined;
  return `Task #${task.order} is running in this worktree. Files may change under this shell while it works.`;
}

/** The decision for a menu option, from the scope store's view of the session. */
export function decisionFor(scope: TerminalScope, scopes: ScopeState): ReturnType<typeof terminalScopeDecision> {
  const task = scope.kind === 'task' ? scopes.session?.tasks.find((t) => t.id === scope.taskId) : undefined;
  return terminalScopeDecision(scope, task);
}

export class TerminalStore {
  private state: TerminalState = { tabs: [], active: undefined };
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<string, Entry>();
  private host: HTMLElement | null = null;
  private counter = 0;

  constructor(private readonly api: FrameApi) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): TerminalState => this.state;

  private set(patch: Partial<TerminalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchTab(key: string, patch: Partial<TerminalTab>): void {
    this.set({ tabs: this.state.tabs.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab)) });
  }

  /** Opens a first terminal in the checkout when there is none; the panel calls it as it appears. */
  ensureOne(): void {
    if (this.state.tabs.length === 0) void this.open({ kind: 'checkout' });
  }

  async open(scope: TerminalScope, repo: string = scopeStoreFor(this.api).getSnapshot().repo): Promise<void> {
    try {
      await this.start(scope, repo);
    } catch {
      // A refused or failed terminal has already said so in its tab and the announce line.
    }
  }

  /**
   * A coding agent's own login, in a tab of its own (ADR-0052): main runs the
   * argv core declares, so the tab is a real terminal the person can type an
   * OAuth code into. The caller gets the end of that terminal to stop waiting.
   */
  async openLogin(runner: string, label: string): Promise<LoginTerminal> {
    // The panel may be hidden: a login's terminal must be seen, or the browser
    // prompt it waits for is invisible.
    this.api.showTerminal();
    return this.start({ kind: 'checkout' }, '.', { login: { runner }, name: `${label} login` });
  }

  private async start(scope: TerminalScope, repo: string, options: { login?: { runner: string }; name?: string } = {}): Promise<LoginTerminal> {
    const scopes = scopeStoreFor(this.api).getSnapshot();
    const decision = decisionFor(scope, scopes);
    if (!decision.ok) {
      this.api.announce(decision.reason);
      throw new Error(decision.reason);
    }
    const task = scope.kind === 'task' ? scopes.session?.tasks.find((t) => t.id === scope.taskId) : undefined;
    const key = `terminal-${++this.counter}`;
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { ended = resolve; });
    const entry: Entry = { term: undefined, ptyId: undefined, closed: false, pty: undefined, ended };
    this.entries.set(key, entry);
    this.set({
      tabs: [...this.state.tabs, {
        key, scope, repo, shell: undefined, name: options.name, phase: 'starting', message: undefined,
        scopeLabel: terminalLabel(scope, task, repo, scopes.repos.length),
      }],
      active: key,
    });

    try {
      const term = await createTerm({
        onData: (data) => { if (entry.ptyId !== undefined) void window.ordewell.terminal.write(entry.ptyId, data); },
        onLink: (url) => { void window.ordewell.terminal.openLink(url); },
        screenReaderMode: false,
        readClipboard: readClipboardText,
        writeClipboard: writeClipboardText,
        onClipboardError: (title, reason) => this.clipboardFailed(title, reason),
      }, isMac(this.api.platform));
      if (entry.closed) { term.dispose(); return { ended: done }; }
      entry.term = term;
      // Fitted first when it is the one shown, so the shell starts at the grid it is drawn in.
      if (this.state.active === key) this.showActive();
      entry.pty = { ...term.size() };
      const result = await window.ordewell.terminal.open({ repo, scope, ...entry.pty, ...(options.login ? { login: options.login } : {}) }, (event) => this.onEvent(key, entry, event));
      if (entry.closed) {
        if (result.ok) void window.ordewell.terminal.close(result.id);
        return { ended: done };
      }
      if (!result.ok) throw new Error(result.message);
      this.started(key, entry, result);
      return { ended: done };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(key, entry, message);
      throw new Error(message);
    }
  }

  private started(key: string, entry: Entry, result: TerminalOpenResult & { ok: true }): void {
    entry.ptyId = result.id;
    this.patchTab(key, { phase: 'running', shell: result.shell });
    this.showActive();
  }

  private clipboardFailed(title: string, reason: string): void {
    const dismiss = this.api.showBanner({ id: 'terminal-clipboard', tone: 'warning', title, body: reason, actions: [{ label: 'Dismiss', run: () => dismiss() }] });
    this.api.announce(`${title}: ${reason}`);
  }

  private fail(key: string, entry: Entry, message: string): void {
    entry.term?.dispose();
    entry.term = undefined;
    this.patchTab(key, { phase: 'failed', message });
    this.api.announce(message);
  }

  private onEvent(key: string, entry: Entry, event: TerminalEvent): void {
    if (entry.closed || !entry.term) return;
    if (event.kind === 'data') { entry.term.write(event.data); return; }
    const message = event.exitCode === 0 ? 'Process exited.' : `Process exited with code ${event.exitCode}.`;
    entry.term.write(`\r\n\x1b[2m[${message} Close this tab to dismiss it.]\x1b[0m\r\n`);
    entry.ptyId = undefined;
    this.patchTab(key, { phase: 'exited', message });
    entry.ended();
  }

  close(key: string): void {
    const entry = this.entries.get(key);
    const at = this.state.tabs.findIndex((tab) => tab.key === key);
    if (at < 0) return;
    this.entries.delete(key);
    if (entry) {
      entry.closed = true;
      if (entry.ptyId !== undefined) void window.ordewell.terminal.close(entry.ptyId);
      entry.term?.dispose();
      entry.ended();
    }
    const tabs = this.state.tabs.filter((tab) => tab.key !== key);
    const active = this.state.active === key ? (tabs[at] ?? tabs[at - 1])?.key : this.state.active;
    this.set({ tabs, active });
    this.showActive();
  }

  select(key: string): void {
    if (this.state.active === key || !this.entries.has(key)) return;
    this.set({ active: key });
    this.showActive();
  }

  /** An empty name puts the shell's own back. */
  rename(key: string, name: string): void {
    this.patchTab(key, { name: name.trim() || undefined });
  }

  /** The element the active terminal is drawn in; null when the panel is hidden. */
  setHost(host: HTMLElement | null): void {
    this.host = host;
    this.showActive();
  }

  private showActive(): void {
    const entry = this.state.active ? this.entries.get(this.state.active) : undefined;
    if (!this.host) return;
    if (!entry?.term) { this.host.replaceChildren(); return; }
    entry.term.mount(this.host);
    this.fit();
    entry.term.focus();
  }

  /** Follows the host's size: the terminal refits and the shell is told the new grid. */
  fit(): void {
    const entry = this.state.active ? this.entries.get(this.state.active) : undefined;
    if (!entry?.term || !this.host?.clientWidth) return;
    const next = entry.term.fit();
    // A shell still starting was opened at entry.pty; once it runs, started() refits and tells it.
    if (entry.ptyId === undefined) return;
    if (next.cols === entry.pty?.cols && next.rows === entry.pty.rows) return;
    entry.pty = { cols: next.cols, rows: next.rows };
    void window.ordewell.terminal.resize(entry.ptyId, next.cols, next.rows);
  }

  focus(): void {
    const entry = this.state.active ? this.entries.get(this.state.active) : undefined;
    entry?.term?.focus();
  }

  /** The OS theme changed: every terminal, shown or not, takes the new tokens. */
  restyle(): void {
    for (const entry of this.entries.values()) entry.term?.setTheme();
  }

  /** The window is going: the shells go with it (main also closes them, so this only makes it prompt). */
  dispose(): void {
    for (const key of [...this.entries.keys()]) this.close(key);
  }
}

const stores = new WeakMap<FrameApi, TerminalStore>();

export function terminalStoreFor(api: FrameApi): TerminalStore {
  let store = stores.get(api);
  if (!store) { store = new TerminalStore(api); stores.set(api, store); }
  return store;
}
