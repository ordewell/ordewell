import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { HomeTranscriptReader } from '../transcriptCapture';
import { FakeTerminalSession } from '../../testing';
import type { TaskOutputAttempt, TranscriptReader } from '../../interfaces/TaskOutputSource';
import { stripAnsi } from '../../utils/shell';

const CWD = '/repo/work';
const noTranscripts: TranscriptReader = { finalAssistantText: async () => null };

const attemptOf = (taskId: string, completionMarker: string): TaskOutputAttempt => ({
  taskId,
  runner: 'claude-code',
  cwd: CWD,
  startedAt: new Date(Date.now() - 30_000).toISOString(),
  completionMarker,
});
const tokenOf = (marker: string) => `<<<ORDEWELL_DONE_${marker}>>>`;

/** A runner session whose getOutput() is ANSI-stripped, as HeadlessRunner and TmuxRunner keep it. */
class StrippingSession extends FakeTerminalSession {
  getOutput(): string { return stripAnsi(this.output); }
}

describe('BufferedTaskOutputSource', () => {
  describe('finalText', () => {
    let home: string;
    beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'output-source-')); });
    afterEach(() => { rmSync(home, { recursive: true, force: true }); });

    function claudeTranscript(name: string, marker: string, answer: string): void {
      const dir = path.join(home, '.claude', 'projects', '-repo-work');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${name}.jsonl`),
        [
          JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `followed by \`DONE_${marker}>>>\`` }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }),
        ].join('\n'),
      );
    }

    it('summarizes each of two parallel attempts in one cwd from its own transcript', async () => {
      const source = new BufferedTaskOutputSource({ transcripts: new HomeTranscriptReader({ homeDir: home }) });
      claudeTranscript('a', 'mk-a', 'A: renamed the module');
      claudeTranscript('b', 'mk-b', 'B: added the endpoint');

      expect(await source.finalText(attemptOf('ta', 'mk-a'), tokenOf('mk-a'))).toBe('A: renamed the module');
      expect(await source.finalText(attemptOf('tb', 'mk-b'), tokenOf('mk-b'))).toBe('B: added the endpoint');
    });

    it('falls back to the clean terminal render when no transcript carries the marker', async () => {
      const source = new BufferedTaskOutputSource({ transcripts: new HomeTranscriptReader({ homeDir: home }) });
      claudeTranscript('other', 'mk-other', 'not this task');
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput([
        '\x1b[3;1HDone. 12 files changed.',
        `\x1b[14;1H${tokenOf('mk-1')}`,
        '\x1b[21;1H✻ Cooked for 12m 49s',
      ].join('\r\n'));

      const text = await source.finalText(attemptOf('t1', 'mk-1'), tokenOf('mk-1'));

      expect(text).toBe('Done. 12 files changed.');
    });

    it('renders an exit without a marker from the raw stream, not the stripped session buffer', async () => {
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts });
      const session = new StrippingSession('s1', 't1');
      source.attach('t1', session);
      // A status row repainted in place: the stripped buffer keeps every
      // frame run together, the screen shows only the last one.
      session.emitOutput('\x1b[1;1Hrunning tests…\x1b[1;1H\x1b[2Ktests failed: 2 of 40');
      session.emitExit(1);

      const text = await source.finalText(attemptOf('t1', 'mk-1'), tokenOf('mk-1'));

      expect(session.getOutput()).toBe('running tests…tests failed: 2 of 40');
      expect(text).toBe('tests failed: 2 of 40');
    });
  });

  describe('liveTail', () => {
    it('is null for a task that never had a session', () => {
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts });
      expect(source.liveTail('nope', { maxLines: 10 })).toBeNull();
    });

    it('renders the last maxLines clean, without ANSI', () => {
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts });
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      session.emitOutput('\x1b[32mone\x1b[0m\ntwo\nthree\n');

      expect(source.liveTail('t1', { maxLines: 2 })).toEqual({ text: 'two\nthree', nextOffset: 23, running: true });
    });

    it('returns only what followed a previous nextOffset', () => {
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts });
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
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts, maxBufferChars: 20 });
      const session = new FakeTerminalSession('s1', 't1');
      source.attach('t1', session);
      for (let i = 0; i < 10; i++) session.emitOutput(`line-${i}\n`);

      const tail = source.liveTail('t1', { maxLines: 50, sinceOffset: 0 });

      expect(tail?.nextOffset).toBe(70);
      expect(tail?.text).toBe('line-8\nline-9');
    });

    it('stops running on exit and ignores output after detach', () => {
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts });
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
      const source = new BufferedTaskOutputSource({ transcripts: noTranscripts });
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
