import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WordLink, wordLinkFits } from '../wordLink';

/**
 * Option+Left/Right through the link (ADR-0069), against a real zsh in a real
 * pty, started as the app starts it: a login shell whose startup files are a
 * user's own, read through the link's zshenv. Keys go through the link as the
 * page's keystrokes do, so what they do around a move is in the order typed.
 *
 * The shell is read by its own ZLE state from a widget the user's .zshrc binds
 * to ^T, which is also a custom binding the link must leave alone.
 */

const REQUIRED_TOOLS = new Set((process.env.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean));
const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, name)).find((file) => existsSync(file));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROMPT = 'word-link> ';
const DUMP = '\x14';
const DUMPED = /DUMP<([^|]*)\|(\d+)\|(\w+)>/g;
const ZSHRC = [
  `PS1='${PROMPT}'`,
  'HISTFILE=/dev/null',
  'print -r -- ZSHRC-READ',
  // `main` is whichever of emacs and viins bindkey linked it to.
  `dump() { print -rn -- $'\\r\\n'"DUMP<\${(V)BUFFER}|\${CURSOR}|\${KEYMAP/main/$insert}>"$'\\r\\n' }`,
  'zle -N dump',
  "for m in emacs viins vicmd; bindkey -M $m '^T' dump",
  'acc() { zle .accept-line }; zle -N acc; bindkey -M emacs "^Xz" acc',
  '[[ -n $WORD_TEST_VI ]] && { bindkey -v; insert=viins } || { bindkey -e; insert=emacs }',
].join('\n');

