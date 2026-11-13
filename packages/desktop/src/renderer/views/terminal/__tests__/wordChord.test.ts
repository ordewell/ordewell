// @vitest-environment jsdom
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerm, type TermHandle } from '../xterm';

/**
 * Option+Left/Right end to end on macOS: a real shell or program on a real pty,
 * drawn by the real xterm.js behind createTerm, with the chord pressed as
 * Chromium delivers it. The chord reads the word off the screen, so only here
 * are the screen, the bytes it sends and the program's line editor all in the
 * loop. Each case types after the chord, because in a vi-mode shell the old
 * bytes (ESC f, ESC[1;3C) did their damage to what came next, not to the line
 * as it stood (see main/terminal/__tests__/wordMovement.test.ts).
 */

const REQUIRED_TOOLS = new Set((process.env.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean));
const PROMPT = '$ ';
const LEFT = { key: 'ArrowLeft', keyCode: 37 };
const RIGHT = { key: 'ArrowRight', keyCode: 39 };

interface Shell { name: string; mode: 'emacs' | 'vi'; args: string[]; env: Record<string, string>; setup: string }
const SHELLS: Shell[] = [
  { name: 'zsh', mode: 'emacs', args: ['-f'], env: {}, setup: 'bindkey -e' },
  { name: 'zsh', mode: 'vi', args: ['-f'], env: {}, setup: 'bindkey -v' },
  { name: 'bash', mode: 'emacs', args: ['--norc', '--noprofile'], env: { INPUTRC: devNull }, setup: 'set -o emacs' },
  { name: 'bash', mode: 'vi', args: ['--norc', '--noprofile'], env: { INPUTRC: devNull }, setup: 'set -o vi' },
];

const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, name)).find((file) => existsSync(file));

const open: Array<{ pty: IPty; handle: TermHandle }> = [];

beforeEach(() => {
  // jsdom has neither; xterm asks for both while it opens and draws nothing with them here.
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  for (const { pty, handle } of open.splice(0)) {
    try { pty.kill(); } catch { /* already gone */ }
    handle.dispose();
  }
  vi.restoreAllMocks();
});

