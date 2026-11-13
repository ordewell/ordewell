import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What the bytes Option+Left/Right could send do in the shells a user starts
 * with: stock zsh and bash, no startup files, emacs and vi mode, through a real
 * pty (renderer/views/terminal/wordKeys.ts chooses among them).
 *
 * - Plain arrows, as many as the word on screen is long, which the chord sends
 *   while the cursor is shown: every keymap binds them, so they move and leave
 *   the mode alone in all four.
 * - ESC b / ESC f, which it sends to a program that hides the cursor: a word in
 *   emacs mode. In vi insert mode the ESC leaves insert mode and the letter waits
 *   for the next key, which this pins as the reason they are not the default.
 * - ESC[1;3D / ESC[1;3C, xterm's own: unbound in emacs mode, and in vi mode the
 *   trailing C is "change to end of line", which deletes at once.
 *
 * zsh is read by its own ZLE state ($BUFFER, $CURSOR, $KEYMAP) from a widget
 * on ^T; bash 3.2 has no READLINE_LINE, so it is read by what `echo` prints.
 */

const REQUIRED_TOOLS = new Set((process.env.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean));
const PROMPT = 'word-test> ';
const LINE = 'echo one two three';
const DUMP = '\x14';
const DUMPED = /DUMP<([^|]*)\|(\d+)\|(\w+)>/;
const left = (n: number) => '\x1b[D'.repeat(n);
const right = (n: number) => '\x1b[C'.repeat(n);

const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, name)).find((file) => existsSync(file));

