import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeldSecrets } from '../HeldSecrets';
import { ScriptRunner } from '../ScriptRunner';
import { StructuredRunner } from '../StructuredRunner';
import { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { coalesceTaskLog, toTaskLogEvent, type TaskLogEvent } from '../../models/TaskLog';
import type { ScriptExit, StructuredEvent } from '../../interfaces/IRunner';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import { DEFAULT_SCRIPT_TIMEOUT_MS, type ScriptBody } from '../../models/ScriptTask';

/**
 * Task #80, bar (a)/(b): a held value split by a colour escape is hidden when
 * the text is whole (hideHeld reads through escapes), and stays hidden when a
 * pipe chunk or a delta ends *inside* the escape: each piece holds fewer than
 * eight characters of the value, but a terminal (or a reader that drops
 * escapes) would show them contiguous.
 *
 * Fake value, no rule's shape.
 */
const HELD = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const SHOWN = HELD.slice(0, 12); // a runner's own slice, `${TOKEN:0:12}` (ADR-0061 names it)
// eslint-disable-next-line no-control-regex
const visible = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b/g, '');
const shows = (text: string) =>
  Array.from({ length: HELD.length - 7 }, (_, i) => HELD.slice(i, i + 8)).some((piece) => visible(text).includes(piece));

describe('bar80: a held value coloured mid-value, the stream split inside the escape', () => {
  it('control: whole, the coloured value is hidden', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    expect(shows(secrets.hide(`key ${SHOWN.slice(0, 6)}\x1b[31m${SHOWN.slice(6)}\x1b[0m done\n`))).toBe(false);
  });

  it('control: split after the escape, the coloured value is hidden', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const out = pipe.write(`key ${SHOWN.slice(0, 6)}\x1b[31m`) + pipe.write(`${SHOWN.slice(6)}\x1b[0m done\n`) + pipe.end();
    expect(shows(out)).toBe(false);
  });

  it('HeldSecrets.stream(): a pipe chunk that ends inside a CSI escape hides the value', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const out = pipe.write(`key ${SHOWN.slice(0, 6)}\x1b[3`) + pipe.write(`1m${SHOWN.slice(6)}\x1b[0m done\n`) + pipe.end();
    expect(visible(out)).not.toContain(SHOWN);
    expect(shows(out)).toBe(false);
  });

  it('HeldSecrets.stream(): a pipe chunk that ends on the bare ESC hides the value', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const out = pipe.write(`key ${SHOWN.slice(0, 6)}\x1b`) + pipe.write(`[31m${SHOWN.slice(6)}\x1b[0m done\n`) + pipe.end();
    expect(shows(out)).toBe(false);
  });

  it('HeldSecrets.shownEvents(): deltas that split a CSI escape hide the value', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const deltas = [`key ${SHOWN.slice(0, 6)}\x1b[3`, `1m${SHOWN.slice(6)}`, '\x1b[0m done'];
    const shown = [
      ...deltas.flatMap((text) => secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text })),
      ...secrets.shownEvents({ type: 'turn_end' } as StructuredEvent),
    ];
    const text = shown.flatMap((event) => (event.type === 'assistant_text_delta' ? [event.text] : [])).join('');
    expect(shows(text)).toBe(false);
  });
});

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bar80: a ScriptRunner step that prints a coloured slice of its held credential in two chunks', () => {
  it('hides the value in its output, task log, saved file and error tail (verdict reason)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-bar80-'));
    workspaces.push(dir);
    const runner = new ScriptRunner({ fullOutputFile: () => path.join(dir, 'out.log') });
    const code = [
      'const v = process.env.MISTRAL_API_KEY;',
      "process.stdout.write('key ' + v.slice(0, 6) + '\\x1b[3');",
      "process.stderr.write('bad ' + v.slice(0, 6) + '\\x1b[3');",
      "setTimeout(() => { process.stdout.write('1m' + v.slice(6, 12) + '\\x1b[0m done\\n'); process.stderr.write('1m' + v.slice(6, 12) + '\\x1b[0m\\n'); process.exit(3); }, 80);",
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
    expect({ output: shows(output), logged: shows(logged), saved: shows(saved), tail: shows(tail), final: shows(session.getOutput()) })
      .toEqual({ output: false, logged: false, saved: false, tail: false, final: false });
  });
});

class StreamingAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId: string = 'codex';
  readonly exited = false;
  readonly sent: string[] = [];
  private turn: { onEvent: (event: AgentEvent) => void; resolve: () => void } | null = null;
  async start(_opts: AgentStartOptions): Promise<void> {}
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  emit(...events: AgentEvent[]): void { for (const event of events) this.turn?.onEvent(event); }
  end(): void { this.turn?.resolve(); }
  async interrupt(): Promise<boolean> { return false; }
  onOutOfTurn(_listener: (event: AgentEvent) => void): void {}
  onProcessExit(_listener: (code: number) => void): void {}
  answerPermission(_id: string, _decision: never): boolean { return false; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); vi.restoreAllMocks(); });

