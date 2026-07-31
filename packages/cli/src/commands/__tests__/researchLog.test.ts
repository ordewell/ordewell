import { describe, it, expect } from 'vitest';
import { formatStepLine, isTransient } from '../researchLog';
import type { WsEvent } from '../../apiClient';
import type { ResearchStep } from '@ordewell/core';

const step = (overrides: Partial<ResearchStep> = {}): ResearchStep => ({
  id: 'rs-1',
  tool: 'read_file' as ResearchStep['tool'],
  args: JSON.stringify({ path: 'src/auth.ts' }),
  result: 'export const auth = 1;',
  success: true,
  outcome: 'success',
  timestamp: '',
  ...overrides,
});

const done = (overrides: Partial<ResearchStep> = {}, event: Record<string, unknown> = {}): WsEvent =>
  ({ type: 'research_step_done', step: step(overrides), ...event });

describe('formatStepLine', () => {
  it('summarizes an issued call', () => {
    expect(formatStepLine({ type: 'research_step', tool: 'read_file', args: '{"path":"src/auth.ts"}' }))
      .toBe('read_file auth.ts');
  });

  it('indents a subagent call under its parent', () => {
    expect(formatStepLine({ type: 'research_step', tool: 'grep', args: '{"pattern":"login"}', subagentId: 'sub-1' }))
      .toBe('  ↳ grep login');
  });

  it('reports the outcome and a result preview when a call settles', () => {
    expect(formatStepLine(done())).toBe('✓ read_file auth.ts → export const auth = 1;');
  });

  it('distinguishes failure, refusal, denial and non-execution from success', () => {
    const marks = (['failure', 'refused', 'denied', 'not_executed'] as const).map((outcome) =>
      formatStepLine(done({ outcome, success: false, result: '' })),
    );

    expect(marks).toEqual([
      '✗ read_file auth.ts',
      '⊘ read_file auth.ts',
      '⊘ read_file auth.ts',
      '– read_file auth.ts',
    ]);
  });

  it('collapses a multi-line result to one truncated line', () => {
    const line = formatStepLine(done({ result: `first\nsecond${'x'.repeat(400)}` }))!;

    expect(line).not.toContain('\n');
    expect(line.startsWith('✓ read_file auth.ts → first second')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThan(220);
  });

  it('gives verbose runs a longer preview', () => {
    const args = { result: 'y'.repeat(1000) };
    const quiet = formatStepLine(done(args))!;
    const loud = formatStepLine(done(args), { verbose: true })!;

    expect(loud.length).toBeGreaterThan(quiet.length);
  });

  it('indents a settled subagent call too', () => {
    expect(formatStepLine(done({ result: '' }, { subagentId: 'sub-1' }))).toBe('  ↳ ✓ read_file auth.ts');
  });

  it('drops reasoning unless --verbose asked for it', () => {
    const event: WsEvent = { type: 'plan_thinking', text: 'Considering  the\nauth flow' };

    expect(formatStepLine(event)).toBeNull();
    expect(formatStepLine(event, { verbose: true })).toBe('  · Considering the auth flow');
  });

  it('prints nothing for lifecycle events or a malformed done event', () => {
    expect(formatStepLine({ type: 'status_update', tasks: [] })).toBeNull();
    expect(formatStepLine({ type: 'plan_token', token: 'x' })).toBeNull();
    // A daemon that sends `research_step_done` without its step is off-contract;
    // the renderer still has to survive it rather than throw at the user.
    expect(formatStepLine({ type: 'research_step_done' } as unknown as WsEvent)).toBeNull();
  });
});

describe('isTransient', () => {
  it('holds the status line only for a call still in flight', () => {
    expect(isTransient({ type: 'research_step', tool: 'grep', args: '{}' })).toBe(true);
    expect(isTransient(done())).toBe(false);
    expect(isTransient({ type: 'plan_thinking', text: 'x' })).toBe(false);
  });
});
