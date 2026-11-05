import { describe, it, expect } from 'vitest';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { FakeRunnerSession } from '../../testing';

describe('BufferedTaskOutputSource', () => {
  describe('finalText', () => {
    it('is the summary the runner reported through task_complete (ADR-0022, V4)', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 'ta');
      source.attach('ta', session);
      session.emitOutput('the screen\n');

      session.reportComplete({ status: 'done', summary: '  Renamed the module.  ' });

      expect(source.finalText('ta')).toBe('Renamed the module.');
    });

    it('reads a retried task\'s summary from its new session only', () => {
      const source = new BufferedTaskOutputSource();
      const first = new FakeRunnerSession('s1', 'ta');
      source.attach('ta', first);
      first.reportComplete({ status: 'failed', summary: 'first try', reason: 'no' });
      const second = new FakeRunnerSession('s2', 'ta');
      source.attach('ta', second);
      second.emitOutput('second screen\n');

      expect(source.finalText('ta')).toBe('second screen');
    });

    it('falls back to what the latest turn said, escapes and control characters removed', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('first turn\n');
      session.emitEvent({ type: 'turn_start', text: 'go on' });
      session.emitOutput('\x1b[32mtests failed\x1b[0m: 2 of 40  \r\n\n');

      expect(source.finalText('t1')).toBe('tests failed: 2 of 40');
    });

    it('keeps the report the runner wrote before Ordewell reminded it to call task_complete', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('Full report: all checks pass.\n');
      session.emitEvent({ type: 'turn_start', text: 'Call task_complete.', from: 'ordewell' });
      session.emitOutput('Understood.\n');

      expect(source.finalText('t1')).toBe('Full report: all checks pass.\nUnderstood.');
    });

    it('drops a summary reported before a later turn started', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.reportComplete({ status: 'blocked', summary: 'needs a key', reason: 'no key' });
      session.emitEvent({ type: 'turn_start', text: 'here is the key' });
      session.emitOutput('working with the key\n');

      expect(source.finalText('t1')).toBe('working with the key');
    });

    it('is empty for a task that never had a session', () => {
      expect(new BufferedTaskOutputSource().finalText('nope')).toBe('');
    });
  });

  describe('report', () => {
    it('is the task_complete summary alone, never the screen', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('working\n');
      expect(source.report('t1')).toBeUndefined();

      session.reportComplete({ status: 'done', summary: ' Three findings: a, b, c. ' });

      expect(source.report('t1')).toBe('Three findings: a, b, c.');
    });

    it('is dropped when a message read mid-turn supersedes the call (ADR-0023)', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.reportComplete({ status: 'done', summary: 'done early' });
      session.emitEvent({ type: 'message_delivered', messageId: 'm1', text: 'also do X' });

      expect(source.report('t1')).toBeUndefined();
    });
  });

  describe('liveTail', () => {
    it('is null for a task that never had a session', () => {
      const source = new BufferedTaskOutputSource();
      expect(source.liveTail('nope', { maxLines: 10 })).toBeNull();
    });

    it('renders the last maxLines clean, without ANSI', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('\x1b[32mone\x1b[0m\ntwo\nthree\n');

      expect(source.liveTail('t1', { maxLines: 2 })).toEqual({ text: 'two\nthree', nextOffset: 23, running: true });
    });

    it('returns only what followed a previous nextOffset', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('first\n');
      const first = source.liveTail('t1', { maxLines: 50 });
      session.emitOutput('second\nthird\n');

      const next = source.liveTail('t1', { maxLines: 50, sinceOffset: first?.nextOffset });

      expect(first).toMatchObject({ text: 'first', nextOffset: 6 });
      expect(next).toMatchObject({ text: 'second\nthird', nextOffset: 19 });
      expect(source.liveTail('t1', { maxLines: 50, sinceOffset: 19 })?.text).toBe('');
    });

    it('redacts a value whose name came in the chunk a previous read ended at, and shows only the rest of a plain line', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('log: hel');
      const first = source.liveTail('t1', { maxLines: 50 });
      session.emitOutput('lo\nMISTRAL_API_KEY=');
      const second = source.liveTail('t1', { maxLines: 50, sinceOffset: first?.nextOffset });
      session.emitOutput('qwertyuiopasdfghjklzxcvbnmfake\n');
      const third = source.liveTail('t1', { maxLines: 50, sinceOffset: second?.nextOffset });

      expect(second?.text).toBe('lo\nMISTRAL_API_KEY=');
      expect(third?.text).toBe('[REDACTED credential: 30 chars]');
    });

    it('keeps offsets absolute after old output is dropped from the bounded buffer', () => {
      const source = new BufferedTaskOutputSource({ maxBufferChars: 20 });
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      for (let i = 0; i < 10; i++) session.emitOutput(`line-${i}\n`);

      const tail = source.liveTail('t1', { maxLines: 50, sinceOffset: 0 });

      expect(tail?.nextOffset).toBe(70);
      expect(tail?.text).toBe('line-8\nline-9');
    });

    it('stops running on exit and ignores output after detach', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('work\n');
      source.detach('t1');
      session.emitOutput('user keeps chatting\n');

      expect(source.liveTail('t1', { maxLines: 5 })).toEqual({ text: 'work', nextOffset: 5, running: false });

      const exited = new FakeRunnerSession('s2', 't2');
      source.attach('t2', exited);
      exited.emitExit(0);
      expect(source.liveTail('t2', { maxLines: 5 })?.running).toBe(false);
    });

    it('keeps only the end of what an ended attempt printed, so a long plan does not keep every buffer', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      const printed = Array.from({ length: 5000 }, (_, i) => `line-${i}\n`).join('');
      session.emitOutput(printed);
      expect(source.finalText('t1')).toContain('line-0\n');

      source.detach('t1');

      const tail = source.liveTail('t1', { maxLines: 100_000 });
      expect(tail?.nextOffset).toBe(printed.length);
      expect(tail?.running).toBe(false);
      expect(tail?.text.length).toBeLessThanOrEqual(16 * 1024);
      expect(tail?.text.startsWith('line-')).toBe(true);
      expect(tail?.text.endsWith('line-4999')).toBe(true);
    });

    it('keeps the completion of an ended attempt whole, however long its output', () => {
      const source = new BufferedTaskOutputSource({ maxBufferChars: 1024 * 1024 });
      const session = new FakeRunnerSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('x\n'.repeat(100_000));
      session.reportComplete({ status: 'done', summary: 'Renamed the module.' });

      source.detach('t1');

      expect(source.finalText('t1')).toBe('Renamed the module.');
      expect(source.handoff('t1')?.summary).toBe('Renamed the module.');
    });

    it('reads a retried task from its new session only', () => {
      const source = new BufferedTaskOutputSource();
      const first = new FakeRunnerSession('s1', 't1');
      source.attach('t1', first);
      first.emitOutput('attempt one\n');
      const second = new FakeRunnerSession('s2', 't1');
      source.attach('t1', second);
      second.emitOutput('attempt two\n');
      first.emitOutput('late output from attempt one\n');

      expect(source.liveTail('t1', { maxLines: 5 })?.text).toBe('attempt two');
    });
  });
});
