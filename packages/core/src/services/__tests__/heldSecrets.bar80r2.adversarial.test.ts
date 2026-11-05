import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeldSecrets } from '../HeldSecrets';
import { ScriptRunner } from '../ScriptRunner';
import { hideHeld, redactAgentText, redactSourceText, withoutTerminalEscapes } from '../../utils/redactSecrets';
import type { ScriptExit, StructuredEvent } from '../../interfaces/IRunner';
import { DEFAULT_SCRIPT_TIMEOUT_MS, type ScriptBody } from '../../models/ScriptTask';

/**
 * Task #80 round 2. Fake values only, no rule's shape.
 */
const HELD = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const parts = (value: string) => Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8));
/** Any 8-char part of `value` in the bytes as kept, or as a terminal or an escape-dropping reader shows them. */
const leaks = (text: string, value = HELD) =>
  [text, withoutTerminalEscapes(text)].some((t) => parts(value).some((part) => t.includes(part)));

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bar80r2 (a): a held value inside an OSC payload (a window title, a hyperlink target)', () => {
  const TITLE = `ready \x1b]0;${HELD}\x07 done\n`;
  const LINK = `see \x1b]8;;https://h.example/?t=${HELD}\x1b\\here\x1b]8;;\x1b\\ done\n`;

  it('control: redactAgentText (live tail, final text, report, handoff) drops the payload with its escape', () => {
    expect(leaks(redactAgentText(TITLE, [HELD]))).toBe(false);
    expect(leaks(redactAgentText(LINK, [HELD]))).toBe(false);
  });

  it('hideHeld hides a held value in an OSC title payload', () => {
    expect(leaks(hideHeld(TITLE, [HELD]))).toBe(false);
  });

  it('hideHeld hides a held value in an OSC 8 hyperlink target', () => {
    expect(leaks(hideHeld(LINK, [HELD]))).toBe(false);
  });

  it('HeldSecrets.hideIn hides it in a tool-call line', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const event = { type: 'tool_call_update', id: 'c1', output: TITLE } as unknown as StructuredEvent;
    expect(leaks(JSON.stringify(secrets.hideIn(event)))).toBe(false);
  });

  it('HeldSecrets.hideError hides it in a start error', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const err = secrets.hideError(new Error(`container exited: ${TITLE}`)) as Error;
    expect(leaks(err.message)).toBe(false);
  });

  it('HeldSecrets.shownEvents hides it in task events', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const shown = [
      ...secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text: TITLE }),
      ...secrets.shownEvents({ type: 'turn_end', reason: 'completed' } as unknown as StructuredEvent),
    ];
    expect(leaks(shown.flatMap((e) => (e.type === 'assistant_text_delta' ? [e.text] : [])).join(''))).toBe(false);
  });

  it('HeldSecrets.stream hides it in a pipe', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    expect(leaks(pipe.write(TITLE) + pipe.end())).toBe(false);
  });

  it('redactSourceText (research output, fixtures) hides it', () => {
    expect(leaks(redactSourceText(TITLE, [HELD]))).toBe(false);
  });

  it('ScriptRunner: a step that sets its window title to its held credential hides it in output, log, saved file, error tail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-bar80r2-'));
    workspaces.push(dir);
    const runner = new ScriptRunner({ fullOutputFile: () => path.join(dir, 'out.log') });
    const code = [
      'const v = process.env.MISTRAL_API_KEY;',
      "process.stdout.write('ready \\x1b]0;' + v + '\\x07 done\\n');",
      "process.stderr.write('bad \\x1b]0;' + v + '\\x07\\n');",
      'process.exit(3);',
    ].join(' ');
    const session = await runner.spawn({
      taskId: 't1', runner: 'script', prompt: '', cwd: dir, env: { MISTRAL_API_KEY: HELD }, attempt: 1,
      script: { timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS, commands: [[process.execPath, '-e', code]] } as ScriptBody,
    });
    const events: StructuredEvent[] = [];
    let output = '';
    session.onEvent((event) => events.push(event));
    session.onOutput((text) => { output += text; });
    const exit = await new Promise<ScriptExit>((resolve) => session.onScriptExit(resolve));
    const logged = events.flatMap((e) => (e.type === 'script_output' ? [e.text] : [])).join('');
    const saved = exit.fullOutput ? fs.readFileSync(exit.fullOutput.file, 'utf8') : '';
    const tail = exit.outcome === 'failed' ? exit.errorTail : '';
    expect({ output: leaks(output), logged: leaks(logged), saved: leaks(saved), tail: leaks(tail), final: leaks(session.getOutput()) })
      .toEqual({ output: false, logged: false, saved: false, tail: false, final: false });
  });
});