const homes: string[] = [];
const open: Array<{ term: IPty; link: WordLink }> = [];
afterEach(() => {
  for (const { term, link } of open.splice(0)) {
    link.dispose();
    try { term.kill(); } catch { /* already gone */ }
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('wordLinkFits', () => {
  const none = () => false;
  it("is Apple's zsh on macOS only", () => {
    expect(wordLinkFits('darwin', '/bin/zsh', { HOME: '/u' }, none)).toBe(true);
    expect(wordLinkFits('darwin', '/opt/homebrew/bin/zsh', { HOME: '/u' }, none)).toBe(false);
    expect(wordLinkFits('darwin', '/bin/bash', { HOME: '/u' }, none)).toBe(false);
    expect(wordLinkFits('linux', '/bin/zsh', { HOME: '/u' }, none)).toBe(false);
  });

  it('stands aside for any zshenv, the system one or the user’s, compiled or not', () => {
    for (const file of ['/etc/zshenv', '/etc/zshenv.zwc', join('/u', '.zshenv'), join('/u', '.zshenv.zwc')]) {
      expect(wordLinkFits('darwin', '/bin/zsh', { HOME: '/u' }, (path) => path === file)).toBe(false);
    }
    expect(wordLinkFits('darwin', '/bin/zsh', { HOME: '/u', ZDOTDIR: '/z' }, (path) => path === join('/z', '.zshenv'))).toBe(false);
    expect(wordLinkFits('darwin', '/bin/zsh', { HOME: '/u', ZDOTDIR: '/z' }, (path) => path === join('/u', '.zshenv'))).toBe(true);
    expect(wordLinkFits('darwin', '/bin/zsh', {}, none)).toBe(false);
  });
});

// zsh's line editor is the subject, and the link is a unix socket; the move is offered on macOS.
describe.skipIf(process.platform === 'win32')('the word link in a real zsh', async () => {
  const loaded = await import('node-pty').then((pty) => ({ pty }), (error: unknown) => ({ error: String(error).split('\n')[0] }));
  const zshFile = onPath('zsh');
  if ('error' in loaded) {
    it.skip(`moves in a real shell (node-pty does not load here: ${loaded.error})`, () => {});
    return;
  }
  if (!zshFile) {
    if (REQUIRED_TOOLS.has('zsh')) it('moves in zsh', () => { throw new Error('zsh is missing, and ORDEWELL_REQUIRE_TOOLS requires it'); });
    else it.skip('moves in zsh (zsh is not installed here)', () => {});
    return;
  }
  const { pty } = loaded;
  const zshPath: string = zshFile;

  async function shell(options: { vi?: boolean; zdotdir?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'word-link-home-'));
    homes.push(home);
    const dotdir = options.zdotdir ? join(home, 'dots') : home;
    if (options.zdotdir) mkdirSync(dotdir);
    writeFileSync(join(dotdir, '.zshrc'), ZSHRC);
    writeFileSync(join(dotdir, '.zprofile'), 'print -r -- ZPROFILE-READ\n');
    const userEnv: Record<string, string> = options.zdotdir ? { ZDOTDIR: dotdir } : {};
    const link = await WordLink.open(userEnv);
    const term = pty.spawn(zshPath, ['-l'], {
      cols: 120, rows: 30, cwd: home,
      env: { TERM: 'xterm-256color', PATH: process.env.PATH ?? '', HOME: home, ...userEnv, ...(options.vi ? { WORD_TEST_VI: '1' } : {}), ...link.env },
    });
    let linked = false;
    link.attach(term, () => { linked = true; });
    open.push({ term, link });
    let output = '';
    term.onData((data) => { output += data; });
    await vi.waitFor(() => { if (!linked || !output.includes(PROMPT)) throw new Error(`not up yet: ${JSON.stringify(output)}`); });
    let dumps = 0;
    return {
      home,
      dotdir,
      get output() { return output; },
      type: (data: string) => link.write(data),
      word: (direction: 'left' | 'right') => link.word(direction),
      /** Asks for a dump behind everything typed so far and waits for it. */
      async state() {
        link.write(DUMP);
        dumps += 1;
        const all = await vi.waitFor(() => {
          const found = [...output.matchAll(DUMPED)];
          if (found.length < dumps) throw new Error(`no dump yet: ${JSON.stringify(output.slice(-300))}`);
          return found;
        });
        const [, buffer, cursor, keymap] = all[dumps - 1];
        return { buffer, cursor: Number(cursor), keymap };
      },
      async prompt(after: number) {
        await vi.waitFor(() => { if (output.split(PROMPT).length <= after) throw new Error(`no prompt yet: ${JSON.stringify(output.slice(-300))}`); });
      },
      prompts: () => output.split(PROMPT).length,
    };
  }

  const LINE = 'echo one two three';

  it('reads the user’s own startup files, binds no key and leaves no trace in the environment', async () => {
    const zsh = await shell();
    expect(zsh.output).toContain('ZPROFILE-READ');
    expect(zsh.output).toContain('ZSHRC-READ');
    const before = zsh.prompts();
    zsh.type('print -r -- "env<${+ZDOTDIR}${+ORDEWELL_WORD_SOCKET}${+ORDEWELL_USER_ZDOTDIR}> keys<$(bindkey -L | grep -c ordewell)>"\r');
    await zsh.prompt(before);
    expect(zsh.output).toContain('env<000> keys<0>');
    expect(readFileSync(join(zsh.home, '.zshrc'), 'utf8')).toBe(ZSHRC);
    expect(readdirSync(zsh.home).sort()).toEqual(expect.arrayContaining(['.zprofile', '.zshrc']));
  });

  it('puts a ZDOTDIR the user set back, so zsh reads their files from it', async () => {
    const zsh = await shell({ zdotdir: true });
    expect(zsh.output).toContain('ZSHRC-READ');
    const before = zsh.prompts();
    zsh.type('print -r -- "dot<$ZDOTDIR>"\r');
    await zsh.prompt(before);
    expect(zsh.output).toContain(`dot<${zsh.dotdir}>`);
  });

  it('moves by words in emacs mode, and what is typed next goes where the cursor went', async () => {
    const zsh = await shell();
    zsh.type(LINE);
    zsh.word('left');
    expect(await zsh.state()).toEqual({ buffer: LINE, cursor: 13, keymap: 'emacs' });
    zsh.word('left');
    expect(await zsh.state()).toEqual({ buffer: LINE, cursor: 9, keymap: 'emacs' });
    zsh.word('right');
    zsh.type('X');
    // The end of the word, as macOS moves.
    expect(await zsh.state()).toEqual({ buffer: 'echo one twoX three', cursor: 13, keymap: 'emacs' });
  });

  it('moves in vi insert and command mode and stays in the mode', async () => {
    const zsh = await shell({ vi: true });
    zsh.type(LINE);
    zsh.word('left');
    zsh.type('X');
    expect(await zsh.state()).toEqual({ buffer: 'echo one two Xthree', cursor: 14, keymap: 'viins' });
    zsh.type('\x1b');
    // Past KEYTIMEOUT, so the ESC is a key and not the start of one.
    await sleep(600);
    expect(await zsh.state()).toMatchObject({ keymap: 'vicmd', cursor: 13 });
    zsh.word('left');
    expect(await zsh.state()).toEqual({ buffer: 'echo one two Xthree', cursor: 9, keymap: 'vicmd' });
    zsh.word('right');
    expect(await zsh.state()).toEqual({ buffer: 'echo one two Xthree', cursor: 13, keymap: 'vicmd' });
  });

  it('keeps the order of keys typed just before and just after the chord', async () => {
    const zsh = await shell();
    for (let i = 0; i < 5; i++) {
      zsh.type(`echo alpha beta ${i}`);
      zsh.word('left');
      zsh.type('X');
      expect(await zsh.state()).toEqual({ buffer: `echo alpha beta X${i}`, cursor: 17, keymap: 'emacs' });
      zsh.type('\x15');
    }
  });

  it('a held chord moves, drops what it cannot keep up with, and never edits', async () => {
    const zsh = await shell();
    zsh.type(LINE);
    for (let i = 0; i < 20; i++) { zsh.word('left'); await sleep(5); }
    const held = await zsh.state();
    expect(held.buffer).toBe(LINE);
    expect(held.cursor).toBeLessThan(LINE.length);
    zsh.type('X');
    const after = await zsh.state();
    expect(after.buffer).toBe(`${LINE.slice(0, held.cursor)}X${LINE.slice(held.cursor)}`);
  });

  it('does not reach back into a line a custom widget accepted before the chord', async () => {
    const zsh = await shell();
    const before = zsh.prompts();
    zsh.type('echo first second\x18z');
    zsh.word('left');
    zsh.type('X');
    await zsh.prompt(before);
    expect(await zsh.state()).toEqual({ buffer: 'X', cursor: 1, keymap: 'emacs' });
    expect(zsh.output).toContain('first second');
  });

  it('does nothing while a command runs, and the keys typed meanwhile reach the next prompt in order', async () => {
    const zsh = await shell();
    const before = zsh.prompts();
    zsh.type('sleep 0.4\r');
    await sleep(50);
    zsh.word('left');
    zsh.type('echo one two');
    await zsh.prompt(before);
    expect(await zsh.state()).toEqual({ buffer: 'echo one two', cursor: 12, keymap: 'emacs' });
    // Back at its prompt, the shell answered the stale request and the chord works again.
    zsh.word('left');
    expect(await zsh.state()).toEqual({ buffer: 'echo one two', cursor: 9, keymap: 'emacs' });
  });

  it('sends a program in the foreground nothing', async () => {
    const zsh = await shell();
    const before = zsh.prompts();
    zsh.type('cat -v\r');
    await sleep(200);
    zsh.type('one two');
    zsh.word('left');
    zsh.word('right');
    zsh.type('X\r\x04');
    await zsh.prompt(before);
    expect(zsh.output).toContain('one twoX\r\n');
    expect(zsh.output).not.toContain('^[');
  });

  it('gives a nested shell nothing to connect to, and leaves its line alone', async () => {
    const zsh = await shell();
    const before = zsh.prompts();
    zsh.type(`${zshFile} -f\r`);
    await sleep(300);
    zsh.type('PS1="nested> "; print -r -- "nested<${+ORDEWELL_WORD_SOCKET}${+ZDOTDIR}>"\r');
    await vi.waitFor(() => { if (!zsh.output.includes('nested<00>')) throw new Error(zsh.output.slice(-200)); });
    zsh.type('echo one two');
    zsh.word('left');
    zsh.type('X\r');
    await vi.waitFor(() => { if (!zsh.output.includes('one twoX\r\n')) throw new Error(zsh.output.slice(-200)); });
    zsh.type('exit\r');
    await zsh.prompt(before);
  });

  it('refuses inside an incremental search, a completion menu and a pending vi operator', async () => {
    const zsh = await shell();
    // Each line waits for its prompt: typed ahead, the terminal's own line editing takes ^R and ^T.
    const run = async (line: string) => { const before = zsh.prompts(); zsh.type(`${line}\r`); await zsh.prompt(before); };
    // The same keys with and without the chord must leave the same line.
    const twice = async (keys: string) => {
      const states = [];
      for (const chord of [false, true]) {
        zsh.type(keys);
        await sleep(200);
        if (chord) { zsh.word('left'); await sleep(300); }
        states.push(await zsh.state());
        await run('\x15');
      }
      return states;
    };
    await run('echo one two three');
    // ^T ends the search and dumps the line it found, with the cursor where the search left it.
    const [searched, searchedWithChord] = await twice('echo four five\x12one');
    expect(searched.buffer).toBe(LINE);
    expect(searchedWithChord).toEqual(searched);

    await run('zmodload zsh/complist; autoload -U compinit; compinit -u; zstyle ":completion:*" menu select');
    await run(': > aa1; : > aa2; : > aa3');
    // ^T leaves the menu with the match it was on and dumps the line.
    const [picked, pickedWithChord] = await twice('ls a\t\t\t');
    expect(picked.buffer).toMatch(/^ls aa\d/);
    expect(pickedWithChord).toEqual(picked);

    const vim = await shell({ vi: true });
    vim.type(LINE);
    vim.type('\x1b');
    await sleep(600);
    vim.type('0d');
    await sleep(100);
    vim.word('right');
    await sleep(300);
    vim.type('w');
    expect(await vim.state()).toEqual({ buffer: 'one two three', cursor: 0, keymap: 'vicmd' });
  });
});
