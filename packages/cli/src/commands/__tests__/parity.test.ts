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
  settings: 'a stepped panel over the headless `ordewell auto`, `supervisor`, `automerge`, `trailer`, `autorun`, `delegation` and `parallel` commands',
  open: 'it opens a task\'s view in the full-screen terminal; a shell has no view to switch to, and `ordewell checkpoint` answers from one',
  inbox: 'it lists what the run waits on from the full-screen terminal\'s live run view and answers in place; each answer is already a headless command (`ordewell retry`, `skip`, `checkpoint`, `handoff`)',
  mouse: 'it configures the full-screen terminal, which only the TUI holds (ORDEWELL_TUI_MOUSE persists it)',
  login: 'it hands the full-screen terminal to the coding agent\'s own login command; on a shell, run that command directly',
};

/** CLI-only commands: a daemon, a wizard or a catalog has no slash equivalent, or the TUI's `/settings` and `/planner` panels cover it. */
const CLI_ONLY = [
  'web', 'setup', 'models', 'skills', 'tui', 'status',
  'stop-server', 'run-task', 'mark-complete', 'plan',
  // The headless form of the `/settings` panel's rows.
  'auto', 'supervisor', 'automerge', 'trailer', 'autorun', 'delegation', 'parallel',
  // The headless form of `/planner`'s model and effort steps.
  'model', 'planner-effort',
];

describe('CLI ↔ TUI command parity', () => {
  it('has no terminal command on either surface', () => {
    expect(Object.keys(COMMANDS)).not.toContain('terminal');
    expect(SLASH_COMMANDS.map((command) => command.name)).not.toContain('terminal');
  });

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
