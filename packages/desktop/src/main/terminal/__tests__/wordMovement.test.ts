import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { delimiter, join } from 'node:path';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The terminal sends ESC b / ESC f for Option+Left/Right on macOS
 * (renderer/views/terminal/wordKeys.ts). That is only right if the shells a user
 * starts with move a word on those bytes, so this types them into stock zsh and
 * bash, with no startup files, through a real pty, and reads back where the
 * cursor was by what the command line ran.
 */

const REQUIRED_TOOLS = new Set((process.env.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean));
const PROMPT = 'word-test> ';

interface Shell { name: string; args: string[]; env: Record<string, string>; afterTwoForward: string }

// zsh's forward-word stops at the start of the next word, bash's at the end of this one.
const SHELLS: Shell[] = [
  { name: 'zsh', args: ['-f'], env: {}, afterTwoForward: 'one Xtwo three' },
  { name: 'bash', args: ['--norc', '--noprofile'], env: { INPUTRC: devNull }, afterTwoForward: 'oneX two three' },
];

const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, name)).find((file) => existsSync(file));

const open: IPty[] = [];
afterEach(() => {
  for (const pty of open.splice(0)) {
    try { pty.kill(); } catch { /* already gone */ }
  }
});

// The subject is POSIX shells' line editors; Windows' shells are PowerShell and cmd, and the rewrite is macOS's.
// The tests are registered after node-pty loads, so the suite awaits it.
describe.skipIf(process.platform === 'win32')('word movement in the stock shells', async () => {
  const loaded = await import('node-pty').then((pty) => ({ pty }), (error: unknown) => ({ error: String(error).split('\n')[0] }));
  if ('error' in loaded) {
    it.skip(`types into a real shell (node-pty does not load here: ${loaded.error})`, () => {});
    return;
  }
  const { pty } = loaded;

  /** Types `echo one two three`, then `keys`, then X and Enter; returns the line the echo printed. */
  async function typeInto(file: string, shell: Shell, keys: string): Promise<string> {
    const term = pty.spawn(file, shell.args, {
      cols: 120, rows: 30, cwd: process.cwd(),
      // No EDITOR or VISUAL: zsh starts in vi mode when either names vi, where ESC b means something else.
      env: { TERM: 'xterm-256color', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HISTFILE: devNull, PS1: PROMPT, ...shell.env },
    });
    open.push(term);
    let output = '';
    term.onData((data) => { output += data; });
    await vi.waitFor(() => { if (!output.includes(PROMPT)) throw new Error(`no prompt yet: ${JSON.stringify(output)}`); });
    term.write(`echo one two three${keys}X\r`);
    return vi.waitFor(() => {
      const line = /\r\n(one[^\r\n]*)\r\n/.exec(output)?.[1];
      if (line === undefined) throw new Error(`echo has not run yet: ${JSON.stringify(output)}`);
      return line;
    });
  }

  for (const shell of SHELLS) {
    const file = onPath(shell.name);
    if (!file) {
      if (REQUIRED_TOOLS.has(shell.name)) {
        it(`moves ${shell.name}'s cursor a word`, () => { throw new Error(`${shell.name} is missing, and ORDEWELL_REQUIRE_TOOLS requires it`); });
      } else {
        it.skip(`moves ${shell.name}'s cursor a word (${shell.name} is not installed here)`, () => {});
      }
      continue;
    }

    it(`moves ${shell.name}'s cursor a word back on ESC b, as Option+Left sends it`, async () => {
      expect(await typeInto(file, shell, '\x1bb\x1bb')).toBe('one Xtwo three');
    });

    it(`moves ${shell.name}'s cursor a word forward on ESC f, as Option+Right sends it`, async () => {
      // Ctrl+A first, to the start of the line.
      expect(await typeInto(file, shell, '\x01\x1bf\x1bf')).toBe(shell.afterTwoForward);
    });
  }
});
