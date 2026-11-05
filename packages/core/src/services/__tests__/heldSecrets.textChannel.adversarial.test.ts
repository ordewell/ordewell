import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunnerSession, StructuredEvent } from '../../interfaces/IRunner';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';

/**
 * A StructuredRunner's text channel writes each run's text a line at a time,
 * and a run that speaks again after another flushes its open line with no
 * separator. Each write then holds fewer than eight characters of a held
 * value, so hiding each write on its own lets the value through whole once the
 * writes meet in the output (ADR-0061, H1, C1).
 *
 * Fake values, no rule's shape.
 */
const HELD = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
/** Lines shorter than a part: written a line at a time, no write holds eight characters of it. */
const SHORT_LINES = 'q7Wz\nR2xK\nm9Pt\nV4yL';

// eslint-disable-next-line no-control-regex
const visible = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b/g, '');
const shows = (value: string, text: string) =>
  Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8)).some((piece) => text.includes(piece) || visible(text).includes(piece));

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

interface Heard {
  session: IRunnerSession;
  adapter: StreamingAdapter;
  /** What the session said, in order: each output write, and each event by its type. */
  said: string[];
  output: () => string;
  turnEnded: () => Promise<void>;
}

async function spawn(held: string): Promise<Heard> {
  const server = new OrdewellMcpServer();
  // Sealed runs cannot open a socket: the listener alone is stubbed, as HeldSecrets.test.ts does.
  vi.spyOn(server as unknown as { start: () => Promise<string> }, 'start').mockResolvedValue('http://127.0.0.1:9/mcp');
  const adapters: StreamingAdapter[] = [];
  const runner = new StructuredRunner({ mcp: server, interruptGraceMs: 10, createAdapter: () => { const a = new StreamingAdapter(); adapters.push(a); return a; } });
  runners.push(runner);
  const session = await runner.spawn({
    taskId: 'task-held', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry(), env: { MISTRAL_API_KEY: held },
  });
  const said: string[] = [];
  const written: string[] = [];
  const events: StructuredEvent[] = [];
  session.onOutput((text) => { written.push(text); said.push(`output:${text}`); });
  session.onEvent((event) => { events.push(event); said.push(event.type); });
  session.onExit(() => said.push('exit'));
  const adapter = adapters[adapters.length - 1];
  await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
  return {
    session, adapter, said,
    output: () => written.join(''),
    turnEnded: () => vi.waitFor(() => expect(events.some((event) => event.type === 'turn_end')).toBe(true)),
  };
}

describe('a StructuredRunner text channel whose writes split a held value', () => {
  it('hides a value two runs write in turn, each with fewer than eight of its characters', async () => {
    const { session, adapter, output, turnEnded } = await spawn(HELD);
    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'intro\n' },
      { type: 'assistant_text_delta', runId: 'r2', text: 'other\n' },
      // r1's open line is flushed when r2 speaks again, and r2 is already in the turn, so no separator.
      { type: 'assistant_text_delta', runId: 'r1', text: `x ${HELD.slice(0, 6)}` },
      { type: 'assistant_text_delta', runId: 'r2', text: `${HELD.slice(6, 12)} done\n` },
    );
    adapter.end();
    await turnEnded();
    expect({ heard: shows(HELD, output()), kept: shows(HELD, session.getOutput()) }).toEqual({ heard: false, kept: false });
    expect(session.getOutput()).toContain(' done');
  });

  it('hides a value whose lines are shorter than a part, written a line at a time', async () => {
    const { session, adapter, output, turnEnded } = await spawn(SHORT_LINES);
    // One line a delta, as a model streams a short-lined value: each line is written as it completes.
    adapter.emit(...['key:\n', ...SHORT_LINES.split('\n').map((line) => `${line}\n`), 'end\n']
      .map((text): AgentEvent => ({ type: 'assistant_text_delta', runId: 'r1', text })));
    adapter.end();
    await turnEnded();
    expect({ heard: shows(SHORT_LINES, output()), kept: shows(SHORT_LINES, session.getOutput()) }).toEqual({ heard: false, kept: false });
    expect(session.getOutput()).toMatch(/key:\n.*REDACTED.*\nend\n$/s);
  });

  it('writes what it held back before the turn is said to end', async () => {
    const { session, adapter, said, turnEnded } = await spawn(HELD);
    // A run's copy is written without a line end, and it ends on the start of the value.
    adapter.emit({ type: 'assistant_text', runId: 'r1', text: `ends on ${HELD.slice(0, 5)}` });
    adapter.end();
    await turnEnded();
    expect(session.getOutput()).toBe(`ends on ${HELD.slice(0, 5)}\n`);
    const lastOutput = said.map((entry) => entry.startsWith('output:')).lastIndexOf(true);
    expect(lastOutput).toBeLessThan(said.indexOf('turn_end'));
  });

  it('writes what it held back before a killed session exits', async () => {
    const { session, adapter, said } = await spawn(HELD);
    adapter.emit({ type: 'assistant_text', runId: 'r1', text: `ends on ${HELD.slice(0, 5)}` });
    session.kill();
    expect(session.getOutput()).toBe(`ends on ${HELD.slice(0, 5)}`);
    const lastOutput = said.map((entry) => entry.startsWith('output:')).lastIndexOf(true);
    expect(lastOutput).toBeLessThan(said.indexOf('exit'));
  });

  it('control: a value one write holds whole is hidden', async () => {
    const { session, adapter, turnEnded } = await spawn(HELD);
    adapter.emit({ type: 'assistant_text_delta', runId: 'r1', text: `key ${HELD} done\n` });
    adapter.end();
    await turnEnded();
    expect(shows(HELD, session.getOutput())).toBe(false);
    expect(session.getOutput()).toBe('key [REDACTED secret: 36 chars] done\n');
  });
});
