import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import { appendUserAction, takeUserActions } from '../../utils/userActionLog';
import { makeSession } from './sessionTestKit';

/**
 * A person's git action on a live run's landing branch reaches that session's
 * timeline (ADR-0062 G6): straight from the holder, or through the file a host
 * that does not hold the session leaves for the holder to fold.
 */

const GOAL = 'build me a parser';
const SESSION = 'session-user-actions';

function plan(): LegacyPlanState {
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [{ role: 'user', content: GOAL, timestamp: '2026-01-01T00:00:00Z' }],
  };
}

describe('user git actions in the timeline', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-user-actions-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const saved = () => sessionStore.loadSession(SESSION, workspace)!.plan;

  function open() {
    sessionStore.saveSession(plan(), GOAL, workspace, SESSION);
    const session = makeSession({ saveSession: sessionStore.saveSession, workspaceRoot: () => workspace });
    session.loadPlan(saved(), GOAL, workspace, { sessionId: SESSION });
    return session;
  }

  it('records the holder\'s line as a system entry and saves it', () => {
    const session = open();
    session.recordUserAction('You committed "fix" on main.', '2026-01-01T00:01:00Z');

    expect(saved().conversationHistory!.at(-1)).toMatchObject({
      role: 'assistant',
      kind: 'system',
      content: 'You committed "fix" on main.',
      timestamp: '2026-01-01T00:01:00Z',
    });
  });

  it('folds lines another host left, in order, and folds each once', () => {
    const session = open();
    appendUserAction(SESSION, workspace, { text: 'You stashed changes on main.', at: '2026-01-01T00:02:00Z' });
    appendUserAction(SESSION, workspace, { text: 'You pulled from origin/main on main.', at: '2026-01-01T00:03:00Z' });

    session.foldUserActions();
    session.foldUserActions();

    const lines = saved().conversationHistory!.filter((m) => m.kind === 'system').map((m) => [m.content, m.timestamp]);
    expect(lines).toEqual([
      ['You stashed changes on main.', '2026-01-01T00:02:00Z'],
      ['You pulled from origin/main on main.', '2026-01-01T00:03:00Z'],
    ]);
    expect(takeUserActions(SESSION, workspace)).toEqual([]);
  });

  it('skips a line it cannot read and keeps the rest', () => {
    const session = open();
    appendUserAction(SESSION, workspace, { text: 'You saved a.ts on main.', at: '2026-01-01T00:04:00Z' });
    const file = path.join(sessionStore.sessionDataDir(SESSION, workspace), 'user-actions.jsonl');
    fs.appendFileSync(file, '{"text": 3}\nnot json\n');

    session.foldUserActions();

    expect(saved().conversationHistory!.filter((m) => m.kind === 'system').map((m) => m.content)).toEqual(['You saved a.ts on main.']);
  });
});
