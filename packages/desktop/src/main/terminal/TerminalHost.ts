import type { TerminalEvent } from '../../shared/bridge';
import type { WordDirection, WordPty } from './wordLink';

/**
 * The ptys of the app, owned by main and never by a renderer (ADR-0062 G11):
 * the page asks for one, writes keystrokes to it and reads what it prints, and
 * everything else about the process stays here. node-pty is injected so the
 * rules (who may touch which terminal, what dies when a window does) are
 * testable without a native addon.
 */

/** The slice of node-pty's `IPty` this host uses. */
export interface PtyProcess {
  /** The foreground process's name: the shell itself when nothing is running in it. */
  readonly process: string;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawn {
  (file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string }): PtyProcess;
}

/** A shell's word link (ADR-0069): keystrokes go through it, so a move keeps its place among them. */
export interface WordChannel {
  attach(pty: WordPty, linked: () => void): void;
  write(data: string): void;
  word(direction: WordDirection): void;
  dispose(): void;
}

export interface StartOptions {
  /** The number the page chose; unique per owner. */
  id: number;
  owner: number;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  send(id: number, event: TerminalEvent): void;
  words?: WordChannel;
}

interface Entry {
  pty: PtyProcess;
  owner: number;
  shell: string;
  flush(): void;
  words: WordChannel | undefined;
}

const MIN = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 500;
/** A burst of output goes out as one message, not one per chunk; this bounds how long a prompt waits. */
const BATCH_MS = 8;
const BATCH_BYTES = 64 * 1024;

export function validSize(cols: unknown, rows: unknown): { cols: number; rows: number } | undefined {
  if (typeof cols !== 'number' || typeof rows !== 'number') return undefined;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return undefined;
  if (cols < MIN || rows < MIN || cols > MAX_COLS || rows > MAX_ROWS) return undefined;
  return { cols, rows };
}

export class TerminalHost {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly spawn: PtySpawn,
    private readonly timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
    },
  ) {}

  private static key(owner: number, id: number): string {
    return `${owner}:${id}`;
  }

  /** Starts a shell; throws when the program cannot start or the number is taken. */
  start(options: StartOptions): void {
    const key = TerminalHost.key(options.owner, options.id);
    if (this.entries.has(key)) throw new Error('That terminal number is in use.');
    const pty = this.spawn(options.file, options.args, {
      cwd: options.cwd, env: options.env, cols: options.cols, rows: options.rows, name: 'xterm-256color',
    });
    let pending = '';
    let timer: unknown;
    const flush = (): void => {
      if (timer !== undefined) { this.timers.clear(timer); timer = undefined; }
      if (pending === '') return;
      const data = pending;
      pending = '';
      options.send(options.id, { kind: 'data', data });
    };
    pty.onData((chunk) => {
      pending += chunk;
      if (pending.length >= BATCH_BYTES) flush();
      else timer ??= this.timers.set(() => { timer = undefined; flush(); }, BATCH_MS);
    });
    const words = options.words;
    pty.onExit(({ exitCode, signal }) => {
      flush();
      words?.dispose();
      this.entries.delete(key);
      options.send(options.id, { kind: 'exit', exitCode, ...(signal ? { signal } : {}) });
    });
    this.entries.set(key, { pty, owner: options.owner, shell: options.file, flush, words });
    words?.attach(pty, () => options.send(options.id, { kind: 'words' }));
  }

  /** A terminal is reachable by the window that opened it and no other. */
  private find(owner: number, id: unknown): Entry | undefined {
    return typeof id === 'number' ? this.entries.get(TerminalHost.key(owner, id)) : undefined;
  }

  write(owner: number, id: unknown, data: unknown): void {
    if (typeof data !== 'string') throw new Error('write takes text');
    const entry = this.find(owner, id);
    if (entry?.words) entry.words.write(data);
    else entry?.pty.write(data);
  }

  /** Option+Left/Right: the shell moves if its link says it can, and nothing reaches the pty otherwise. */
  word(owner: number, id: unknown, direction: unknown): void {
    if (direction !== 'left' && direction !== 'right') throw new Error('word takes left or right');
    this.find(owner, id)?.words?.word(direction);
  }

  resize(owner: number, id: unknown, cols: unknown, rows: unknown): void {
    const size = validSize(cols, rows);
    if (!size) throw new Error('resize takes a whole number of columns and rows');
    this.find(owner, id)?.pty.resize(size.cols, size.rows);
  }

  close(owner: number, id: unknown): void {
    const entry = this.find(owner, id);
    if (!entry) return;
    this.entries.delete(TerminalHost.key(owner, id as number));
    entry.words?.dispose();
    entry.pty.kill();
  }

  /** A window that closes or reloads leaves no shell behind it. */
  closeOwner(owner: number): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.owner !== owner) continue;
      this.entries.delete(key);
      entry.words?.dispose();
      entry.pty.kill();
    }
  }

  killAll(): void {
    for (const entry of this.entries.values()) { entry.words?.dispose(); entry.pty.kill(); }
    this.entries.clear();
  }

  /**
   * Terminals with something other than their shell in the foreground:
   * quitting would end that work (ADR-0063 H5), and closing the window that
   * owns them, when `owner` names it.
   */
  busy(shellNameOf: (file: string) => string, owner?: number): number {
    // A login shell may report itself as `-zsh`, and Windows as `powershell.exe`.
    const plain = (name: string): string => name.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase();
    let count = 0;
    for (const entry of this.entries.values()) {
      if (owner !== undefined && entry.owner !== owner) continue;
      if (plain(entry.pty.process) !== plain(shellNameOf(entry.shell))) count += 1;
    }
    return count;
  }

  get size(): number {
    return this.entries.size;
  }
}
