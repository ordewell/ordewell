import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claimFirstRunFeedback, type FirstRunFeedbackOptions } from '../FirstRunFeedback';
import type { ExecutionSummary } from '../SessionMessage';

const T0 = Date.parse('2026-11-21T09:00:00Z');

const passed: ExecutionSummary = { total: 3, completed: 3, failed: 0, blocked: 0, skipped: 0 };

describe('the first-run feedback notice', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-first-run-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const claim = (summary: ExecutionSummary, overrides: Partial<FirstRunFeedbackOptions> = {}): boolean =>
    claimFirstRunFeedback(summary, { interactive: true, env: {}, stateDir, now: () => T0, ...overrides });

  it('is shown after the first plan that ends with every task passed', () => {
    expect(claim(passed)).toBe(true);
  });

  it.each<[string, ExecutionSummary]>([
    ['a task failed', { total: 3, completed: 2, failed: 1, blocked: 0, skipped: 0 }],
    ['a failure blocked the rest', { total: 3, completed: 1, failed: 1, blocked: 1, skipped: 0 }],
    ['a task was skipped', { total: 3, completed: 2, failed: 0, blocked: 0, skipped: 1 }],
    ['the plan had no task', { total: 0, completed: 0, failed: 0, blocked: 0, skipped: 0 }],
  ])('is not shown when %s, and is still owed to the first plan that passes', (_, summary) => {
    expect(claim(summary)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(claim(passed)).toBe(true);
  });

  it.each<[string, Partial<FirstRunFeedbackOptions>]>([
    ['the surface has no person at it (no TTY, piped output, a headless command)', { interactive: false }],
    ['CI says so', { env: { CI: 'true' } }],
    ['CI says so in its own words', { env: { CI: 'woodpecker' } }],
  ])('is not shown, and nothing is recorded, when %s', (_, overrides) => {
    expect(claim(passed, overrides)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it.each(['1', 'true', 'yes', 'TRUE'])('is off, recording nothing, when ORDEWELL_NO_FEEDBACK_NOTICE=%s', (value) => {
    expect(claim(passed, { env: { ORDEWELL_NO_FEEDBACK_NOTICE: value } })).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it('stays on for an off switch set to anything else', () => {
    expect(claim(passed, { env: { ORDEWELL_NO_FEEDBACK_NOTICE: '0' } })).toBe(true);
  });

  it('is shown where CI is set to say it is not CI', () => {
    expect(claim(passed, { env: { CI: 'false' } })).toBe(true);
  });

  it('is never shown twice on a machine: the record is a file every surface and every later start reads', () => {
    expect(claim(passed)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'first-run-feedback.json'), 'utf8'))).toEqual({ shownAt: '2026-11-21T09:00:00.000Z' });
    // Another surface's process, or the next start: nothing but the directory is shared.
    expect(claim(passed, { now: () => T0 + 1000 })).toBe(false);
    expect(claim(passed)).toBe(false);
  });

  it('counts any file at the record as shown, so an unreadable one never shows it again', () => {
    fs.writeFileSync(path.join(stateDir, 'first-run-feedback.json'), 'not json');
    expect(claim(passed)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('is not shown when the record cannot be written, since it would then show at every passed run', () => {
    // POSIX file modes; Windows has no read-only directory to stand in for a home that refuses writes.
    const readOnly = path.join(stateDir, 'read-only');
    fs.mkdirSync(readOnly, { mode: 0o500 });
    try {
      expect(claim(passed, { stateDir: readOnly })).toBe(false);
    } finally {
      fs.chmodSync(readOnly, 0o700);
    }
  });
});
