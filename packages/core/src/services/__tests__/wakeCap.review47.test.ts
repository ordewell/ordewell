import { describe, expect, it } from 'vitest';
import { boundedWakeUps, LEFT_OUT_ROOM, WAKE_MAX_CHARS } from '../WakePolicy';

/**
 * ADR-0057 R5: "What woke the planner goes first, whole items only." A turn
 * takes every update that waited for it; the one that opened the turn is the
 * newest, and its event is the one a person or a decision waits on.
 */
describe('a turn carrying more updates than the cap', () => {
  it('keeps the update that opened the turn rather than the oldest', () => {
    const older = 'x'.repeat(WAKE_MAX_CHARS - 10);
    const current = 'Run update:\n- task #3 "Fix" is waiting for approval';

    expect(boundedWakeUps([older, current]).join('\n')).toContain('waiting for approval');
  });

  it('names what it leaves out, what needs an answer ahead of the passes', () => {
    const left = `Run update:\n- task #1 "Build" failed: boom\n  ${'r'.repeat(5000)}\nSince the last update:\n- task #2 "Lint" passed`;
    const later = 'Run update:\n- task #3 "Fix" is waiting for approval: Bash(npm publish)';
    const big = `Run update:\n- task #4 "Big" reported\n  ${'r'.repeat(WAKE_MAX_CHARS - 2000)}`;

    const sent = boundedWakeUps([left, later, big]);

    expect(sent).toHaveLength(3);
    expect(sent[0]).toBe('+1 earlier run update left out; task_query reads these tasks:\n- task #1 "Build" failed: boom\n- task #2 "Lint" passed');
    expect(sent.slice(1)).toEqual([later, big]);
  });

  it('counts what it does not name, and what a left-out update itself only counted', () => {
    const many = ['Run update:', ...Array.from({ length: 12 }, (_, i) => `- task #${i} "T" failed`), '+5 more: 5 passed; task_query reads them.'].join('\n');

    const [note] = boundedWakeUps([many, 'x'.repeat(WAKE_MAX_CHARS)]);

    expect(note.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(8);
    expect(note.split('\n').at(-1)).toBe('+9 more.');
  });

  it('stays inside the cap with the largest digest and the longest note', () => {
    const many = ['Run update:', ...Array.from({ length: 50 }, (_, i) => `- task #${i} "${'T'.repeat(200)}" failed`)].join('\n');
    const newest = 'x'.repeat(WAKE_MAX_CHARS - LEFT_OUT_ROOM);

    expect(boundedWakeUps([many, newest]).join('').length).toBeLessThanOrEqual(WAKE_MAX_CHARS);
  });

  it('keeps the newest whole even when it alone is past the cap, as a digest saved by an older build may be', () => {
    const newest = 'n'.repeat(WAKE_MAX_CHARS + 5);

    expect(boundedWakeUps(['old', newest]).at(-1)).toBe(newest);
    expect(boundedWakeUps([newest])).toEqual([newest]);
  });

  it('sends every update as it came while they all fit', () => {
    expect(boundedWakeUps(['a', 'b'])).toEqual(['a', 'b']);
    expect(boundedWakeUps([])).toEqual([]);
  });
});
