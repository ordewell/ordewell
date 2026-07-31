import { describe, it, expect } from 'vitest';
import { COMMANDS } from '../registry';
import { SLASH_COMMANDS } from '../../tui/slash';

/**
 * The two command surfaces are one product. This test is the contract: a slash
 * command added to the TUI without a subcommand of the same name fails here,
 * rather than being discovered by a user who learned the TUI first.
 *
 * The exemptions are listed rather than pattern-matched, so adding to them is a
 * deliberate act with a reason attached.
 */
const TUI_ONLY: Record<string, string> = {
  help: '`ordewell --help`, which is not a subcommand',
  quit: 'nothing to exit — a CLI command has already returned',
  new: 'every `ordewell plan` already starts a fresh session',
  save: 'plans are persisted server-side as they change; there is nothing to flush',
  load: '`ordewell sessions load <id>`',
  delete: '`ordewell sessions delete <id>`',
};

/** CLI-only commands: a daemon, a wizard or a catalog has no slash equivalent. */
const CLI_ONLY = [
  'web', 'setup', 'plugins', 'models', 'tui', 'status',
  'stop-server', 'run-task', 'mark-complete', 'plan',
];

describe('CLI ↔ TUI command parity', () => {
  it.each(SLASH_COMMANDS.filter((c) => !(c.name in TUI_ONLY)).map((c) => c.name))(
    'exposes /%s as a subcommand',
    (name) => {
      expect(Object.keys(COMMANDS)).toContain(name);
    },
  );

  it('exempts only commands that have a stated CLI equivalent', () => {
    for (const [name, reason] of Object.entries(TUI_ONLY)) {
      expect(SLASH_COMMANDS.map((c) => c.name)).toContain(name);
      expect(reason).toBeTruthy();
    }
  });

  it('has no subcommand missing from the TUI beyond the listed CLI-only ones', () => {
    const slash = new Set(SLASH_COMMANDS.map((c) => c.name));
    const unexplained = Object.keys(COMMANDS).filter((name) => !slash.has(name) && !CLI_ONLY.includes(name));
    expect(unexplained).toEqual([]);
  });
});
