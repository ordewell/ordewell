// Test-only stub for the `vscode` module. The real module is supplied by the
// VS Code extension host at runtime; in unit tests we alias `vscode` to this
// file (see vitest.config.ts) so config getters can be exercised in isolation.

import { vi } from 'vitest';

let configValues: Record<string, unknown> = {};
let workspaceValues: Record<string, unknown> = {};
/** Every `update` a test's code made, in order. */
export const configUpdates: { key: string; value: unknown }[] = [];

/** Set the `ordewell.*` configuration values the mocked workspace returns. */
export function __setConfig(values: Record<string, unknown>): void {
  configValues = values;
}

/** Values set for this workspace only: `inspect` reports them apart from the user's own. */
export function __setWorkspaceConfig(values: Record<string, unknown>): void {
  workspaceValues = values;
}

export function __resetConfig(): void {
  configValues = {};
  workspaceValues = {};
  configUpdates.length = 0;
}

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        return (key in configValues ? configValues[key] : defaultValue) as T;
      },
      // A value a test set reads as the user's own (global) one; anything else as unset.
      inspect<T>(key: string): { key: string; globalValue?: T; workspaceValue?: T } | undefined {
        if (!(key in configValues) && !(key in workspaceValues)) return undefined;
        return {
          key,
          ...(key in configValues ? { globalValue: configValues[key] as T } : {}),
          ...(key in workspaceValues ? { workspaceValue: workspaceValues[key] as T } : {}),
        };
      },
      async update(key: string, value: unknown, target?: boolean) {
        configUpdates.push({ key, value });
        // `true` is the user's settings, `false` the workspace's.
        const store = target === false ? workspaceValues : configValues;
        if (value === undefined) delete store[key];
        else store[key] = value;
      },
    };
  },
  onDidChangeConfiguration(): { dispose(): void } {
    return { dispose() {} };
  },
  openTextDocument: vi.fn(async () => ({})) as never,
};

export const ProgressLocation = {
  Notification: 15,
} as const;

export class Disposable {
  dispose(): void {}
}

export const QuickPickItemKind = {
  Default: 0,
  Separator: 1,
} as const;

/** Minimal CancellationTokenSource mock — records instances for tests. */
export class CancellationTokenSource {
  private listeners: Array<() => void> = [];
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => {
      this.listeners.push(cb);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== cb); } };
    },
  };
  cancel = vi.fn(() => {
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    for (const l of this.listeners) l();
  });
  dispose = vi.fn();
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data);
  }
  dispose(): void { this.listeners = []; }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export interface FakeTerminal {
  /** What the terminal was opened as, for a test that checks its name, cwd or env. */
  options: { name?: string; cwd?: string; env?: Record<string, string> };
  /** Every line typed into it, in order. */
  sent: string[];
  shown: number;
  exitStatus: { code: number | undefined } | undefined;
  sendText(text: string): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** Terminals created via `window.createTerminal`, in creation order. */
export const __terminals: FakeTerminal[] = [];
const terminalCloseListeners: Array<(terminal: FakeTerminal) => void> = [];

/** The user (or the login's own shell) closed the terminal. */
export function __closeTerminal(terminal: FakeTerminal = __terminals[__terminals.length - 1]): void {
  terminal.exitStatus = { code: 0 };
  for (const cb of [...terminalCloseListeners]) cb(terminal);
}

export function __resetTerminals(): void {
  __terminals.length = 0;
  terminalCloseListeners.length = 0;
}

function createFakeTerminal(options: FakeTerminal['options']): FakeTerminal {
  const terminal: FakeTerminal = {
    options,
    sent: [],
    shown: 0,
    exitStatus: undefined,
    sendText(text: string) { terminal.sent.push(text); },
    show() { terminal.shown += 1; },
    hide() {},
    // Disposing closes the pane, which is the same word a user closing it sends.
    dispose() { __closeTerminal(terminal); },
  };
  __terminals.push(terminal);
  return terminal;
}

export const ViewColumn = { Active: -1, Beside: -2 } as const;

/** A fake asset URI; `joinPath` keeps the parts readable in assertions. */
export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
  joinPath: (base: unknown, ...parts: string[]) => ({
    fsPath: parts.join('/'),
    toString: () => `${String(base)}/${parts.join('/')}`,
  }),
} as const;

export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri: (uri: unknown) => unknown;
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { dispose(): void };
    postMessage: ReturnType<typeof vi.fn>;
  };
  onDidDispose: (cb: () => void) => { dispose(): void };
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  /** Deliver a message from the webview to the host. */
  __receive(msg: unknown): void;
  /** Simulate the tab being closed. */
  __fireDispose(): void;
}

/** Webview panels created via `window.createWebviewPanel`, in creation order. */
export const __panels: FakeWebviewPanel[] = [];

export function __resetPanels(): void {
  __panels.length = 0;
}