const open: IPty[] = [];
afterEach(() => {
  for (const pty of open.splice(0)) {
    try { pty.kill(); } catch { /* already gone */ }
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The subject is POSIX shells' line editors; Windows' shells are PowerShell and cmd, and the rewrite is macOS's.
// The tests are registered after node-pty loads, so the suite awaits it.
describe.skipIf(process.platform === 'win32')('word movement bytes in the stock shells', async () => {
  const loaded = await import('node-pty').then((pty) => ({ pty }), (error: unknown) => ({ error: String(error).split('\n')[0] }));
  if ('error' in loaded) {
    it.skip(`types into a real shell (node-pty does not load here: ${loaded.error})`, () => {});
    return;
  }
  const { pty } = loaded;

  /**
   * Runs `setup`, types LINE, then each key press as its own write, a beat
   * apart as a person presses them, and returns the output from LINE on once
   * `until` matches it.
   */
  async function drive(file: string, args: string[], env: Record<string, string>, setup: string, keys: string[], until: RegExp) {
    const term = pty.spawn(file, args, {
      cols: 120, rows: 30, cwd: process.cwd(),
      // No EDITOR or VISUAL: zsh starts in vi mode when either names vi; the mode here is the setup's.
      env: { TERM: 'xterm-256color', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HISTFILE: devNull, PS1: PROMPT, ...env },
    });
    open.push(term);
    let output = '';
    term.onData((data) => { output += data; });
    await vi.waitFor(() => { if (!output.includes(PROMPT)) throw new Error(`no prompt yet: ${JSON.stringify(output)}`); });
    const prompts = output.split(PROMPT).length;
    term.write(`${setup}\r`);
    await vi.waitFor(() => { if (output.split(PROMPT).length <= prompts) throw new Error('setup has not finished'); });
    const mark = output.length;
    term.write(LINE);
    for (const key of keys) {
      await sleep(100);
      term.write(key);
    }
    return vi.waitFor(() => {
      const match = until.exec(output.slice(mark));
      if (!match) throw new Error(`not yet: ${JSON.stringify(output.slice(mark))}`);
      return match;
    });
  }

  const zshFile = onPath('zsh');
  const bashFile = onPath('bash');
  const missing = (name: string) => {
    if (REQUIRED_TOOLS.has(name)) it(`types into ${name}`, () => { throw new Error(`${name} is missing, and ORDEWELL_REQUIRE_TOOLS requires it`); });
    else it.skip(`types into ${name} (${name} is not installed here)`, () => {});
  };

  if (!zshFile) missing('zsh');
  else describe('zsh -f', () => {
    const setup = (mode: 'e' | 'v') =>
      `dump() { print -rn -- $'\\r\\n'"DUMP<\${(V)BUFFER}|\${CURSOR}|\${KEYMAP}>"$'\\r\\n' }; zle -N dump; ` +
      `for m in emacs viins vicmd; bindkey -M $m '^T' dump; bindkey -${mode}`;
    const zsh = async (mode: 'e' | 'v', keys: string[]) => {
      const [, buffer, cursor, keymap] = await drive(zshFile, ['-f'], {}, setup(mode), [...keys, DUMP], DUMPED);
      // `main` is whichever of emacs and viins bindkey -e / -v linked it to.
      return { buffer, cursor: Number(cursor), keymap: keymap === 'main' ? (mode === 'e' ? 'emacs' : 'viins') : keymap };
    };

    for (const [mode, insert] of [['e', 'emacs'], ['v', 'viins']] as const) {
      it(`moves on plain arrows and stays in ${insert}, so what is typed next is inserted`, async () => {
        // From the end: five left is the start of `three`, three right is the end of `one` from its start.
        expect(await zsh(mode, [left(5), 'X'])).toEqual({ buffer: 'echo one two Xthree', cursor: 14, keymap: insert });
        expect(await zsh(mode, [left(13), right(3), 'X'])).toEqual({ buffer: 'echo oneX two three', cursor: 9, keymap: insert });
      });
    }

    it('moves a word on ESC b / ESC f in emacs mode', async () => {
      expect(await zsh('e', ['\x1bb', '\x1bb'])).toMatchObject({ buffer: LINE, cursor: 9 });
      // zsh's forward-word stops at the start of the next word, bash's at the end of this one.
      expect(await zsh('e', ['\x01', '\x1bf', '\x1bf'])).toMatchObject({ buffer: LINE, cursor: 9 });
    });

    it('in vi mode, ESC f leaves insert mode and swallows the next key, and the one after is a command', async () => {
      // Cursor on `two`: f takes the first x as the character to find, the second x deletes.
      expect(await zsh('v', [left(9), '\x1bf', 'x', 'x'])).toEqual({ buffer: 'echo onetwo three', cursor: 8, keymap: 'vicmd' });
    });

    it("in vi mode, xterm's ESC[1;3C deletes to the end of the line at once", async () => {
      expect(await zsh('v', [left(9), '\x1b[1;3C'])).toEqual({ buffer: 'echo one', cursor: 8, keymap: 'viins' });
    });
  });

  if (!bashFile) missing('bash');
  else describe('bash --norc', () => {
    const bash = async (mode: 'emacs' | 'vi', keys: string[]): Promise<string | undefined> => {
      const match = await drive(bashFile, ['--norc', '--noprofile'], { INPUTRC: devNull }, `set -o ${mode}`, [...keys, 'X', '\r'], /\r\n(one[^\r\n]*)\r\n/);
      return match[1];
    };

    for (const mode of ['emacs', 'vi'] as const) {
      it(`moves on plain arrows in ${mode} mode, and what is typed next is inserted`, async () => {
        expect(await bash(mode, [left(5)])).toBe('one two Xthree');
        expect(await bash(mode, [left(13), right(3)])).toBe('oneX two three');
      });
    }

    it('moves a word on ESC b / ESC f in emacs mode', async () => {
      expect(await bash('emacs', ['\x1bb', '\x1bb'])).toBe('one Xtwo three');
      expect(await bash('emacs', ['\x01', '\x1bf', '\x1bf'])).toBe('oneX two three');
    });

    it('in vi mode, ESC f leaves insert mode and swallows the next key', async () => {
      expect(await bash('vi', [left(9), '\x1bf'])).toBe('one two three');
    });

    it("in vi mode, xterm's ESC[1;3C deletes to the end of the line at once", async () => {
      expect(await bash('vi', [left(9), '\x1b[1;3C'])).toBe('one X');
    });
  });
});
