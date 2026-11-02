import { describe, expect, it, vi } from 'vitest';
import { containersOffered } from '@ordewell/core';
import { COMMANDS } from '../registry';
import { printHelp } from '../../help';

/** The switch as a published build has it (ADR-0059 L5): no surface shows or accepts containers. */
describe('containers, in a build that does not offer them', () => {
  it('is what these tests run under', () => {
    expect(containersOffered()).toBe(false);
  });

  it('is not an `ordewell` command: not runnable and not in --help', () => {
    expect(Object.keys(COMMANDS)).not.toContain('containers');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHelp();
    const help = log.mock.calls.flat().join('\n');
    log.mockRestore();
    expect(help).not.toMatch(/ordewell containers/);
  });
});
