import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRunnerSession } from '../../interfaces/IRunner';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { StructuredRunner } from '../StructuredRunner';
import { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';

/**
 * Task #76, round 3: the planner-facing output paths after #81's fix. Every
 * value here is fake.
 *
 * (a) A value Ordewell itself holds (the attempt's MCP token, a provider key
 *     it put in the spawn env) never reaches any sink, in whole or in part.
 * (b) A PEM private key is never shown, whatever the cut position.
 */
/** No prefix, no name: only Ordewell's own record of what it issued can recognise it. */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';

const shows = (text: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => text.includes(piece));

/** A session whose callbacks the test drives. */
function fakeSession() {
  const on: Record<string, Array<(value: unknown) => void>> = {};
  const add = (name: string) => (cb: (value: never) => void) => { (on[name] ??= []).push(cb as (value: unknown) => void); };
  const session = {
    onOutput: add('output'), onExit: add('exit'), onEvent: add('event'),
    onTaskComplete: add('complete'), onScriptExit: add('script'),
  } as unknown as IRunnerSession;
  const emit = (name: string, value: unknown) => { for (const cb of on[name] ?? []) cb(value); };
  return { session, emit };
}

// ---------------------------------------------------------------------------
// Bar (a): the held set never reaches the output source.
// ---------------------------------------------------------------------------

class EchoAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId: string = 'codex';
  readonly exited = false;
  readonly sent: string[] = [];
  started: AgentStartOptions | null = null;
  private turn: { onEvent: (event: AgentEvent) => void; resolve: () => void } | null = null;
  async start(opts: AgentStartOptions): Promise<void> { this.started = opts; }
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  emit(...events: AgentEvent[]): void { for (const event of events) this.turn?.onEvent(event); }
  async interrupt(): Promise<boolean> { return false; }
  onOutOfTurn(_listener: (event: AgentEvent) => void): void {}
  onProcessExit(_listener: (code: number) => void): void {}
  answerPermission(_id: string, _decision: never): boolean { return false; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); vi.restoreAllMocks(); });

/**
 * A real StructuredSession on a real OrdewellMcpServer, whose HTTP listener
 * alone is stubbed (a sealed run cannot bind 127.0.0.1): the token it issues
 * is the one a live run's adapter is handed.
 */
async function liveSession(env: Record<string, string> = {}) {
  const server = new OrdewellMcpServer();
  vi.spyOn(server as unknown as { start: () => Promise<string> }, 'start').mockResolvedValue('http://127.0.0.1:9/mcp');
  const adapters: EchoAdapter[] = [];
  const runner = new StructuredRunner({ mcp: server, interruptGraceMs: 10, createAdapter: () => { const a = new EchoAdapter(); adapters.push(a); return a; } });
  runners.push(runner);
  const session = await runner.spawn({
    taskId: 'task-0076-held', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry: new RunnerRegistry(), env,
  });
  const adapter = adapters[adapters.length - 1];
  await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
  const source = new BufferedTaskOutputSource();
  source.attach('task-0076-held', session);
  const header = (adapter.started as { mcp?: { headers: Record<string, string> } } | null)?.mcp?.headers.Authorization ?? '';
  const token = header.replace(/^Bearer /, '');
  /** The runner's `task_complete`, through the handler the server keeps for its token, as an HTTP call reaches it. */
  const complete = (args: { status: 'done'; summary: string; report?: string; findings?: Array<{ severity: 'info'; title: string; detail?: string }> }) =>
    (server as unknown as { grants: Map<string, { handler: { taskComplete: (a: unknown) => Promise<unknown> } }> }).grants.get(token)!.handler.taskComplete(args);
  return { source, adapter, token, session, complete };
}

