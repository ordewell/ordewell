import { describe, expect, it } from 'vitest';
import { parseRunners } from '../runners';
import { parseSessions } from '../sessions';

describe('parseRunners', () => {
  it('lists the three known runners in order, an absent one as missing', () => {
    const data = {
      runners: [
        { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-out', detail: 'run codex login' } },
        { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } },
        { id: 'aider', name: 'Aider', enabled: true },
      ],
      orchestratorModel: 'x',
    };
    expect(parseRunners(data)).toEqual([
      { id: 'claude-code', state: 'signed-in' },
      { id: 'codex', state: 'signed-out', detail: 'run codex login' },
      { id: 'opencode', state: 'missing' },
    ]);
  });

  it('reads an unknown or absent login state as unknown', () => {
    const data = { runners: [{ id: 'opencode', auth: { state: 'weird' } }, { id: 'codex' }] };
    expect(parseRunners(data)?.slice(1)).toEqual([{ id: 'codex', state: 'unknown' }, { id: 'opencode', state: 'unknown' }]);
  });

  it('answers undefined for anything but the runners response', () => {
    expect(parseRunners(undefined)).toBeUndefined();
    expect(parseRunners([])).toBeUndefined();
    expect(parseRunners({ runners: 'x' })).toBeUndefined();
  });
});

describe('parseSessions', () => {
  it('sorts newest first and fills what an entry leaves out', () => {
    const data = [
      { id: 'old', goal: 'Old', status: 'completed', taskCount: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
      { id: 'new', goal: 'New', status: 'running', taskCount: 5, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' },
      { id: 'bare', createdAt: '2026-10-15T00:00:00Z' },
    ];
    expect(parseSessions(data)).toEqual([
      { id: 'new', goal: 'New', status: 'running', taskCount: 5, updatedAt: '2026-11-03T00:00:00Z' },
      { id: 'bare', goal: '', status: 'unknown', taskCount: 0, updatedAt: '2026-10-15T00:00:00Z' },
      { id: 'old', goal: 'Old', status: 'completed', taskCount: 3, updatedAt: '2026-10-02T00:00:00Z' },
    ]);
  });

  it('answers undefined for anything but a session list', () => {
    expect(parseSessions({ sessions: [] })).toBeUndefined();
    expect(parseSessions([{ goal: 'no id' }])).toBeUndefined();
    expect(parseSessions([])).toEqual([]);
  });
});
