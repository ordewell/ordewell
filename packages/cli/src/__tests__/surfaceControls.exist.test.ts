import { describe, expect, it } from 'vitest';
import { SURFACE_CONTROLS } from '@ordewell/core';
import { COMMANDS } from '../commands/registry';
import { SLASH_COMMANDS } from '../tui/slash';

/**
 * The planner tells the user to type what these name (ADR-0030), so each
 * shell command and slash command must be one the CLI and the TUI have.
 */
const named = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map((m) => m[1]!);

describe('the controls the planner names on the terminal surfaces', () => {
  it('name only ordewell subcommands the CLI has', () => {
    const subcommands = Object.values(SURFACE_CONTROLS.cli).flatMap((control) => named(control, /\bordewell ([a-z-]+)/g));
    expect(subcommands).toContain('merge');
    for (const subcommand of subcommands) expect(Object.keys(COMMANDS), subcommand).toContain(subcommand);
  });

  it('name only slash commands the TUI has', () => {
    const slash = SLASH_COMMANDS.map((c) => c.name);
    const named_ = [...Object.values(SURFACE_CONTROLS.tui), ...Object.values(SURFACE_CONTROLS.cli)].flatMap((control) => named(control, /(?:^|[\s(])\/([a-z-]+)/g));
    expect(named_).toContain('merge');
    for (const command of named_) expect(slash, command).toContain(command);
  });
});
