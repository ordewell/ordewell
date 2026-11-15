// @vitest-environment jsdom
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completedLine } from '../../../../shared/__tests__/ptyScreen';
import { createTerm, type TermHandle } from '../xterm';

/** A real PTY checks that swallowing the chord leaves the next input intact. */

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

/**
 * A reply xterm generates itself to a query the program sent (vim asks at startup, and whenever it likes): DECRPM
 * `CSI ? 12 ; 2 $ y`, the device attributes `CSI ? … c` and `CSI > … c`, and a cursor position `CSI r ; c R`. They
 * reach the pty like the chord does, and under load can land inside the window a chord is measured over. Nothing
 * an Option+Arrow chord sends is shaped like one (`ESC b`, `ESC [ 1 ; 3 D`, `ESC O D`), so a wrong chord byte is
 * still counted; matched whole, so a chord that merely contains one is too.
 */
// eslint-disable-next-line no-control-regex -- an escape sequence is the subject
const TERMINAL_REPORT = /^\x1b\[(?:[?>]?[\d;]*\$y|[?>][\d;]*c|\d+;\d+R)$/;
const isTerminalReport = (data: string): boolean => TERMINAL_REPORT.test(data);

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
    // Everything xterm sent, to tell when it has answered a query.
    const sent: string[] = [];
    // Spawned at the grid xterm opens with, which needs the handle first.
    const shell: { child?: IPty } = {};
    const handle = await createTerm({
      // What a chord sends is kept apart from what the test types, to assert on it.
      onData: (data) => { sent.push(data); if (!isTerminalReport(data)) chords.push(data); shell.child?.write(data); },
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
      /** A whole line starting with `start` on the screen since the mark, whatever modes the shell switched around it. */
      async line(start: string): Promise<string> {
        return vi.waitFor(() => {
          const found = completedLine(output.slice(at.mark), start);
          if (found === undefined) throw new Error(`no line ${JSON.stringify(start)} yet: ${JSON.stringify(output.slice(at.mark))}`);
          return found;
        });
      },
      mark(): void { at.mark = output.length; },
      type(text: string): void { child.write(text); },
      /** Presses Option+Arrow on the textarea, waits for the program to answer, and returns what the chord sent.
       *  `during` runs right after the key, to put program output in the window the chord is measured over. */
      async option(arrow: typeof LEFT, during?: () => Promise<void>): Promise<string> {
        chords.length = 0;
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: arrow.key, keyCode: arrow.keyCode, altKey: true, bubbles: true, cancelable: true,
        } as KeyboardEventInit));
        await during?.();
        await this.settle();
        return chords.join('');
      },
      /** The program's output arriving late: what vim does when a startup query is parsed after the first chord. */
      async emit(data: string, answered: RegExp): Promise<void> {
        const before = sent.length;
        handle.write(data);
        await vi.waitFor(() => { if (!sent.slice(before).some((reply) => answered.test(reply))) throw new Error('xterm has not answered yet'); });
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
    return s.line('one');
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
      it('leaves the line and subsequent input intact after both chords', async () => {
        const s = await shellWith(file, shell, 'one two three');
        expect(await s.option(LEFT)).toBe('');
        expect(await s.option(RIGHT)).toBe('');
        expect(await s.option(LEFT)).toBe('');
        s.type('XY');
        expect(await ran(s)).toBe('one two threeXY');
      });
    });
  }

  const vim = onPath('vim');
  describe.skipIf(!vim)('vim, on the alternate screen with application cursor keys', () => {
    it('does not trigger custom arrow mappings or consume subsequent input', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'word-chord-'));
      const text = join(dir, 'words.txt');
      writeFileSync(text, 'one two three\n');
      const s = await session(vim!, ['-u', 'NONE', '-i', 'NONE', '-N', '-n', text], {});
      await s.waitFor(/words\.txt/);
      s.type(':nnoremap <Left> dd\r:nnoremap <Right> dd\r');
      await s.settle();
      expect(await s.option(LEFT)).toBe('');
      expect(await s.option(RIGHT)).toBe('');
      s.type('iX\x1b:wq\r');
      await vi.waitFor(() => { expect(readFileSync(text, 'utf8')).toBe('Xone two three\n'); });
    });
  });

  const sh = onPath('sh');
  describe.skipIf(!sh)('a reply xterm makes to the program\'s own query', () => {
    it('is not counted as the chord, but a chord byte is', async () => {
      const s = await session(sh!, ['-c', String.raw`printf ready; sleep 30`], {});
      await s.waitFor(/ready/);
      await s.settle();
      // vim's DECRQM for cursor blink, parsed after the chord was pressed.
      expect(await s.option(LEFT, () => s.emit('\x1b[?12$p', /\$y$/))).toBe('');
      expect(isTerminalReport('\x1b[?12;2$y')).toBe(true);
      expect(isTerminalReport('\x1b[?1;2c')).toBe(true);
      expect(isTerminalReport('\x1b[>0;276;0c')).toBe(true);
      expect(isTerminalReport('\x1b[24;80R')).toBe(true);
      for (const chord of ['\x1bb', '\x1bf', '\x1b[D', '\x1b[C', '\x1bOD', '\x1b[1;3D', '\x1b[1;3C', '\x1b[?12;2$yD', '\x1b[D\x1b[?12;2$y']) {
        expect(isTerminalReport(chord), JSON.stringify(chord)).toBe(false);
      }
    });
  });

  describe.skipIf(!sh)('a program that hides the cursor and draws its own caret', () => {
    it('also sends nothing while the cursor is hidden', async () => {
      const s = await session(sh!, ['-c', String.raw`printf 'ready\033[?25l'; stty raw -echo; head -c 1 | od -An -c; stty sane`], {});
      await s.waitFor(/ready/);
      expect(await s.option(LEFT)).toBe('');
      expect(await s.option(RIGHT)).toBe('');
      s.type('X');
      await s.waitFor(/X/);
    });
  });
});