describe('bar80r2 (a)/(b): a truecolor escape (fg and bg, 33 param chars) inside a held value, the pipe split before its final byte', () => {
  const SGR = '\x1b[38;2;255;255;255;48;2;255;255;255m';
  const TEXT = `key ${HELD.slice(0, 6)}${SGR}${HELD.slice(6, 12)}\x1b[0m done\n`;
  const SPLIT = TEXT.indexOf(SGR) + SGR.length - 1;

  it('control: whole, the value is hidden', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    expect(leaks(secrets.hide(TEXT))).toBe(false);
  });

  it('control: split one char earlier inside the params (32 of them), the value is hidden', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const at = SPLIT - 1;
    expect(leaks(pipe.write(TEXT.slice(0, at)) + pipe.write(TEXT.slice(at)) + pipe.end())).toBe(false);
  });

  it('HeldSecrets.stream(): split before the final byte, the value is hidden', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const out = pipe.write(TEXT.slice(0, SPLIT)) + pipe.write(TEXT.slice(SPLIT)) + pipe.end();
    expect(out).toBe(secrets.hide(TEXT));
    expect(leaks(out)).toBe(false);
  });

  it('HeldSecrets.shownEvents(): deltas split before the final byte, the value is hidden', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const shown = [
      ...secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text: TEXT.slice(0, SPLIT) }),
      ...secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text: TEXT.slice(SPLIT) }),
      ...secrets.shownEvents({ type: 'turn_end', reason: 'completed' } as unknown as StructuredEvent),
    ];
    expect(leaks(shown.flatMap((e) => (e.type === 'assistant_text_delta' ? [e.text] : [])).join(''))).toBe(false);
  });
});

describe('bar80r2 (a): an escape whose last byte is a held value\'s first char', () => {
  const SHORT = 'Fk8pQ2zx'; // 8 chars, the shortest value held

  it('hideHeld: CSI params then the value (`ESC [ 1` + value), the raw bytes keep no part', () => {
    const out = hideHeld(`n \x1b[1${SHORT} end`, [SHORT]);
    expect(out.includes(SHORT)).toBe(false);
  });

  it('hideHeld: a charset selection then a value starting `B` (`ESC (` + value), the raw bytes keep no part', () => {
    const value = 'B' + SHORT.slice(1);
    const out = hideHeld(`n \x1b(${value} end`, [value]);
    expect(out.includes(value)).toBe(false);
  });
});

/**
 * Bar (c): every adversarial 64k input finishes under 1 s.
 */
