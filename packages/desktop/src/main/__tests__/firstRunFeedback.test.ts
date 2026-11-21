import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claimForWindow } from '../firstRunFeedback';

const PASSED = { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 };

describe('main\'s side of the first-run feedback notice (ADR-0075)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-desktop-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const claim = (raw: unknown, interactive = true): boolean => claimForWindow(raw, { interactive, env: {}, stateDir });

  it('lets one window show it, once, in the record every surface on the machine reads', () => {
    expect(claim(PASSED)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'first-run-feedback.json'))).toBe(true);
    expect(claim(PASSED)).toBe(false);
  });

  it('shows it in no window of a hidden test run, and records nothing', () => {
    expect(claim(PASSED, false)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['a failed run', { total: 2, completed: 1, failed: 1, blocked: 0, skipped: 0 }],
    ['nothing a run ends with', 'passed'],
    ['counts that are not numbers', { total: '2', completed: '2', failed: 0, blocked: 0, skipped: 0 }],
  ])('refuses %s from a page, recording nothing', (_, raw) => {
    expect(claim(raw)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});
