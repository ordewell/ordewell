import { describe, expect, it, vi } from 'vitest';
import { printHelp } from '../help';

function help(): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  try {
    printHelp();
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

describe('ordewell --help', () => {
  it('lists the flags run and plan actually accept', () => {
    const text = help();

    expect(text).toContain('--stash');
    expect(text).toContain('--without-isolation');
    expect(text).toContain('--yes');
    expect(text).toContain('--verbose');
  });

  it('does not call setup an interactive wizard, which reads nothing from stdin', () => {
    const line = help().split('\n').find((l) => l.includes('ordewell setup'));

    expect(line).toContain('setup');
    expect(line).not.toMatch(/interactive|wizard/i);
  });

  it('does not claim /settings sets the supervisor read budget', () => {
    const line = help().split('\n').find((l) => l.includes('supervisor reads'));

    expect(line).toContain('set only here or in settings.json');
    expect(line).not.toContain('/settings');
  });

  it('lists ordewell update, and that --dry-run only prints what it would run', () => {
    const line = help().split('\n').find((l) => l.includes('ordewell update'));

    expect(line).toContain('--dry-run');
  });
});
