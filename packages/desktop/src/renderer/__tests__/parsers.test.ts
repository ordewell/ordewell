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

  it('reads a runner turned off in Settings as off, whatever its login', () => {
    const data = { runners: [{ id: 'codex', enabled: false, auth: { state: 'signed-in' } }] };
    expect(parseRunners(data)?.[1]).toEqual({ id: 'codex', state: 'off' });
  });

  it('keeps the version and the sign-in command when the daemon gives them', () => {
    const data = { runners: [
      { id: 'codex', enabled: true, version: '0.9.1', auth: { state: 'signed-out', loginCommand: ['codex', 'login'] } },
      { id: 'opencode', enabled: true, version: '', auth: { state: 'signed-out', loginCommand: ['opencode', 3] } },
    ] };
    const [, codex, opencode] = parseRunners(data) ?? [];
    expect(codex).toEqual({ id: 'codex', state: 'signed-out', version: '0.9.1', loginCommand: ['codex', 'login'] });
    expect(opencode).toEqual({ id: 'opencode', state: 'signed-out' });
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
