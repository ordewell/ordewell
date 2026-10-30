import { describe, it, expect, afterEach } from 'vitest';
import {
  parseSlash, SLASH_COMMANDS, findCommand, completions, registerSkillCommands,
  slashTokens, activeToken, skillMatchKind, tokenCompletions,
  slashCommandTable, canonicalCommandName, composerCompletions, parseRunnerCommand,
} from '../slash';

describe('parseSlash', () => {
  it('returns null for text that is not a slash command', () => {
    expect(parseSlash('add a login page')).toBeNull();
  });

  it('splits a command into its name and arguments', () => {
    expect(parseSlash('  /task-model 2 deepseek/deepseek-v4-flash ')).toEqual({
      name: 'task-model',
      args: ['2', 'deepseek/deepseek-v4-flash'],
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
    'help', 'planner', 'key', 'allowlist', 'refresh', 'login',
    'sessions', 'new', 'save', 'load', 'delete',
    'runners', 'settings',
    // No 'plan': typing the goal starts planning, so an alias would only
    // shadow /planner on completion.
    'run', 'stop', 'approve',
    'add-task', 'remove-task', 'complete', 'revert', 'skip', 'retry', 'cancel', 'force-start',
    // Per-task assignment editors, in the order each choice constrains the next.
    'task-runner', 'task-model', 'task-effort', 'task-mode', 'task-deps', 'task-skills',
    'quit',
  ];

  it.each(REQUIRED)('exposes /%s', (name) => {
    expect(findCommand(name)).toBeDefined();
  });

  // `/settings` and `/planner` cover these; one command per value only made
  // the surface larger than the thing it described.
  it.each(['auto', 'supervisor', 'automerge', 'autorun', 'research', 'parallel', 'model', 'planner-effort'])(
    'no longer exposes /%s',
    (name) => {
      expect(findCommand(name)).toBeUndefined();
    },
  );

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
    // The built-in table plus its aliases: /resume is offered too, right after
    // /sessions, so a synonym is discoverable where its target is.
    expect(completions('/')).toHaveLength(slashCommandTable().length);
  });

  it('filters by prefix', () => {
    const names = completions('/re').map((c) => c.name);
    expect(names).toContain('remove-task');
    expect(names).not.toContain('verify');
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
    expect(completions('/task-model 2 gpt')).toEqual([]);
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

  it('lists user-invocable skills of both kinds, marking a task skill, and hides a model-only one', () => {
    registerSkillCommands([
      { name: 'grilling', description: 'Grill the plan', appliesTo: 'planner', userInvocable: true },
      { name: 'tdd', description: 'Test first', appliesTo: 'task', userInvocable: true },
      { name: 'secret', description: 'Model only', appliesTo: 'task', userInvocable: false },
    ]);
    expect(completions('/').filter((c) => c.source === 'skill').map((c) => [c.name, c.description])).toEqual([
      ['grilling', 'Grill the plan'],
      ['tdd', 'task skill · Test first'],
    ]);
    expect(findCommand('secret')).toBeUndefined();
    expect(skillMatchKind('secret')).toBeNull();
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
    expect(skillMatchKind('verify')).toBeNull();
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
    const names = tokenCompletions({ start: 8, end: 11, name: 've', nameEnd: 11 }).map((c) => c.name);
    expect(names).not.toContain('verify');
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

  // Selection is per-pane only where the panes share rows. The composer is
  // chrome across the frame, and the sheet has to say so, or a user who drags
  // it and gets the whole line reads the old label as a promise it broke.
  it('says the composer is selected whole rather than per pane', () => {
    const description = findCommand('mouse')!.description;
    expect(description).toMatch(/body/i);
    expect(description).toMatch(/composer/i);
    expect(description).toMatch(/on/);
    expect(description).toMatch(/off/);
  });
});


describe('command aliases', () => {
  afterEach(() => registerSkillCommands([]));

  it('resolves /resume to the canonical /sessions command', () => {
    expect(canonicalCommandName('resume')).toBe('sessions');
    expect(canonicalCommandName('/resume')).toBe('sessions');
    expect(canonicalCommandName('sessions')).toBe('sessions');
  });

  it('offers /resume in completion, right after /sessions', () => {
    expect(completions('/res').map((c) => c.name)).toContain('resume');
    const table = slashCommandTable().map((c) => c.name);
    expect(table.indexOf('resume')).toBe(table.indexOf('sessions') + 1);
  });

  it('renders /resume as an alias of /sessions that opens a saved session', () => {
    const alias = slashCommandTable().find((c) => c.name === 'resume');
    expect(alias?.usage).toBe('/resume');
    expect(alias?.description).toMatch(/alias for \/sessions/i);
    expect(alias?.description).toMatch(/saved session/i);
  });

  it('a skill named resume may not shadow the built-in alias', () => {
    registerSkillCommands([{ name: 'resume', description: 'A skill pretending to be resume' }]);
    expect(findCommand('resume')?.source).toBeUndefined();
    expect(completions('/resume').filter((c) => c.name === 'resume')).toHaveLength(1);
  });
});

describe('task-chat boundary', () => {
  it("a task chat's /resume stays the runner's own command, not the planner alias", () => {
    // The raw name reaches the runner unchanged — no alias resolution here.
    expect(parseRunnerCommand('/resume 3')).toEqual({ name: 'resume', args: '3' });
    const runner = [{ name: 'resume' }] as unknown as Parameters<typeof composerCompletions>[1];
    const token = { start: 0, end: 7, name: 'res', nameEnd: 7 };
    expect(composerCompletions(token, runner)).toEqual(['resume']);
    // The planner's alias lives only in the built-in table; a runner-less chat
    // still offers it, so the two surfaces stay distinct by construction.
    expect(composerCompletions(token, null)).toContain('resume');
  });
});
