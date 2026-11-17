import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSettingsError } from '../SettingsService';
import { clampTaskCompactAt, taskCompactAtOf } from '../taskCompactWindow';

/** The setting every harness's adapter reads, before it maps it onto its own knob. */
describe('taskCompactAtOf', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    [undefined, undefined, 'auto'],
    ['auto', undefined, 'auto'],
    ['off', undefined, 'off'],
    [' OFF ', undefined, 'off'],
    [150_000, undefined, 150_000],
    ['150000', undefined, 150_000],
    [1, undefined, 1],
    [5_000_000, undefined, 5_000_000],
    [250_000, 'off', 'off'],
    [250_000, ' 90000 ', 90_000],
    ['off', 'auto', 'auto'],
  ])('reads file %j with env %j as %j', (file, env, expected) => {
    expect(taskCompactAtOf(file, env)).toBe(expected);
  });

  it('treats a blank env as unset', () => {
    expect(taskCompactAtOf(120_000, '  ')).toBe(120_000);
  });

  it.each([0, -1, 1.5, 'soon', '12k', '', true, {}])('refuses file value %j, saying what is accepted', (file) => {
    expect(() => taskCompactAtOf(file, undefined)).toThrow(RunSettingsError);
    expect(() => taskCompactAtOf(file, undefined)).toThrow(/taskCompactAt.*auto, off or a whole number of tokens greater than zero/);
  });

  it('refuses a bad env, naming the variable', () => {
    expect(() => taskCompactAtOf(undefined, '0')).toThrow(/ORDEWELL_TASK_COMPACT_AT.*greater than zero/);
  });
});

describe('clampTaskCompactAt', () => {
  it('returns a number within the bounds untouched and silent', () => {
    const log = vi.fn();
    expect(clampTaskCompactAt(80_000, { min: 50_000, max: 100_000 }, 'Codex', log)).toBe(80_000);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([[10_000, 50_000], [200_000, 100_000]])('clamps %i to %i with one line naming the harness', (value, clamped) => {
    const log = vi.fn();
    expect(clampTaskCompactAt(value, { min: 50_000, max: 100_000 }, 'Codex', log)).toBe(clamped);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(new RegExp(`Codex.*taskCompactAt.*${value}.*${clamped}`));
  });
});
