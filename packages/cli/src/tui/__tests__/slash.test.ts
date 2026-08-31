import { describe, it, expect, afterEach } from 'vitest';
import {
  parseSlash, SLASH_COMMANDS, findCommand, completions, registerSkillCommands,
  slashTokens, activeToken, skillMatchKind, tokenCompletions,
} from '../slash';

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
    'tdd', 'verify',
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

describe('registerSkillCommands', () => {
  afterEach(() => registerSkillCommands([]));

  it('adds a discovered skill to completions', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(completions('/gri').map((c) => c.name)).toContain('grilling');
  });

  it('marks a skill command as such, distinct from a built-in', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(findCommand('grilling')).toMatchObject({ source: 'skill', description: 'Grill the plan' });
    expect(findCommand('help')?.source).toBeUndefined();
  });

  it('a skill name colliding with a built-in loses — the built-in still wins', () => {
    registerSkillCommands([{ name: 'help', description: 'A skill pretending to be help' }]);
    expect(findCommand('help')?.source).toBeUndefined();
    expect(completions('/help').filter((c) => c.name === 'help')).toHaveLength(1);
  });

  it('does not leak into the built-in help listing', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(SLASH_COMMANDS.some((c) => c.name === 'grilling')).toBe(false);
  });
});

describe('slashTokens', () => {
  it('finds a leading token', () => {
    expect(slashTokens('/grilling')).toEqual([{ start: 0, end: 9, name: 'grilling', nameEnd: 9 }]);
  });

  it('finds a token in the middle of a sentence, bounded by whitespace', () => {
    const tokens = slashTokens('explain this /grilling please');
    expect(tokens).toEqual([{ start: 13, end: 22, name: 'grilling', nameEnd: 22 }]);
  });

  it('finds every distinct token in a message', () => {
    const tokens = slashTokens('/grilling this and /to-spec that');
    expect(tokens.map((t) => t.name)).toEqual(['grilling', 'to-spec']);
  });

  it('strips trailing punctuation from name and nameEnd, keeping it out of the matched range', () => {
    const [token] = slashTokens('use /grilling, please');
    expect(token.name).toBe('grilling');
    expect(token.nameEnd).toBe(token.end - 1); // the comma sits just past nameEnd
  });

  it('does not treat a "/" glued to the previous word as a token', () => {
    expect(slashTokens('hello/grilling')).toEqual([]);
  });

  it('captures a path-like run as one non-matching token (no letters-only name to strip)', () => {
    expect(slashTokens('see /usr/bin/foo for details')).toEqual([
      { start: 4, end: 16, name: 'usr/bin/foo', nameEnd: 16 },
    ]);
  });
});

describe('activeToken', () => {
  it('finds the token the caret sits immediately after', () => {
    const token = activeToken('explain this /gri', 'explain this /gri'.length);
    expect(token?.name).toBe('gri');
  });

  it('is null once the caret has moved past the token', () => {
    expect(activeToken('/grilling now', 13)).toBeNull();
  });

  it('is null when there is no token at all', () => {
    expect(activeToken('just a normal question', 5)).toBeNull();
  });
});

describe('skillMatchKind', () => {
  afterEach(() => registerSkillCommands([]));

  it('is "exact" for a full discovered-skill name', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(skillMatchKind('grilling')).toBe('exact');
  });

  it('is "prefix" for a live-typed prefix of a discovered skill', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(skillMatchKind('gri')).toBe('prefix');
  });

  it('is null for a built-in command, even one tagged category "skills"', () => {
    expect(skillMatchKind('tdd')).toBeNull();
  });

  it('is null for text that names nothing discovered', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(skillMatchKind('grix')).toBeNull();
  });

  it('is null for an empty name', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    expect(skillMatchKind('')).toBeNull();
  });
});

describe('tokenCompletions', () => {
  afterEach(() => registerSkillCommands([]));

  it('offers the combined built-in+skill list for a token at the start of the buffer', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    const names = tokenCompletions({ start: 0, end: 4, name: 'gri', nameEnd: 4 }).map((c) => c.name);
    expect(names).toContain('grilling');
  });

  it('offers skills only for a token elsewhere in the buffer', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    const names = tokenCompletions({ start: 8, end: 12, name: 'gri', nameEnd: 12 }).map((c) => c.name);
    expect(names).toEqual(['grilling']);
  });

  it('excludes a built-in even when its name matches the prefix, once mid-prompt', () => {
    const names = tokenCompletions({ start: 8, end: 11, name: 'td', nameEnd: 11 }).map((c) => c.name);
    expect(names).not.toContain('tdd');
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
