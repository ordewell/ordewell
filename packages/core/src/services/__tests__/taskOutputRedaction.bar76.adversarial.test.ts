import { describe, expect, it } from 'vitest';
import type { IRunnerSession, ScriptExit } from '../../interfaces/IRunner';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { taskReport } from '../taskReport';
import { taskReadPage } from '../taskReadPage';
import { fitTail } from '../TaskQuery';
import { scriptHandoff } from '../../models/DerivedHandoff';
import { storedHandoff } from '../../models/Handoff';
import { fakeSecret } from './fakeSecret';

/**
 * Task #76: what a task printed, and what its runner handed over, reaches the
 * planner's prompt and the plan on disk as runner text. Bar (b): a known
 * provider prefix, or a value under a credential name, is never shown there.
 * Nothing on these paths redacts today; only taskReadPage does, and in source
 * mode. Every value here is fake.
 */
const OPENAI = fakeSecret('openai');
const GITHUB = fakeSecret('github');
const LOWER = 'qwertyuiopasdfghjklzxcvbnmfake';

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

describe('bar (b): task output on the planner-facing paths', () => {
  const printed = `npm run deploy\n> export OPENAI_API_KEY=${OPENAI}\n> GITHUB_TOKEN=${GITHUB} git push\n`;

  it("keeps a provider key out of a running task's live tail (task_output, a run update)", () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', printed);
    const tail = source.liveTail('t1', { maxLines: 30 })?.text ?? '';
    expect(shows(tail, OPENAI), tail).toBe(false);
    expect(shows(tail, GITHUB), tail).toBe(false);
  });

  it("keeps a provider key out of a task's final text", () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', printed);
    emit('exit', 0);
    const text = source.finalText('t1');
    expect(shows(text, OPENAI), text).toBe(false);
  });

  it('keeps a provider key out of the report a planner turn is told (taskReport)', () => {
    const text = taskReport({ status: 'completed' } as Parameters<typeof taskReport>[0], printed);
    expect(shows(text, OPENAI), text).toBe(false);
    expect(shows(text, GITHUB), text).toBe(false);
  });

  it('keeps a value under a credential name out of taskReport, when the tail is cut inside its line', () => {
    // fitTail falls back to the last 2,000 chars of a single line (TaskQuery.ts:296): a cut that keeps the value and drops its name.
    const line = `MISTRAL_API_KEY=${LOWER} ${'z'.repeat(2000 - LOWER.length - 1)}`;
    expect(fitTail(line, 2000).text.startsWith(LOWER)).toBe(true);
    const text = taskReport({ status: 'completed' } as Parameters<typeof taskReport>[0], line);
    expect(shows(text, LOWER), text.slice(0, 200)).toBe(false);
  });
});

describe("bar (b): a task's handoff", () => {
  it("keeps a provider key out of a script task's derived handoff (scriptHandoff)", () => {
    const exit = { outcome: 'failed', status: { code: 1 }, errorTail: '' } as unknown as ScriptExit;
    const handoff = scriptHandoff(exit, 1000, `pushing\nfatal: GITHUB_TOKEN=${GITHUB} rejected\n`);
    expect(shows(handoff?.summary ?? '', GITHUB), handoff?.summary).toBe(false);
    expect(shows(handoff?.report ?? '', GITHUB), handoff?.report).toBe(false);
  });

  it('keeps a provider key out of a script handoff read through the output source', () => {
    const source = new BufferedTaskOutputSource();
    const { session, emit } = fakeSession();
    source.attach('t1', session);
    emit('output', `export OPENAI_API_KEY=${OPENAI}\n`);
    emit('script', { outcome: 'failed', status: { code: 1 }, errorTail: '' });
    const handoff = source.handoff('t1');
    expect(shows(`${handoff?.summary}\n${handoff?.report}`, OPENAI), handoff?.summary).toBe(false);
  });

  it("keeps a provider key out of a runner's task_complete handoff (storedHandoff)", () => {
    const handoff = storedHandoff({
      status: 'done',
      summary: `Set GITHUB_TOKEN=${GITHUB} in CI.`,
      report: `The runner printed OPENAI_API_KEY=${OPENAI}.`,
      findings: [{ severity: 'info', title: `token ${GITHUB}`, detail: `key ${OPENAI}` }],
    } as Parameters<typeof storedHandoff>[0]);
    const all = JSON.stringify(handoff);
    expect(shows(all, GITHUB), all).toBe(false);
    expect(shows(all, OPENAI), all).toBe(false);
  });
});

describe('bar (b): a saved log read back (taskReadPage, source mode)', () => {
  it('keeps a colon-assigned value under a credential name out of the page', () => {
    const page = taskReadPage(`[stderr] ANTHROPIC_AUTH_TOKEN: ${LOWER}\n`, {});
    expect(shows(page.output, LOWER), page.output).toBe(false);
  });

  it('keeps a provider key out of the page (control, passes today)', () => {
    const page = taskReadPage(`export OPENAI_API_KEY=${OPENAI}\n`, {});
    expect(shows(page.output, OPENAI), page.output).toBe(false);
  });
});
