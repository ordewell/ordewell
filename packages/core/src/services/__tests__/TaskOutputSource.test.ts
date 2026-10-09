import { describe, it, expect } from 'vitest';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { FakeStructuredSession, FakeTerminalSession } from '../../testing';

describe('BufferedTaskOutputSource', () => {
  describe('finalText', () => {
    it('is the summary the runner reported through task_complete (ADR-0022, V4)', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeStructuredSession('s1', 'ta');
      source.attach('ta', session);
      session.emitOutput('the screen\n');

      session.reportComplete({ status: 'done', summary: '  Renamed the module.  ' });

      expect(source.finalText('ta')).toBe('Renamed the module.');
    });

    it('reads a retried task\'s summary from its new session only', () => {
      const source = new BufferedTaskOutputSource();
      const first = new FakeStructuredSession('s1', 'ta');
      source.attach('ta', first);
      first.reportComplete({ status: 'failed', summary: 'first try', reason: 'no' });
      const second = new FakeStructuredSession('s2', 'ta');
      source.attach('ta', second);
      second.emitOutput('second screen\n');

      expect(source.finalText('ta')).toBe('second screen');
    });

    it('falls back to what the latest turn said, escapes and control characters removed', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeStructuredSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('first turn\n');
      session.emitEvent({ type: 'turn_start', text: 'go on' });
      session.emitOutput('\x1b[32mtests failed\x1b[0m: 2 of 40  \r\n\n');

      expect(source.finalText('t1')).toBe('tests failed: 2 of 40');
    });

    it('drops a summary reported before a later turn started', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeStructuredSession('s1', 't1');
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

  describe('liveTail', () => {
    it('is null for a task that never had a session', () => {
      const source = new BufferedTaskOutputSource();
      expect(source.liveTail('nope', { maxLines: 10 })).toBeNull();
    });

    it('renders the last maxLines clean, without ANSI', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('\x1b[32mone\x1b[0m\ntwo\nthree\n');

      expect(source.liveTail('t1', { maxLines: 2 })).toEqual({ text: 'two\nthree', nextOffset: 23, running: true });
    });

    it('returns only what followed a previous nextOffset', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('first\n');
      const first = source.liveTail('t1', { maxLines: 50 });
      session.emitOutput('second\nthird\n');

      const next = source.liveTail('t1', { maxLines: 50, sinceOffset: first?.nextOffset });

      expect(first).toMatchObject({ text: 'first', nextOffset: 6 });
      expect(next).toMatchObject({ text: 'second\nthird', nextOffset: 19 });
      expect(source.liveTail('t1', { maxLines: 50, sinceOffset: 19 })?.text).toBe('');
    });

    it('keeps offsets absolute after old output is dropped from the bounded buffer', () => {
      const source = new BufferedTaskOutputSource({ maxBufferChars: 20 });
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      for (let i = 0; i < 10; i++) session.emitOutput(`line-${i}\n`);

      const tail = source.liveTail('t1', { maxLines: 50, sinceOffset: 0 });

      expect(tail?.nextOffset).toBe(70);
      expect(tail?.text).toBe('line-8\nline-9');
    });

    it('stops running on exit and ignores output after detach', () => {
      const source = new BufferedTaskOutputSource();
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('work\n');
      source.detach('t1');
      session.emitOutput('user keeps chatting\n');

      expect(source.liveTail('t1', { maxLines: 5 })).toEqual({ text: 'work', nextOffset: 5, running: false });

      const exited = new FakeTerminalSession('s2', 't2');
      source.attach('t2', exited);
      exited.emitExit(0);
      expect(source.liveTail('t2', { maxLines: 5 })?.running).toBe(false);
    });

    it('reads a retried task from its new session only', () => {
      const source = new BufferedTaskOutputSource();
      const first = new FakeTerminalSession('s1', 't1');
      source.attach('t1', first);
      first.emitOutput('attempt one\n');
      const second = new FakeTerminalSession('s2', 't1');
      source.attach('t1', second);
      second.emitOutput('attempt two\n');
      first.emitOutput('late output from attempt one\n');

      expect(source.liveTail('t1', { maxLines: 5 })?.text).toBe('attempt two');
    });
  });
});
