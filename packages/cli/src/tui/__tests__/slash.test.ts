import { describe, it, expect } from 'vitest';
import { parseSlash, SLASH_COMMANDS, findCommand, completions } from '../slash';

describe('parseSlash', () => {
  it('returns null for text that is not a slash command', () => {
    expect(parseSlash('add a login page')).toBeNull();
  });

  it('splits a command into its name and arguments', () => {
    expect(parseSlash('  /model set  deepseek/deepseek-v4-flash ')).toEqual({
      name: 'model',
      args: ['set', 'deepseek/deepseek-v4-flash'],
    });
  });

  it('treats a bare slash as ordinary text', () => {
    expect(parseSlash('/')).toBeNull();
  });
});

describe('SLASH_COMMANDS', () => {
  // Feature-parity contract with the VS Code extension (issue #24). Every
  // capability the webview exposes must be reachable from the TUI.
  const REQUIRED = [
    'help', 'model', 'key', 'allowlist', 'refresh',
    'sessions', 'new', 'save', 'load', 'delete',
    'runners', 'auto',
    'grill-me', 'tdd', 'prd', 'verify', 'research-subagents',
    // No 'plan': typing the goal starts planning, so an alias would only
    // shadow /planner and /planner-effort on completion.
    'run', 'stop', 'approve',
    'add-task', 'remove-task', 'complete', 'skip', 'retry', 'cancel', 'force-start',
    // Per-task assignment editors, in the order each choice constrains the next.
    'task-runner', 'task-model', 'task-effort', 'task-mode', 'task-deps',
    'quit',
  ];

  it.each(REQUIRED)('exposes /%s', (name) => {
    expect(findCommand(name)).toBeDefined();
  });

  it('gives every command a usage string and a description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.usage, cmd.name).toMatch(/^\//);
      expect(cmd.description.length, cmd.name).toBeGreaterThan(0);
    }
  });

  it('has no duplicate command names', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('completions', () => {
  it('lists every command for a bare slash', () => {
    expect(completions('/')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('filters by prefix', () => {
    const names = completions('/re').map((c) => c.name);
    expect(names).toContain('remove-task');
    expect(names).not.toContain('tdd');
  });

  // Tab takes the first match, so a redundant `/plan` would make `/planner`
  // unreachable by prefix — the reason it is not a command.
  it('leads with /planner once the user has typed "/plan"', () => {
    expect(completions('/plan')[0].name).toBe('planner');
  });

  it('returns nothing when the text is not a command', () => {
    expect(completions('build me an app')).toEqual([]);
  });

  it('stops suggesting once the command is complete and args are being typed', () => {
    expect(completions('/model set gpt')).toEqual([]);
  });
});

describe('/mouse', () => {
  // The sheet is where the trade is discoverable, and the trade changed:
  // capture no longer costs the user their selection, it moves it into the app.
  it('describes capture as pane selection rather than as losing selection', () => {
    const description = findCommand('mouse')!.description;
    expect(description).toMatch(/pane/i);
    expect(description).toMatch(/select/i);
  });
});
