import { describe, it, expect } from 'vitest';
import { stripAnsi, posixShellQuote, buildShellInvocation, wrapWithPty } from '../shell';

describe('stripAnsi', () => {
  it('removes CSI color/cursor sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain');
    expect(stripAnsi('\x1b[2K\x1b[1Gspinner')).toBe('spinner');
  });

  it('removes OSC title sequences and carriage returns', () => {
    expect(stripAnsi('\x1b]0;window title\x07text\rline')).toBe('textline');
  });

  it('removes charset selection sequences', () => {
    expect(stripAnsi('\x1b(Bhello\x1b)0')).toBe('hello');
  });

  it('is stable across repeated calls (global regex state)', () => {
    const input = '\x1b[31mred\x1b[0m';
    expect(stripAnsi(input)).toBe('red');
    expect(stripAnsi(input)).toBe('red');
  });
});

describe('posixShellQuote', () => {
  it('wraps in single quotes', () => {
    expect(posixShellQuote('hello world')).toBe(`'hello world'`);
  });

  it('escapes embedded single quotes', () => {
    expect(posixShellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('keeps shell metacharacters literal', () => {
    expect(posixShellQuote('$HOME; rm -rf *')).toBe(`'$HOME; rm -rf *'`);
  });
});

describe('buildShellInvocation', () => {
  it('builds a bash -lc login-shell invocation', () => {
    const inv = buildShellInvocation('claude', ['-p', 'do it']);
    expect(inv.shellPath).toBe('/bin/bash');
    expect(inv.shellArgs).toEqual(['-lc', `'claude' '-p' 'do it'`]);
  });

  it('quotes an argument containing a single quote', () => {
    const inv = buildShellInvocation('claude', [`it's`]);
    expect(inv.shellArgs[1]).toBe(`'claude' 'it'\\''s'`);
  });
});

describe('wrapWithPty', () => {
  it('wraps the command in script with exit-code propagation', () => {
    const wrapped = wrapWithPty('opencode', ['run', 'my prompt']);
    expect(wrapped.command).toBe('script');
    expect(wrapped.args).toEqual(['-q', '-e', '-f', '-c', `'opencode' 'run' 'my prompt'`, '/dev/null']);
  });

  it('quotes embedded single quotes in the inner command', () => {
    const wrapped = wrapWithPty('run', [`it's`]);
    expect(wrapped.args[4]).toBe(`'run' 'it'\\''s'`);
  });

  it('sizes the PTY before the command starts when given a size', () => {
    const wrapped = wrapWithPty('codex', [], { size: { cols: 120, rows: 30 } });
    expect(wrapped.args[4]).toBe(`stty cols 120 rows 30; 'codex'`);
  });

  it('keeps the stty setup ahead of the wrapped command', () => {
    const wrapped = wrapWithPty('claude', ['go'], { size: { cols: 80, rows: 24 } });
    expect(wrapped.args[4]).toBe(`stty cols 80 rows 24; 'claude' 'go'`);
  });

  // POSIX sends an asynchronous job's stdin to /dev/null, so the watcher must
  // save the PTY on fd 4 and name it for stty, or the resize silently no-ops.
  it('adds a resize watcher on fd 3 when a control channel is requested', () => {
    const wrapped = wrapWithPty('opencode', [], { controlChannel: true });
    expect(wrapped.args[4]).toContain('exec 4<&0; ( while read -r C R <&3; do stty cols "$C" rows "$R" <&4; done ) &');
  });

  it('combines the watcher and the initial size setup', () => {
    const wrapped = wrapWithPty('opencode', [], { controlChannel: true, size: { cols: 100, rows: 40 } });
    const inner = wrapped.args[4] as string;
    expect(inner).toContain('exec 4<&0');
    expect(inner).toContain('stty cols 100 rows 40;');
    expect(inner.endsWith(`'opencode'`)).toBe(true);
  });
});
