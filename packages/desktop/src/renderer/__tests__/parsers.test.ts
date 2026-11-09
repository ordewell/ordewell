import { describe, expect, it } from 'vitest';
import { parseRunners } from '../runners';
import { parseSessions } from '../sessions';

describe('parseRunners', () => {
  it('lists every runner core ships, in core order, an absent one as missing', () => {
    const data = {
      runners: [
        { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-out', detail: 'run codex login' } },
        { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } },
        { id: 'aider', name: 'Aider', enabled: true },
      ],
      orchestratorModel: 'x',
    };
    expect(parseRunners(data)).toEqual([
      { id: 'claude-code', name: 'Claude Code', state: 'signed-in' },
      { id: 'codex', name: 'Codex', state: 'signed-out', detail: 'run codex login' },
      { id: 'opencode', name: 'OpenCode', state: 'missing' },
      { id: 'copilot-cli', name: 'GitHub Copilot CLI', state: 'missing' },
      { id: 'qwen-code', name: 'Qwen Code', state: 'missing' },
      { id: 'cline', name: 'Cline', state: 'missing' },
      { id: 'gemini-cli', name: 'Gemini CLI', state: 'missing' },
      { id: 'cursor-agent', name: 'Cursor', state: 'missing' },
      { id: 'aider', name: 'Aider', state: 'unknown' },
    ]);
  });

  it('reads an unknown or absent login state as unknown', () => {
    const data = { runners: [{ id: 'opencode', auth: { state: 'weird' } }, { id: 'codex' }] };
    expect(parseRunners(data)?.filter((line) => line.id === 'codex' || line.id === 'opencode'))
      .toEqual([{ id: 'codex', name: 'Codex', state: 'unknown' }, { id: 'opencode', name: 'OpenCode', state: 'unknown' }]);
  });

  it('reads a runner turned off in Settings as off, whatever its login', () => {
    const data = { runners: [{ id: 'codex', enabled: false, auth: { state: 'signed-in' } }] };
    expect(parseRunners(data)?.[1]).toEqual({ id: 'codex', name: 'Codex', state: 'off' });
  });

  it('keeps the version and the sign-in command when the daemon gives them', () => {
    const data = { runners: [
      { id: 'codex', enabled: true, version: '0.9.1', auth: { state: 'signed-out', loginCommand: ['codex', 'login'] } },
      { id: 'opencode', enabled: true, version: '', auth: { state: 'signed-out', loginCommand: ['opencode', 3] } },
    ] };
    const [, codex, opencode] = parseRunners(data) ?? [];
    expect(codex).toEqual({ id: 'codex', name: 'Codex', state: 'signed-out', version: '0.9.1', loginCommand: ['codex', 'login'] });
    expect(opencode).toEqual({ id: 'opencode', name: 'OpenCode', state: 'signed-out' });
  });

  it('keeps why an installed agent cannot be started, or says so plainly when the daemon gives no reason', () => {
    const data = { runners: [
      { id: 'cline', enabled: true, usable: false, reason: 'Cline 1.0.0 is older than the 1.3.0 it needs.', auth: { state: 'unknown' } },
      { id: 'qwen-code', enabled: true, usable: false, auth: { state: 'signed-in' } },
      { id: 'cursor-agent', enabled: true, usable: true, auth: { state: 'signed-in' } },
    ] };
    const lines = parseRunners(data) ?? [];
    expect(lines.find((line) => line.id === 'cline')?.unavailable).toBe('Cline 1.0.0 is older than the 1.3.0 it needs.');
    expect(lines.find((line) => line.id === 'qwen-code')?.unavailable).toBe('Ordewell cannot start it.');
    expect(lines.find((line) => line.id === 'cursor-agent')?.unavailable).toBeUndefined();
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

  it("keeps the daemon's word that a run is live, its counts only when both are whole numbers", () => {
    const at = { status: 'approved', taskCount: 2, updatedAt: '2026-11-03T00:00:00Z' };
    const rows = parseSessions([
      { id: 'held', ...at, run: { live: true, done: 1, total: 2 } },
      { id: 'leased', ...at, run: { live: true } },
      { id: 'odd-counts', ...at, run: { live: true, done: 1, total: '2' } },
      { id: 'negative', ...at, run: { live: true, done: -1, total: 2 } },
      { id: 'not-live', ...at, run: { live: false, done: 1, total: 2 } },
      { id: 'old-daemon', ...at },
    ]);
    expect(Object.fromEntries((rows ?? []).map((row) => [row.id, row.run]))).toEqual({
      held: { live: true, done: 1, total: 2 },
      leased: { live: true },
      'odd-counts': { live: true },
      negative: { live: true },
      'not-live': undefined,
      'old-daemon': undefined,
    });
    // An Approved row with no run is not taken to be running.
    expect(rows?.find((row) => row.id === 'old-daemon')).not.toHaveProperty('run');
  });

  it('answers undefined for anything but a session list', () => {
    expect(parseSessions({ sessions: [] })).toBeUndefined();
    expect(parseSessions([{ goal: 'no id' }])).toBeUndefined();
    expect(parseSessions([])).toEqual([]);
  });
});
