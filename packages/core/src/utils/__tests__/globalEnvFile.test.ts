import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { homeEnv, setEnv } from '../../testEnv';
import { globalEnvFile, readEnvFile, writeEnvFileVars } from '../globalEnvFile';

/*
 * `~/.ordewell/.env` holds every provider key a surface saved. The CLI, the
 * TUI and the daemon read it, and the CLI, the TUI and the daemon write it: a
 * line the writer did not recognise as the key's, and left beside the new one,
 * was the line a reader took.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordewell-env-file-'));
  file = join(dir, '.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const written = (text: string) => writeFileSync(file, text);
const content = () => readFileSync(file, 'utf8');

describe('globalEnvFile', () => {
  it('is .env in the data directory of the home', () => {
    const restore = setEnv(homeEnv(dir));
    try {
      expect(globalEnvFile()).toBe(join(dir, '.ordewell', '.env'));
    } finally {
      restore();
    }
  });
});

describe('readEnvFile', () => {
  it('reads nothing from a file that is not there', () => {
    expect(readEnvFile(file)).toEqual({});
  });

  it('reads a key past a byte-order mark, an export, space around =, quotes and CRLF', () => {
    written('\uFEFFFIRST_KEY=one\r\nexport SECOND_KEY=two\r\n  THIRD_KEY = "three" \r\nFOURTH_KEY=\'four\'\r\n');
    expect(readEnvFile(file)).toEqual({ FIRST_KEY: 'one', SECOND_KEY: 'two', THIRD_KEY: 'three', FOURTH_KEY: 'four' });
  });

  it('skips comments, blank lines, lines with no = and names no shell variable has', () => {
    written('# KEY=commented\n\nNO_EQUALS\n1BAD=x\nBAD-NAME=x\nexported=fine\n');
    expect(readEnvFile(file)).toEqual({ exported: 'fine' });
  });

  it('reads a name set twice as its last line, as a shell sourcing the file does', () => {
    written('OPENROUTER_API_KEY=first\nOPENROUTER_API_KEY=last\n');
    expect(readEnvFile(file)).toEqual({ OPENROUTER_API_KEY: 'last' });
  });

  it('reads a last line with no newline after it, and keeps an = inside the value', () => {
    written('A=1\nB=x=y');
    expect(readEnvFile(file)).toEqual({ A: '1', B: 'x=y' });
  });
});

describe('writeEnvFileVars', () => {
  it('makes the file, its directory too, when neither is there', () => {
    const nested = join(dir, 'missing', 'deeper', '.env');
    writeEnvFileVars(nested, { OPENROUTER_API_KEY: 'sk-or' });
    expect(readFileSync(nested, 'utf8')).toBe('OPENROUTER_API_KEY=sk-or\n');
  });

  it('writes several at once, keeping the file\'s other lines', () => {
    written('# mine\nAI_PROVIDER=claude-code\n');
    writeEnvFileVars(file, { OPENROUTER_API_KEY: 'sk-or', OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1' });
    expect(content()).toBe('# mine\nAI_PROVIDER=claude-code\nOPENROUTER_API_KEY=sk-or\nOPENROUTER_BASE_URL=http://127.0.0.1:1/v1\n');
  });

  // Bug: only a line starting `KEY=` was replaced, so `export KEY=old` stayed beside the new line and the CLI loaded the old key.
  it.each([
    ['an export', 'export OPENROUTER_API_KEY=old\n', 'export OPENROUTER_API_KEY=new\n'],
    ['space around =', 'OPENROUTER_API_KEY = old\n', 'OPENROUTER_API_KEY=new\n'],
    ['a byte-order mark', '\uFEFFOPENROUTER_API_KEY=old\n', 'OPENROUTER_API_KEY=new\n'],
    ['leading space', '  OPENROUTER_API_KEY=old\n', 'OPENROUTER_API_KEY=new\n'],
  ])('replaces a line written with %s, rather than adding a second', (_label, before, after) => {
    written(before);
    writeEnvFileVars(file, { OPENROUTER_API_KEY: 'new' });
    expect(content()).toBe(after);
    expect(readEnvFile(file)).toEqual({ OPENROUTER_API_KEY: 'new' });
  });

  // Bug: the first of two lines was replaced and the second, the one a reader takes, kept the old key.
  it('replaces the first line of a name set twice and takes the later ones out', () => {
    written('OPENROUTER_API_KEY=one\nOTHER=kept\nexport OPENROUTER_API_KEY=two\nOPENROUTER_API_KEY=three\n');
    writeEnvFileVars(file, { OPENROUTER_API_KEY: 'new' });
    expect(content()).toBe('OPENROUTER_API_KEY=new\nOTHER=kept\n');
  });

  it('keeps a CRLF file CRLF', () => {
    written('# mine\r\nOPENROUTER_API_KEY=old\r\n');
    writeEnvFileVars(file, { OPENROUTER_API_KEY: 'new', GEMINI_API_KEY: 'g' });
    expect(content()).toBe('# mine\r\nOPENROUTER_API_KEY=new\r\nGEMINI_API_KEY=g\r\n');
  });

  it('ends a file that had no last newline with one, the new line after the old last', () => {
    written('AI_PROVIDER=claude-code');
    writeEnvFileVars(file, { OPENROUTER_API_KEY: 'sk-or' });
    expect(content()).toBe('AI_PROVIDER=claude-code\nOPENROUTER_API_KEY=sk-or\n');
  });

  it('takes every line of a name out for an undefined value, and makes no file to take one out of', () => {
    written('ORDEWELL_AUTONOMOUS_MODE=false\nKEEP=1\nexport ORDEWELL_AUTONOMOUS_MODE=true\n');
    writeEnvFileVars(file, { ORDEWELL_AUTONOMOUS_MODE: undefined });
    expect(content()).toBe('KEEP=1\n');

    writeEnvFileVars(file, { KEEP: undefined });
    expect(content()).toBe('');

    const absent = join(dir, 'absent', '.env');
    writeEnvFileVars(absent, { KEEP: undefined });
    expect(existsSync(dirname(absent))).toBe(false);
  });

  it('never matches a name by pattern: a key is only ever its own line', () => {
    written('OPENROUTER_API_KEY_OLD=kept\nXOPENROUTER_API_KEY=kept\n');
    writeEnvFileVars(file, { OPENROUTER_API_KEY: 'new' });
    expect(content()).toBe('OPENROUTER_API_KEY_OLD=kept\nXOPENROUTER_API_KEY=kept\nOPENROUTER_API_KEY=new\n');
  });

  it.each([
    ['a line feed', 'sk-or\nAI_PROVIDER=evil'],
    ['a carriage return', 'sk-or\rAI_PROVIDER=evil'],
  ])('refuses a value with %s, writing nothing of any variable', (_label, value) => {
    written('KEEP=1\n');
    expect(() => writeEnvFileVars(file, { GEMINI_API_KEY: 'fine', OPENROUTER_API_KEY: value })).toThrow(/line break/);
    expect(content()).toBe('KEEP=1\n');
  });

  it.each([['KEY.*'], ['1KEY'], ['KEY NAME'], ['']])('refuses %j as a name, writing nothing', (name) => {
    expect(() => writeEnvFileVars(file, { GEMINI_API_KEY: 'fine', [name]: 'value' })).toThrow(/valid environment variable/);
    expect(existsSync(file)).toBe(false);
  });

  it('writes a file a reader of the same rules reads back exactly', () => {
    written('\uFEFF# keys\r\nexport A=1\r\n B = 2 \r\nA=3');
    writeEnvFileVars(file, { A: 'x', B: 'y', C: 'z' });
    expect(readEnvFile(file)).toEqual({ A: 'x', B: 'y', C: 'z' });
  });
});
