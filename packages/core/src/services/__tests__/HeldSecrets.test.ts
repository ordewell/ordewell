import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeldSecrets } from '../HeldSecrets';
import { StructuredRunner } from '../StructuredRunner';
import type { StructuredEvent } from '../../interfaces/IRunner';
import { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { coalesceTaskLog, toTaskLogEvent, type TaskLogEvent } from '../../models/TaskLog';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';

/** Fake, and no rule's shape: only the held record can recognise it. */
const HELD = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

describe('HeldSecrets', () => {
  it('hides a held value whole, and any part of it of eight characters or more', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const text = `whole ${HELD}, sliced ${HELD.slice(0, 12)}, middle ${HELD.slice(9, 19)}, short ${HELD.slice(0, 7)}`;
    const shown = secrets.hide(text);
    expect(shows(shown, HELD)).toBe(false);
    // Seven characters are below the part the bar holds to, and are left as they are.
    expect(shown).toContain(`short ${HELD.slice(0, 7)}`);
  });

  it('shows a pipe’s text at once where it can start no part, and holds back only what can', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const pipe = secrets.stream();
    // A script that prints a line and waits must not have the line kept from its reader.
    expect(pipe.write('started\n')).toBe('started\n');
    expect(pipe.write(`key ${HELD.slice(0, 5)}`)).toBe('key ');
    expect(pipe.write(`${HELD.slice(5)} done\n`)).toBe('[REDACTED secret: 36 chars] done\n');
    expect(pipe.end()).toBe('');
  });

  it('holds the credentials of a spawn env and not its other variables', () => {
    const secrets = new HeldSecrets();
    secrets.holdEnv({ MISTRAL_API_KEY: HELD, NODE_ENV: 'production-build-env' });
    expect(secrets.hide(`${HELD} production-build-env`)).toBe('[REDACTED secret: 36 chars] production-build-env');
  });

  it('hides what it holds in every string of a value, keys and nested values alike', () => {
    const secrets = new HeldSecrets();
    secrets.hold(HELD);
    const shown = secrets.hideIn({ summary: `ok ${HELD}`, findings: [{ title: HELD }], [HELD]: 1, count: 2 });
    expect(shows(JSON.stringify(shown), HELD)).toBe(false);
    expect(shown.count).toBe(2);
  });

  it('never hides a value too short to tell from a word', () => {
    const secrets = new HeldSecrets();
    secrets.hold('dev', 'true');
    expect(secrets.hide('a dev build, true')).toBe('a dev build, true');
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

/** A real session on a real MCP server, its HTTP listener alone stubbed, with `env` in its spawn env. */
async function liveSession(env: Record<string, string>) {
  const server = new OrdewellMcpServer();
  vi.spyOn(server as unknown as { start: () => Promise<string> }, 'start').mockResolvedValue('http://127.0.0.1:9/mcp');
  const adapters: StreamingAdapter[] = [];
  const runner = new StructuredRunner({ mcp: server, interruptGraceMs: 10, createAdapter: () => { const a = new StreamingAdapter(); adapters.push(a); return a; } });
  runners.push(runner);
  const session = await runner.spawn({
    taskId: 'task-held', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry(), env,
  });
  const events: StructuredEvent[] = [];
  session.onEvent((event) => events.push(event));
  const adapter = adapters[adapters.length - 1];
  await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
  return { adapter, events };
}

/** `text` in deltas of three to five characters, as a model streams tokens. */
function inDeltas(text: string): string[] {
  const parts: string[] = [];
  for (let at = 0, size = 3; at < text.length; at += size, size = 3 + (size % 3)) parts.push(text.slice(at, at + size));
  return parts;
}

describe('a held value a runner streams in deltas', () => {
  it('is hidden in the events and in the task log they coalesce into, and the text around it is kept', async () => {
    const { adapter, events } = await liveSession({ MISTRAL_API_KEY: HELD });
    const said = `The key I was started with reads ${HELD} and it works.`;
    const thought = `Maybe ${HELD} is the key.`;
    adapter.emit(
      ...inDeltas(thought).map((text): AgentEvent => ({ type: 'thinking_delta', text })),
      ...inDeltas(said).map((text): AgentEvent => ({ type: 'assistant_text_delta', runId: 'r1', text })),
      { type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'true' } },
    );
    adapter.end();
    await vi.waitFor(() => expect(events.some((event) => event.type === 'turn_end')).toBe(true));
    const log = coalesceTaskLog(events.map(toTaskLogEvent).filter((event): event is TaskLogEvent => event !== null));
    expect(shows(JSON.stringify(events), HELD)).toBe(false);
    expect(shows(JSON.stringify(log), HELD)).toBe(false);
    const text = log.flatMap((event) => (event.type === 'text_delta' ? [event.text] : [])).join('');
    const thinking = log.flatMap((event) => (event.type === 'thinking_delta' ? [event.text] : [])).join('');
    expect(text).toBe('The key I was started with reads [REDACTED secret: 36 chars] and it works.');
    expect(thinking).toBe('Maybe [REDACTED secret: 36 chars] is the key.');
    // The text held back is passed on before the event after it.
    const lastDelta = events.map((event) => event.type).lastIndexOf('assistant_text_delta');
    expect(events.findIndex((event) => event.type === 'tool_call')).toBeGreaterThan(lastDelta);
  });
});

/** A runner that never attaches, failing as `fail` says with what it was handed in its words. */
async function failedStart(fail: { start?: string; attach?: string }) {
  const server = new OrdewellMcpServer();
  vi.spyOn(server as unknown as { start: () => Promise<string> }, 'start').mockResolvedValue('http://127.0.0.1:9/mcp');
  class Failing extends StreamingAdapter {
    override async start(): Promise<void> { if (fail.start) throw new Error(fail.start); }
    override async mcpAttached(): Promise<boolean> { if (fail.attach) throw new Error(fail.attach); return true; }
  }
  const runner = new StructuredRunner({ mcp: server, interruptGraceMs: 10, createAdapter: () => new Failing() });
  runners.push(runner);
  const notices: string[] = [];
  const failure = await runner.spawn({
    taskId: 'task-held', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo',
    registry: new RunnerRegistry(), env: { MISTRAL_API_KEY: HELD }, onNotice: (message) => notices.push(message),
  }).then(() => null, (err: unknown) => err);
  return { failure, notices };
}

describe('a held value in why a runner did not start (ADR-0061, H1)', () => {
  // A container's entry, or a runner's own stderr, ends a start with whatever it last said.
  it('is hidden in the start error, its class kept', async () => {
    const { failure } = await failedStart({ start: `The container's entry ended: echo ${HELD}` });
    expect(failure).toBeInstanceOf(Error);
    const err = failure as Error;
    expect(err.message).toBe("The container's entry ended: echo [REDACTED secret: 36 chars]");
    expect(shows(err.stack ?? '', HELD)).toBe(false);
  });

  it('is hidden in the respawn notice and in the error after the respawn', async () => {
    const { failure, notices } = await failedStart({ attach: `config reads ${HELD}` });
    expect(notices).toHaveLength(1);
    expect(shows(notices.join('\n'), HELD)).toBe(false);
    expect(notices[0]).toContain('config reads [REDACTED secret: 36 chars]');
    expect(failure).toBeInstanceOf(Error);
    expect(shows(`${(failure as Error).message}\n${(failure as Error).stack ?? ''}`, HELD)).toBe(false);
    expect((failure as Error).message).toContain('config reads [REDACTED secret: 36 chars]');
  });
});
