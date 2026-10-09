// Test-only stub for the `vscode` module. The real module is supplied by the
// VS Code extension host at runtime; in unit tests we alias `vscode` to this
// file (see vitest.config.ts) so config getters can be exercised in isolation.

import { vi } from 'vitest';

let configValues: Record<string, unknown> = {};

/** Set the `ordewell.*` configuration values the mocked workspace returns. */
export function __setConfig(values: Record<string, unknown>): void {
  configValues = values;
}

export function __resetConfig(): void {
  configValues = {};
}

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(key: string, defaultValue?: T): T {
        return (key in configValues ? configValues[key] : defaultValue) as T;
      },
      inspect() {
        return undefined;
      },
      async update() {
        /* no-op */
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

export const window = {
  showQuickPick: vi.fn() as never,
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
};

export const commands = {
  executeCommand: vi.fn(async () => undefined) as never,
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })) as never,
};
