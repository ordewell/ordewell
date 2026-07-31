import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveLastSession, readLastSession } from '../session';

const SESSION_FILE = path.join(os.homedir(), '.config', 'ordewell', 'last-session.json');

function cleanSessionFile(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch { /* empty */ }
}

beforeEach(cleanSessionFile);
afterEach(cleanSessionFile);

describe('saveLastSession', () => {
  it('saves session data to disk', () => {
    saveLastSession('test-s1', 'test goal', ['claude-code'], '/tmp/ws');
    expect(fs.existsSync(SESSION_FILE)).toBe(true);
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    expect(data.sessionId).toBe('test-s1');
    expect(data.goal).toBe('test goal');
    expect(data.runners).toEqual(['claude-code']);
    expect(data.workspace).toBe('/tmp/ws');
  });
});

describe('readLastSession', () => {
  it('returns null when no session saved', () => {
    expect(readLastSession()).toBeNull();
  });

  it('returns saved session', () => {
    saveLastSession('test-s2', 'goal2', ['opencode'], '/ws');
    const result = readLastSession();
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('test-s2');
  });
});
