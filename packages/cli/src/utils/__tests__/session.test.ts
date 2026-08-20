import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { saveLastSession, readLastSession } from '../session';

let workspace: string;
let otherWorkspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), 'ordewell-session-ws-'));
  otherWorkspace = mkdtempSync(path.join(os.tmpdir(), 'ordewell-session-other-ws-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(otherWorkspace, { recursive: true, force: true });
});

describe('saveLastSession', () => {
  it('saves session data under the workspace\'s own .ordewell dir', () => {
    saveLastSession('test-s1', 'test goal', ['claude-code'], workspace);
    const file = path.join(workspace, '.ordewell', 'last-session.json');
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.sessionId).toBe('test-s1');
    expect(data.goal).toBe('test goal');
    expect(data.runners).toEqual(['claude-code']);
    expect(data.workspace).toBe(workspace);
  });
});

describe('readLastSession', () => {
  it('returns null when no session saved for that workspace', () => {
    expect(readLastSession(workspace)).toBeNull();
  });

  it('returns the saved session for that workspace', () => {
    saveLastSession('test-s2', 'goal2', ['opencode'], workspace);
    const result = readLastSession(workspace);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('test-s2');
  });

  it('never returns another workspace\'s last session', () => {
    saveLastSession('test-s3', 'goal3', ['opencode'], workspace);
    expect(readLastSession(otherWorkspace)).toBeNull();
  });
});
