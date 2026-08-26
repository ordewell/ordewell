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

export interface FakePseudoterminal {
  onDidWrite: (listener: (data: string) => void) => { dispose(): void };
  onDidClose?: (listener: (code: number) => void) => { dispose(): void };
  open(dimensions?: { columns: number; rows: number }): void | Promise<void>;
  close(): void;
  handleInput?(data: string): void;
  setDimensions?(dimensions: { columns: number; rows: number }): void;
}

export interface FakeTerminal {
  name: string;
  pty: FakePseudoterminal;
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** Terminals created via `window.createTerminal`, in creation order. */
export const __terminals: FakeTerminal[] = [];

export function __resetTerminals(): void {
  __terminals.length = 0;
}

export const window = {
  createTerminal: vi.fn((options: { name: string; pty: FakePseudoterminal }) => {
    const terminal: FakeTerminal = {
      name: options.name,
      pty: options.pty,
      show: vi.fn(),
      dispose: vi.fn(() => options.pty.close()),
    };
    __terminals.push(terminal);
    return terminal;
  }) as never,
  showQuickPick: vi.fn() as never,
  withProgress: vi.fn() as never,
  showWarningMessage: vi.fn() as never,
  showInformationMessage: vi.fn() as never,
  showErrorMessage: vi.fn() as never,
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })) as never,
};
