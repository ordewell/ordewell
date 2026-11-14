// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';
import type { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Why each tab's shell must have its own terminal's grid (terminalStore.ts):
 * stock zsh and bash, through a real pty, draw into the real xterm.js parser.
 * Backspace is typed across the line's wrap, and the screen is read back.
 * When the shell and the terminal agree on the width the screen shows exactly
 * the shell's line; when the shell believes a wider grid, it never moves up a
 * row, Backspace stops at the wrapped row's start and erased characters stay.
 * The resize the store sends when a tab is shown again is what puts it right.
 */

const REQUIRED_TOOLS = new Set((process.env.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean));
const PROMPT = '$ ';
const COLS = 40;
const ROWS = 12;
const TYPED = 'abcdefghij'.repeat(5);
const ERASED = 25;
const COMMAND = `echo ${TYPED}`;
const LEFT = `${PROMPT}echo ${TYPED.slice(0, TYPED.length - ERASED)}`;

interface Shell { name: string; args: string[]; env: Record<string, string> }
const SHELLS: Shell[] = [
  { name: 'zsh', args: ['-f'], env: {} },
  { name: 'bash', args: ['--norc', '--noprofile'], env: { INPUTRC: devNull } },
];

const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, name)).find((file) => existsSync(file));

const open: Array<{ pty: IPty; term: Terminal }> = [];
afterEach(() => {
  for (const { pty, term } of open.splice(0)) {
    try { pty.kill(); } catch { /* already gone */ }
    term.dispose();
  }
});

// The subject is POSIX shells' line editors; Windows' shells are PowerShell and cmd, and ConPTY redraws on its own.
describe.skipIf(process.platform === 'win32')('Backspace across a wrapped line, real shell and real xterm', async () => {
  const loaded = await import('node-pty').then((pty) => ({ pty }), (error: unknown) => ({ error: String(error).split('\n')[0] }));
  if ('error' in loaded) {
    it.skip(`deletes across the wrap (node-pty does not load here: ${loaded.error})`, () => {});
    return;
  }
  const { pty } = loaded;
  // xterm probes a canvas for colours as it loads; jsdom has none, and the parser this reads needs none.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const { Terminal } = await import('@xterm/xterm');

  /** The shell at `ptyCols`, drawn by a terminal `COLS` wide; `resize` tells the shell the terminal's grid before typing. */
  async function session(file: string, shell: Shell, ptyCols: number, resize: boolean) {
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    const child = pty.spawn(file, shell.args, {
      cols: ptyCols, rows: ROWS, cwd: process.cwd(),
      env: { TERM: 'xterm-256color', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HISTFILE: devNull, PS1: PROMPT, ...shell.env },
    });
    open.push({ pty: child, term });
    let written = Promise.resolve();
    let last = Date.now();
    child.onData((data) => {
      last = Date.now();
      written = written.then(() => new Promise<void>((resolve) => term.write(data, resolve)));
    });
    // The terminal answers what the shell asks of it (a cursor report), as the app's does through onData.
    term.onData((data) => child.write(data));
    /** Until the shell has been quiet a while and everything it said is drawn. */
    const settle = async (): Promise<void> => {
      await vi.waitFor(() => { if (Date.now() - last < 300) throw new Error('the shell is still drawing'); });
      await written;
    };
    const screen = (): string[] => {
      const buffer = term.buffer.active;
      return Array.from({ length: buffer.length }, (_, y) => (buffer.getLine(y)?.translateToString(true) ?? '').trimEnd());
    };
    /**
     * The command line as drawn: its first row and the rows below it up to a
     * blank one. zsh moves to the next row itself at the edge, so its rows are
     * not marked as wrapped; every row but the last is read at its full width.
     */
    const commandLine = (): { text: string; row: number } => {
      const buffer = term.buffer.active;
      const lines = screen();
      const row = lines.map((line) => line.startsWith(`${PROMPT}echo`)).lastIndexOf(true);
      let end = row;
      while (lines[end + 1]) end++;
      let text = '';
      for (let y = row; y <= end; y++) text += buffer.getLine(y)?.translateToString(y === end) ?? '';
      // A shell erases by writing spaces, which xterm's own trim keeps.
      return { text: text.trimEnd(), row };
    };

    await vi.waitFor(() => { if (!screen().some((line) => line.startsWith(PROMPT.trimEnd()))) throw new Error('no prompt yet'); });
    if (resize) child.resize(COLS, ROWS);
    await settle();
    child.write(COMMAND);
    await vi.waitFor(() => { if (commandLine().text !== `${PROMPT}${COMMAND}`) throw new Error(`typed: ${JSON.stringify(commandLine())}`); });
    child.write('\x7f'.repeat(ERASED));
    await settle();
    const drawn = commandLine();
    const buffer = term.buffer.active;
    const cursor = { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY };
    // What the shell's own line holds, by what it runs.
    child.write('\r');
    const ran = await vi.waitFor(() => {
      const output = screen().find((line) => /^abc[a-j]*$/.test(line.trimEnd()));
      if (output === undefined) throw new Error('echo has not run yet');
      return output.trimEnd();
    });
    return { drawn, cursor, ran };
  }

  for (const shell of SHELLS) {
    const file = onPath(shell.name);
    if (!file) {
      if (REQUIRED_TOOLS.has(shell.name)) {
        it(`deletes across ${shell.name}'s wrap`, () => { throw new Error(`${shell.name} is missing, and ORDEWELL_REQUIRE_TOOLS requires it`); });
      } else {
        it.skip(`deletes across ${shell.name}'s wrap (${shell.name} is not installed here)`, () => {});
      }
      continue;
    }

    it(`shows exactly ${shell.name}'s line when the shell has the terminal's width`, async () => {
      const { drawn, cursor, ran } = await session(file, shell, COLS, false);
      expect(ran).toBe(LEFT.slice(`${PROMPT}echo `.length));
      expect(drawn.text).toBe(LEFT);
      expect(cursor).toEqual({ x: LEFT.length, y: drawn.row });
    });

    it(`shows exactly ${shell.name}'s line once a shell started wider is resized to the terminal, as showing its tab does`, async () => {
      const { drawn, cursor, ran } = await session(file, shell, 100, true);
      expect(ran).toBe(LEFT.slice(`${PROMPT}echo `.length));
      expect(drawn.text).toBe(LEFT);
      expect(cursor).toEqual({ x: LEFT.length, y: drawn.row });
    });

    // The control: without that resize the same keys leave the screen wrong, so the two above are not passing by chance.
    it(`leaves erased characters on screen when ${shell.name} believes a wider grid`, async () => {
      const { drawn, cursor, ran } = await session(file, shell, 100, false);
      expect(ran).toBe(LEFT.slice(`${PROMPT}echo `.length));
      expect(drawn.text).not.toBe(LEFT);
      expect(drawn.text.length).toBeGreaterThan(LEFT.length);
      expect(cursor).not.toEqual({ x: LEFT.length, y: drawn.row });
    });
  }
});