describe('bar (a), round 3: what Ordewell holds is not handed to the output source', () => {
  it('keeps the attempt’s own MCP token out of the live tail and final text when the runner echoes it bare', async () => {
    const { source, adapter, token } = await liveSession();
    // Precondition: the token is the server's, issued for this attempt.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The runner read its own MCP config back and quoted the header's value, no name beside it.
    adapter.emit({ type: 'assistant_text', runId: 'r1', text: `The header my config carries is:\n${token}\nso the server is reachable.` });
    await vi.waitFor(() => expect(source.liveTail('task-0076-held', { maxLines: 20 })?.text ?? '').toContain('server is reachable'));
    expect(shows(source.liveTail('task-0076-held', { maxLines: 20 })?.text ?? '', token)).toBe(false);
    expect(shows(source.finalText('task-0076-held'), token)).toBe(false);
  });

  it('keeps the attempt’s MCP token out of a tool call line the channel writes', async () => {
    const { source, adapter, token } = await liveSession();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    adapter.emit({ type: 'tool_call', runId: 'r1', id: 'c1', name: 'shell', args: { command: `echo ${token} | wc -c` } } as AgentEvent);
    adapter.emit({ type: 'assistant_text', runId: 'r1', text: 'Counted it.' });
    await vi.waitFor(() => expect(source.liveTail('task-0076-held', { maxLines: 20 })?.text ?? '').toContain('Counted it.'));
    expect(shows(source.liveTail('task-0076-held', { maxLines: 20 })?.text ?? '', token)).toBe(false);
    expect(shows(source.finalText('task-0076-held'), token)).toBe(false);
  });

  it('keeps the attempt’s MCP token out of the report and handoff its task_complete hands over', async () => {
    const { source, token, complete } = await liveSession();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await complete({
      status: 'done',
      summary: `Checked the MCP header: ${token} works.`,
      report: `Header value read back:\n${token}`,
      findings: [{ severity: 'info', title: 'Header value', detail: token }],
    });
    await vi.waitFor(() => expect(source.report('task-0076-held')).toBeDefined());
    expect(shows(source.report('task-0076-held') ?? '', token)).toBe(false);
    expect(shows(JSON.stringify(source.handoff('task-0076-held')), token)).toBe(false);
  });

  it('keeps a provider key Ordewell put in the spawn env out of the live tail when the runner echoes it bare', async () => {
    const { source, adapter } = await liveSession({ MISTRAL_API_KEY: ALNUM });
    adapter.emit({ type: 'assistant_text', runId: 'r1', text: `I checked the key I was started with; it reads\n${ALNUM}\nand it works.` });
    await vi.waitFor(() => expect(source.liveTail('task-0076-held', { maxLines: 20 })?.text ?? '').toContain('and it works.'));
    expect(shows(source.liveTail('task-0076-held', { maxLines: 20 })?.text ?? '', ALNUM)).toBe(false);
    expect(shows(source.finalText('task-0076-held'), ALNUM)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bar (b): the whole-line cut drops a key's BEGIN line, and with it the only
// mark its body had.
// ---------------------------------------------------------------------------

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
/** Fake base64 body lines, 64 chars each, as a PEM key's are. */
const BODY = [
  'MIIEowIBAAKCAQEAfakeKeyBodyLineOneAbCdEfGhIjKlMnOpQrStUvWxYz0123',
  'fakeKeyBodyLineTwoAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGh',
  'fakeKeyBodyLineThreeAbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEf',
];
const bodyShown = (text: string) => BODY.some((line) => shows(text, line));
/** `head -n 4 id_rsa`: the key cut short of its END, then the run went on. */
const HEAD_OF_KEY = `${[BEGIN, ...BODY].join('\n')}\n`;

describe('bar (b), round 3: the buffer’s whole-line cut can drop exactly a truncated key’s BEGIN line', () => {
  it('control: with its BEGIN line kept, the truncated key’s body is redacted', () => {
    const source = new BufferedTaskOutputSource({ maxBufferChars: 10_000 });
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', `${HEAD_OF_KEY}next step\n`);
    expect(bodyShown(source.liveTail('t1', { maxLines: 30 })?.text ?? '')).toBe(false);
  });

  it('keeps the body out of the live tail when the live buffer’s cut drops only the BEGIN line', () => {
    const text = `${HEAD_OF_KEY}next step\n`;
    // The excess falls inside the first line: cutTo (BufferedTaskOutputSource.ts:188) drops that line whole, and no more.
    const source = new BufferedTaskOutputSource({ maxBufferChars: text.length - 5 });
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', text);
    const tail = source.liveTail('t1', { maxLines: 30 })?.text ?? '';
    expect(tail).not.toContain('BEGIN');
    expect(bodyShown(tail)).toBe(false);
    expect(bodyShown(source.finalText('t1'))).toBe(false);
  });

  it('keeps the body out of an ended attempt’s tail when detach’s 16k cut drops only the BEGIN line', () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', HEAD_OF_KEY);
    let after = '';
    while (HEAD_OF_KEY.length + after.length < 16 * 1024 + 5) after += `${'build step output '.repeat(4)}\n`;
    emit('output', after);
    source.detach('t1');
    expect(bodyShown(source.liveTail('t1', { maxLines: 1000 })?.text ?? '')).toBe(false);
    expect(bodyShown(source.finalText('t1'))).toBe(false);
  });
});