describe('bar80: a StructuredRunner whose deltas split a colour escape inside a held value', () => {
  it('hides the value in the task events and the task log they coalesce into', async () => {
    const server = new OrdewellMcpServer();
    // Sealed runs cannot open a socket: the listener alone is stubbed, as HeldSecrets.test.ts does.
    vi.spyOn(server as unknown as { start: () => Promise<string> }, 'start').mockResolvedValue('http://127.0.0.1:9/mcp');
    const adapters: StreamingAdapter[] = [];
    const runner = new StructuredRunner({ mcp: server, interruptGraceMs: 10, createAdapter: () => { const a = new StreamingAdapter(); adapters.push(a); return a; } });
    runners.push(runner);
    const session = await runner.spawn({
      taskId: 'task-held', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry(), env: { MISTRAL_API_KEY: HELD },
    });
    const events: StructuredEvent[] = [];
    session.onEvent((event) => events.push(event));
    const adapter = adapters[adapters.length - 1];
    await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: `key ${SHOWN.slice(0, 6)}\x1b[3` },
      { type: 'assistant_text_delta', runId: 'r1', text: `1m${SHOWN.slice(6)}` },
      { type: 'assistant_text_delta', runId: 'r1', text: '\x1b[0m done' },
    );
    adapter.end();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'turn_end')).toBe(true));
    const log = coalesceTaskLog(events.map(toTaskLogEvent).filter((event): event is TaskLogEvent => event !== null));
    const text = log.flatMap((event) => (event.type === 'text_delta' ? [event.text] : [])).join('');
    expect({ events: shows(events.flatMap((e) => (e.type === 'assistant_text_delta' ? [e.text] : [])).join('')), log: shows(text) })
      .toEqual({ events: false, log: false });
  });
});

/**
 * Task #80, bar (c): every adversarial input of 64k characters finishes under
 * 1 s (ADR-0061, Testing decisions). A run of held text that reaches the end
 * of what has arrived is held back whole, and a runner that echoes its held
 * value over and over (`yes "$TOKEN"`, an agent quoting its env in a loop)
 * makes that run long: a stream that re-read it on every delta is quadratic.
 */
describe('bar80: a 64k run of held text streamed in model-sized deltas', () => {
  const RUN = HELD.repeat(Math.ceil((64 * 1024) / HELD.length)).slice(0, 64 * 1024);
  const DELTA = 16;

  it('HeldSecrets.shownEvents() finishes under 1 s', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const started = performance.now();
    const shown: StructuredEvent[] = [];
    for (let at = 0; at < RUN.length; at += DELTA) {
      shown.push(...secrets.shownEvents({ type: 'assistant_text_delta', runId: 'r1', text: RUN.slice(at, at + DELTA) }));
    }
    shown.push(...secrets.shownEvents({ type: 'turn_end', reason: 'completed' } as unknown as StructuredEvent));
    const ms = performance.now() - started;
    expect(shows(JSON.stringify(shown))).toBe(false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('HeldSecrets.stream() finishes under 1 s', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const started = performance.now();
    let out = '';
    for (let at = 0; at < RUN.length; at += DELTA) out += pipe.write(RUN.slice(at, at + DELTA));
    out += pipe.end();
    const ms = performance.now() - started;
    expect(shows(out)).toBe(false);
    expect(ms).toBeLessThan(1000);
  }, 120_000);

  it('control: the same 64k run in one chunk finishes under 1 s', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    const started = performance.now();
    const out = pipe.write(RUN) + pipe.end();
    expect(shows(out)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

/**
 * However a stream is split (inside an escape, inside a value, a byte at a
 * time), what it shows is what hiding the whole text shows: the whole text is
 * the independent source. Seeded, so a failure names its text.
 */
describe('bar80: a stream split anywhere shows what the whole text shows', () => {
  it('3000 random texts of held parts, escapes and words, split at random', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pieces = [HELD, HELD.slice(0, 9), HELD.slice(5, 20), HELD.slice(-12), HELD.slice(0, 7), ' ', '\n', 'word', 'q', '\x1b[31m', '\x1b[0m', '\x1b]0;t\x07'];
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    for (let n = 0; n < 3000; n++) {
      let text = '';
      for (let k = 1 + Math.floor(random() * 12); k > 0; k--) text += pieces[Math.floor(random() * pieces.length)];
      // A colour escape inside a value, where it does not land inside another escape.
      const at = Math.floor(random() * text.length);
      // eslint-disable-next-line no-control-regex
      if (random() < 0.3 && !/\x1b[^m\x07]*$/.test(text.slice(0, at))) text = text.slice(0, at) + '\x1b[32m' + text.slice(at);
      const pipe = secrets.stream();
      let out = '';
      for (let i = 0; i < text.length; ) {
        const size = 1 + Math.floor(random() * 6);
        out += pipe.write(text.slice(i, i + size));
        i += size;
      }
      out += pipe.end();
      expect(out, JSON.stringify(text)).toBe(secrets.hide(text));
    }
  });
});