export function createFakeWebviewPanel(viewType: string, title: string): FakeWebviewPanel {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const panel: FakeWebviewPanel = {
    viewType,
    title,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (cb) => {
        messageListeners.push(cb);
        return { dispose: () => { const i = messageListeners.indexOf(cb); if (i >= 0) messageListeners.splice(i, 1); } };
      },
      postMessage: vi.fn(() => Promise.resolve(true)),
    },
    onDidDispose: (cb) => {
      disposeListeners.push(cb);
      return { dispose: () => { const i = disposeListeners.indexOf(cb); if (i >= 0) disposeListeners.splice(i, 1); } };
    },
    reveal: vi.fn(),
    dispose: vi.fn(() => { for (const cb of [...disposeListeners]) cb(); }),
    __receive: (msg) => { for (const cb of [...messageListeners]) cb(msg); },
    __fireDispose: () => { for (const cb of [...disposeListeners]) cb(); },
  };
  __panels.push(panel);
  return panel;
}

export const QuickInputButtons = {
  Back: { iconPath: new ThemeIcon('arrow-left'), tooltip: 'Back' },
} as const;

export interface FakeQuickPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface FakeQuickPick<T = FakeQuickPickItem> {
  title?: string;
  step?: number;
  totalSteps?: number;
  placeholder?: string;
  ignoreFocusOut: boolean;
  buttons: readonly unknown[];
  items: readonly T[];
  activeItems: readonly T[];
  selectedItems: readonly T[];
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
  onDidAccept(cb: () => void): { dispose(): void };
  onDidHide(cb: () => void): { dispose(): void };
  onDidTriggerButton(cb: (button: unknown) => void): { dispose(): void };
  /** Accept the highlighted item, or the one at `index` after moving the highlight there. */
  __accept(index?: number): void;
  __back(): void;
  /** The user dismissing the picker (Escape, focus loss). */
  __escape(): void;
}

/** Quick picks created by `window.createQuickPick`, in creation order. */
export const __quickPicks: FakeQuickPick[] = [];
/** One entry per `show()`: what the user does to that pick. */
export const __quickPickScript: Array<(pick: FakeQuickPick) => void> = [];

export function __resetQuickPicks(): void {
  __quickPicks.length = 0;
  __quickPickScript.length = 0;
}

function createFakeQuickPick(): FakeQuickPick {
  const accept: Array<() => void> = [];
  const button: Array<(b: unknown) => void> = [];
  const hide: Array<() => void> = [];
  const subscribe = <F>(list: F[], cb: F) => {
    list.push(cb);
    return { dispose() { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); } };
  };
  const pick: FakeQuickPick = {
    ignoreFocusOut: false,
    items: [], activeItems: [], selectedItems: [], buttons: [], disposed: false,
    show() {
      const act = __quickPickScript.shift();
      if (act) queueMicrotask(() => act(pick));
    },
    hide() { for (const cb of [...hide]) cb(); },
    // A real picker reports its own dispose() as a hide too.
    dispose() {
      if (pick.disposed) return;
      pick.disposed = true;
      for (const cb of [...hide]) cb();
    },
    onDidAccept: (cb) => subscribe(accept, cb),
    onDidTriggerButton: (cb) => subscribe(button, cb),
    onDidHide: (cb) => subscribe(hide, cb),
    __accept(index) {
      if (index !== undefined) pick.activeItems = [pick.items[index]];
      pick.selectedItems = [...pick.activeItems];
      for (const cb of [...accept]) cb();
    },
    __back() { for (const cb of [...button]) cb(QuickInputButtons.Back); },
    __escape() { pick.hide(); },
  };
  __quickPicks.push(pick);
  return pick;
}

export const window = {
  createQuickPick: vi.fn(createFakeQuickPick) as never,
  showQuickPick: vi.fn() as never,
  showInputBox: vi.fn() as never,
  withProgress: vi.fn() as never,
  showWarningMessage: vi.fn() as never,
  showInformationMessage: vi.fn() as never,
  showErrorMessage: vi.fn() as never,
  showTextDocument: vi.fn() as never,
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })) as never,
  createWebviewPanel: vi.fn((viewType: string, title: string) => createFakeWebviewPanel(viewType, title)) as never,
  registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })) as never,
  createTerminal: vi.fn((options: FakeTerminal['options']) => createFakeTerminal(options)) as never,
  onDidCloseTerminal: vi.fn((cb: (terminal: FakeTerminal) => void) => {
    terminalCloseListeners.push(cb);
    return { dispose: () => { const i = terminalCloseListeners.indexOf(cb); if (i >= 0) terminalCloseListeners.splice(i, 1); } };
  }) as never,
};

export const env = {
  isTelemetryEnabled: true,
  onDidChangeTelemetryEnabled: vi.fn(() => ({ dispose: vi.fn() })) as never,
};

export const commands = {
  executeCommand: vi.fn(async () => undefined) as never,
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })) as never,
};