describe('bar80r2 (c): 64k of escapes after a held part, streamed in 4-char writes', () => {
  const ESCAPES = '\x1b[0m'.repeat(16000); // 64k chars

  const timed = (text: string, size: number, viaEvents: boolean) => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const started = performance.now();
    let out = '';
    if (viaEvents) {
      const shown: StructuredEvent[] = [];
      for (let at = 0; at < text.length; at += size) shown.push(...secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text: text.slice(at, at + size) }));
      shown.push(...secrets.shownEvents({ type: 'turn_end', reason: 'completed' } as unknown as StructuredEvent));
      out = shown.flatMap((e) => (e.type === 'assistant_text_delta' ? [e.text] : [])).join('');
    } else {
      const pipe = secrets.stream();
      for (let at = 0; at < text.length; at += size) out += pipe.write(text.slice(at, at + size));
      out += pipe.end();
    }
    return { ms: performance.now() - started, out };
  };

  it('control: 64k of escapes after plain words, in 4-char writes, under 1 s', () => {
    const { ms } = timed('x words ' + ESCAPES, 4, false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('HeldSecrets.stream(): a begun part (5 chars of a value) then 64k of escapes, under 1 s', () => {
    const { ms, out } = timed('x ' + HELD.slice(0, 5) + ESCAPES, 4, false);
    expect(leaks(out)).toBe(false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('HeldSecrets.stream(): a held run then 64k of escapes, under 1 s', () => {
    const { ms, out } = timed('x ' + HELD + ESCAPES, 4, false);
    expect(leaks(out)).toBe(false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('HeldSecrets.shownEvents(): a held run then 64k of escapes, under 1 s', () => {
    const { ms, out } = timed('x ' + HELD + ESCAPES, 4, true);
    expect(leaks(out)).toBe(false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);
});

/**
 * F1 variants: however a stream is split, what it shows is what hiding the
 * whole text shows, over a broader escape alphabet than bar80's.
 */
describe('bar80r2 (a)/(b): a stream split anywhere, broad escape alphabet, shows what the whole text shows', () => {
  const ESCAPES = ['\x1b[31m', '\x1b[0m', '\x1b[K', '\x1b[?25h', '\x1b[38;5;196m', '\x1b[38;2;10;20;30m', '\x1b(B', '\x1b=', '\x1b>', '\x1b]0;t\x07', '\x1b]8;;u\x1b\\'];
  const LONG = ['\x1b[38;2;255;255;255;48;2;255;255;255m'];
  const run = (alphabet: string[], label: string, maxSplit: number) => {
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pieces = [HELD, HELD.slice(0, 9), HELD.slice(5, 20), HELD.slice(-12), HELD.slice(0, 7), ' ', '\n', 'word', 'q'];
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const failures: string[] = [];
    for (let n = 0; n < 3000 && failures.length < 3; n++) {
      let text = '';
      for (let k = 1 + Math.floor(random() * 12); k > 0; k--) text += pieces[Math.floor(random() * pieces.length)];
      // An escape inside a value, where it does not land inside another escape.
      for (let e = 0; e < 2; e++) {
        const at = Math.floor(random() * text.length);
        // eslint-disable-next-line no-control-regex
        if (!/\x1b[^m\x07\\KhB=>]*$/.test(text.slice(0, at))) text = text.slice(0, at) + alphabet[Math.floor(random() * alphabet.length)] + text.slice(at);
      }
      const pipe = secrets.stream();
      let out = '';
      for (let i = 0; i < text.length; ) {
        const size = 1 + Math.floor(random() * maxSplit);
        out += pipe.write(text.slice(i, i + size));
        i += size;
      }
      out += pipe.end();
      if (out !== secrets.hide(text)) failures.push(JSON.stringify(text));
    }
    expect(failures, label).toEqual([]);
  };
  it('control: the common escapes, split 1–6 chars', () => run(ESCAPES, 'common', 6));
  it('control: the common escapes, split a char at a time', () => run(ESCAPES, 'common', 1));
  it('a truecolor fg+bg escape (33 param chars), split 1–6 chars', () => run(LONG, 'long', 6));
});

/** F4 re-measured: a 64k run of held text in 1- and 4-char deltas, and with held values of key size. */
describe('bar80r2 (c): a 64k held run in small deltas', () => {
  const RUN = HELD.repeat(Math.ceil((64 * 1024) / HELD.length)).slice(0, 64 * 1024);
  it.each([1, 4])('HeldSecrets.stream(), %i-char writes, under 1 s', (size) => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const started = performance.now();
    let out = '';
    for (let at = 0; at < RUN.length; at += size) out += pipe.write(RUN.slice(at, at + size));
    out += pipe.end();
    const ms = performance.now() - started;
    expect(leaks(out)).toBe(false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  /** A PEM key in the spawn env (`GITHUB_APP_PRIVATE_KEY`, named `_KEY`) is held whole: ~1.7k chars, each write rebuilds its ~1.7k parts. */
  const LINE = 'MIIEowIBAAKCAQEAfakeKeyBodyLineAbCdEfGhIjKlMnOpQrStUvWxYz01234567';
  const PEM = ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 26 }, (_, i) => (LINE.slice(i) + LINE.slice(0, i)).slice(0, 64)), '-----END RSA PRIVATE KEY-----'].join('\n');
  const BUILD = 'build step ok\n'.repeat(Math.ceil((64 * 1024) / 14)).slice(0, 64 * 1024);

  it('control: the PEM is held from the spawn env', () => {
    const secrets = new HeldSecrets();
    secrets.holdEnv({ GITHUB_APP_PRIVATE_KEY: PEM });
    expect(secrets.hide(`x ${PEM.slice(100, 120)} y`)).not.toContain(PEM.slice(100, 120));
  });

  it('HeldSecrets.stream(): 64k of plain build output in 4-char writes, a PEM key held, under 1 s', () => {
    const secrets = new HeldSecrets();
    secrets.holdEnv({ GITHUB_APP_PRIVATE_KEY: PEM, MISTRAL_API_KEY: HELD });
    const pipe = secrets.stream();
    const started = performance.now();
    for (let at = 0; at < BUILD.length; at += 4) pipe.write(BUILD.slice(at, at + 4));
    pipe.end();
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);

  it('HeldSecrets.shownEvents(): 64k of plain deltas of 4 chars, a PEM key held, under 1 s', () => {
    const secrets = new HeldSecrets();
    secrets.holdEnv({ GITHUB_APP_PRIVATE_KEY: PEM, MISTRAL_API_KEY: HELD });
    const started = performance.now();
    for (let at = 0; at < BUILD.length; at += 4) secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text: BUILD.slice(at, at + 4) });
    secrets.shownEvents({ type: 'turn_end', reason: 'completed' } as unknown as StructuredEvent);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);
});
