import { describe, expect, it } from 'vitest';
import type { IRunnerSession } from '../../interfaces/IRunner';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { storedHandoff } from '../../models/Handoff';
import { fakeSecret } from './fakeSecret';

/**
 * Task #76, round 2: what a task printed, and what its runner handed over, on
 * the planner-facing paths after #81's fix. Every value here is fake.
 *
 * (a) A value Ordewell holds, here the attempt's MCP token, never reaches a sink.
 * (b) In agent text, a value under a credential name, a Bearer token or a PEM
 *     private key is never shown, whatever the cut position.
 */
const OPENAI = fakeSecret('openai');
/** Mixed case and digits, yet an IDENTIFIER: no rule takes it once its name is cut off. */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
/**
 * An attempt's MCP token, `randomBytes(32).toString('base64url')` (OrdewellMcpServer.ts:240):
 * 43 chars. About 43% of them open with a letter and hold no `-`, as this one does.
 */
const MCP_TOKEN = 'Qx7fakeTok3nB64urlAbCdEfGhIjKlMnOpQrStUvW9z';

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

/**
 * One line of output, longer than the buffer, whose last `keep` chars open
 * with `secret`: cutTo (BufferedTaskOutputSource.ts:146-156) finds no newline
 * within its 4,096-char window and cuts the raw text there, before any read
 * redacts it, so the kept text has the value and not its name.
 */
function cutJustBefore(secret: string, before: string, keep: number): string {
  const after = `","HOME":"/home/u","PAD":"${'q'.repeat(keep)}`.slice(0, keep - secret.length);
  return `{"env":{"PATH":"${'p'.repeat(1000)}",${before}${secret}${after}`;
}

describe('bar (b), round 2: the output buffer cuts a long line before redacting it', () => {
  const KEEP = 400;
  for (const [label, read] of [
    ['live tail (task_output, a run update)', (s: BufferedTaskOutputSource) => s.liveTail('t1', { maxLines: 30 })?.text ?? ''],
    ['final text', (s: BufferedTaskOutputSource) => s.finalText('t1')],
  ] as const) {
    it(`keeps a value under a credential name out of the ${label}`, () => {
      const source = new BufferedTaskOutputSource({ maxBufferChars: KEEP });
      const { session, emit } = fakeSession();
      source.attach('t1', session);
      const line = cutJustBefore(ALNUM, '"MISTRAL_API_KEY":"', KEEP);
      // On the output, not on what is read: a read that starts with the value shows it.
      expect(line.slice(-KEEP).startsWith(ALNUM), 'the cut lands on the value').toBe(true);
      emit('output', line);
      const text = read(source);
      expect(shows(text, ALNUM), text.slice(0, 120)).toBe(false);
    });
  }

  it("keeps the attempt's MCP token, cut from its Bearer header, out of the live tail (bar (a))", () => {
    const source = new BufferedTaskOutputSource({ maxBufferChars: KEEP });
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', cutJustBefore(MCP_TOKEN, '"headers":{"Authorization":"Bearer ', KEEP));
    const text = source.liveTail('t1', { maxLines: 30 })?.text ?? '';
    expect(shows(text, MCP_TOKEN), text.slice(0, 120)).toBe(false);
  });

  it('keeps the same value out when the line is whole (control, passes today)', () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', cutJustBefore(ALNUM, '"MISTRAL_API_KEY":"', KEEP));
    const text = source.liveTail('t1', { maxLines: 30 })?.text ?? '';
    expect(shows(text, ALNUM), text.slice(0, 120)).toBe(false);
  });
});