// The subject is POSIX line editors and the macOS chord; Windows' shells are PowerShell and cmd.
describe.skipIf(process.platform === 'win32')('Option+Left/Right through real xterm into real programs', async () => {
  const loaded = await import('node-pty').then((pty) => ({ pty }), (error: unknown) => ({ error: String(error).split('\n')[0] }));
  if ('error' in loaded) {
    it.skip(`moves a word (node-pty does not load here: ${loaded.error})`, () => {});
    return;
  }
  const { pty } = loaded;

  async function session(file: string, args: string[], env: Record<string, string>) {
    let output = '';
    let last = Date.now();
    const chords: string[] = [];
    // Spawned at the grid xterm opens with, which needs the handle first.
    const shell: { child?: IPty } = {};
    const handle = await createTerm({
      // What a chord sends is kept apart from what the test types, to assert on it.
      onData: (data) => { chords.push(data); shell.child?.write(data); },
      onLink: () => undefined,
      screenReaderMode: false,
      readClipboard: () => Promise.reject(new Error('no clipboard in this test')),
      writeClipboard: () => Promise.reject(new Error('no clipboard in this test')),
      onClipboardError: () => undefined,
    }, true);
    const parent = document.createElement('div');
    document.body.append(parent);
    handle.mount(parent);
    const textarea = parent.querySelector('textarea');
    if (!textarea) throw new Error('xterm opened without its input textarea');
    // xterm's own grid, which jsdom cannot fit to a layout.
    const size = handle.size();
    const child = pty.spawn(file, args, {
      ...size, cwd: process.cwd(),
      env: { TERM: 'xterm-256color', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HISTFILE: devNull, PS1: PROMPT, ...env },
    });
    open.push({ pty: child, handle });
    shell.child = child;
    child.onData((data) => { last = Date.now(); output += data; handle.write(data); });

    const at = { mark: 0 };
    return {
      /** Until the program has been quiet a while since this was called, so xterm has drawn its answer. */
      async settle(): Promise<void> {
        const since = Date.now();
        await vi.waitFor(() => { if (Date.now() - Math.max(last, since) < 250) throw new Error('still drawing'); });
      },
      async waitFor(pattern: RegExp): Promise<RegExpExecArray> {
        return vi.waitFor(() => {
          const match = pattern.exec(output.slice(at.mark));
          if (!match) throw new Error(`not yet ${String(pattern)}: ${JSON.stringify(output.slice(at.mark))}`);
          return match;
        });
      },
      mark(): void { at.mark = output.length; },
      type(text: string): void { child.write(text); },
      /** Presses Option+Arrow on the textarea, waits for the program to answer, and returns what the chord sent. */
      async option(arrow: typeof LEFT): Promise<string> {
        chords.length = 0;
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: arrow.key, keyCode: arrow.keyCode, altKey: true, bubbles: true, cancelable: true,
        } as KeyboardEventInit));
        await this.settle();
        return chords.join('');
      },
    };
  }

  /** A shell in `shell.mode` with `echo <words>` typed and drawn, the cursor at its end. */
  async function shellWith(file: string, shell: Shell, words: string) {
    const s = await session(file, shell.args, shell.env);
    await s.waitFor(/\$ /);
    s.mark();
    s.type(`${shell.setup}\r`);
    await s.waitFor(/\$ /);
    await s.settle();
    s.type(`echo ${words}`);
    await s.settle();
    s.mark();
    return s;
  }
  const ran = async (s: Awaited<ReturnType<typeof session>>): Promise<string> => {
    s.type('\r');
    return (await s.waitFor(/\r\n(one[^\r\n]*)\r\n/))[1];
  };

  for (const shell of SHELLS) {
    const file = onPath(shell.name);
    const title = `${shell.name} in ${shell.mode} mode`;
    if (!file) {
      if (REQUIRED_TOOLS.has(shell.name)) it(title, () => { throw new Error(`${shell.name} is missing, and ORDEWELL_REQUIRE_TOOLS requires it`); });
      else it.skip(`${title} (${shell.name} is not installed here)`, () => {});
      continue;
    }

    describe(title, () => {
      it('moves a word back on Option+Left with plain arrows, and what is typed next is inserted there', async () => {
        const s = await shellWith(file, shell, 'one two three');
        expect(await s.option(LEFT)).toBe('\x1b[D'.repeat(5));
        expect(await s.option(LEFT)).toBe('\x1b[D'.repeat(4));
        s.type('X');
        expect(await ran(s)).toBe('one Xtwo three');
      });

      it('moves a word forward on Option+Right, and typing goes on in insert mode', async () => {
        const s = await shellWith(file, shell, 'one two three');
        for (let i = 0; i < 3; i++) await s.option(LEFT);
        expect(await s.option(RIGHT)).toBe('\x1b[C'.repeat(3));
        s.type('XY');
        expect(await ran(s)).toBe('oneXY two three');
      });

      it('deletes only what Backspace is pressed for after the move', async () => {
        const s = await shellWith(file, shell, 'one two three');
        await s.option(LEFT);
        s.type('\x7f\x7fZ');
        expect(await ran(s)).toBe('one twZthree');
      });

      it('sends nothing past the last word, so the line is left as it is', async () => {
        const s = await shellWith(file, shell, 'one two three');
        expect(await s.option(RIGHT)).toBe('');
        s.type('!');
        expect(await ran(s)).toBe('one two three!');
      });

      it('crosses the rows of a command line longer than the terminal is wide', async () => {
        // 80 columns, xterm's own: `$ echo one ` and then the long word runs past the first row's edge.
        const long = 'two'.repeat(30);
        const s = await shellWith(file, shell, `one ${long} three`);
        await s.option(LEFT);
        expect(await s.option(LEFT)).toBe('\x1b[D'.repeat(long.length + 1));
        s.type('X');
        expect(await ran(s)).toBe(`one X${long} three`);
      });
    });
  }

  const vim = onPath('vim');
  describe.skipIf(!vim)('vim, on the alternate screen with application cursor keys', () => {
    it('moves over the word on screen in normal mode and leaves insert mode to the user', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'word-chord-'));
      const text = join(dir, 'words.txt');
      writeFileSync(text, 'one two three\n');
      const s = await session(vim!, ['-u', 'NONE', '-i', 'NONE', '-N', '-n', text], {});
      await s.waitFor(/words\.txt/);
      await s.settle();
      // vim asks for DECCKM (keypad transmit), so the arrows are ESC O C.
      expect(await s.option(RIGHT)).toBe('\x1bOC'.repeat(3));
      s.type('iX\x1b');
      await s.settle();
      // Normal mode's block cursor sits on the X it left, so the word it is in ends one along.
      expect(await s.option(RIGHT)).toBe('\x1bOC');
      expect(await s.option(RIGHT)).toBe('\x1bOC'.repeat(4));
      s.type('iY\x1b:wq\r');
      await vi.waitFor(() => { expect(readFileSync(text, 'utf8')).toBe('oneX twoY three\n'); });
    });
  });

  const sh = onPath('sh');
  describe.skipIf(!sh)('a program that hides the cursor and draws its own caret', () => {
    it('gets Meta+B / Meta+F, since the screen does not say where its caret is', async () => {
      const s = await session(sh!, ['-c', String.raw`printf 'ready one two\033[?25l'; stty raw -echo; head -c 4 | od -An -c; stty sane`], {});
      await s.waitFor(/ready one two/);
      await s.settle();
      expect(await s.option(LEFT)).toBe('\x1bb');
      expect(await s.option(RIGHT)).toBe('\x1bf');
      const dumped = await s.waitFor(/033\s+b\s+033\s+f/);
      expect(dumped[0]).toMatch(/033/);
    });
  });
});