describe('bar (b), round 2: a read from an offset parts a private key from its BEGIN line', () => {
  const BODY = [
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FAKEFAKEFAKE',
    'p9QrS1tU3vW5xY7zA9bC1dE3fG5hI7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7dE9f',
    'q8PrR0sT2uV4wX6yZ8aB0cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4aB6cD8',
    'r7OqQ9rS1tU3vW5xY7zA9bC1dE3fG5hI7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7',
  ];
  const leaked = (out: string) => BODY.some((line) => shows(out, line));

  // plannerTools.ts:311 reads a running task with `since`: readFrom (132-139) goes back
  // only to the start of the line, so BEGIN is in the read before and END not yet written.
  it('keeps the body out of the read that follows BEGIN', () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', `$ cat deploy/id_rsa\n-----BEGIN PRIVATE KEY-----\n${BODY[0]}\n`);
    const first = source.liveTail('t1', { maxLines: 30 });
    expect(leaked(first?.text ?? ''), first?.text).toBe(false);
    emit('output', `${BODY[1]}\n${BODY[2]}\n${BODY[3]}\n`);
    const next = source.liveTail('t1', { maxLines: 30, sinceOffset: first?.nextOffset })?.text ?? '';
    expect(leaked(next), next).toBe(false);
  });

  it('keeps the body out of a read of the whole output (control, passes today)', () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', `$ cat deploy/id_rsa\n-----BEGIN PRIVATE KEY-----\n${BODY.join('\n')}\n`);
    const text = source.liveTail('t1', { maxLines: 30 })?.text ?? '';
    expect(leaked(text), text).toBe(false);
  });
});

describe("bar (b), round 2: a done handoff's commit message", () => {
  // storedHandoff redacts the summary, findings and report, but keeps the commit as
  // the runner wrote it (Handoff.ts:235). It goes to the plan's digest (288), the
  // planner's prompt (conversation/labels.ts:100), the task row (taskRow/view.ts:349)
  // and the landed commit's message (landingMessage.ts:39).
  it('keeps a provider key out of the commit body', () => {
    const stored = storedHandoff({
      status: 'done', summary: 'Rotated the deploy key.',
      commit: { subject: 'Rotate the deploy key', body: `The old one was OPENAI_API_KEY=${OPENAI}.` },
    });
    expect(shows(JSON.stringify(stored?.commit), OPENAI), JSON.stringify(stored?.commit)).toBe(false);
  });

  it('keeps a provider key out of the commit subject', () => {
    const stored = storedHandoff({ status: 'done', summary: 'Done.', commit: { subject: `Use ${OPENAI} for the smoke test` } });
    expect(shows(stored?.commit?.subject ?? '', OPENAI), stored?.commit?.subject).toBe(false);
  });

  it('keeps the same key out of the summary (control, passes today)', () => {
    const stored = storedHandoff({ status: 'done', summary: `The old one was OPENAI_API_KEY=${OPENAI}.` });
    expect(shows(stored?.summary ?? '', OPENAI), stored?.summary).toBe(false);
  });
});

describe("bar (a), round 2: the attempt's MCP token under its own variable, in output sinks with no held set", () => {
  // A Codex attempt's token rides ORDEWELL_MCP_TOKEN_0 (codexOrdewell.ts:46, runnerEnv.ts:20), a
  // variable every harness hands on to what it runs. credentialNamed (redactSecrets.ts:321)
  // refuses a name with a `_0` after TOKEN, and NAMED_CREDENTIAL's IDENTIFIER bypass keeps the value.
  const dump = `{"PATH":"/usr/bin","ORDEWELL_MCP_TOKEN_0":"${MCP_TOKEN}","HOME":"/home/u"}`;

  it("keeps it out of a task's live tail", () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', `$ node -p 'JSON.stringify(process.env)'\n${dump}\n`);
    const text = source.liveTail('t1', { maxLines: 30 })?.text ?? '';
    expect(shows(text, MCP_TOKEN), text).toBe(false);
  });

  it("keeps it out of a handoff's report", () => {
    const stored = storedHandoff({ status: 'failed', summary: 'Could not reach the server.', report: `The env was:\n${dump}` });
    expect(shows(stored?.report ?? '', MCP_TOKEN), stored?.report).toBe(false);
  });

  it('keeps it out on a line of its own (control, passes today)', () => {
    const stored = storedHandoff({ status: 'failed', summary: `ORDEWELL_MCP_TOKEN_0=${MCP_TOKEN}` });
    expect(shows(stored?.summary ?? '', MCP_TOKEN), stored?.summary).toBe(false);
  });
});
