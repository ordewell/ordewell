import { describe, it, expect, beforeAll } from 'vitest';
import { render } from '../render';
import { chatBodyLines } from '../layout';
import { stripAnsi, style, width } from '../ansi';
import { initialState, type ChatMessage, type TaskView, type TuiState } from '../state';
import { reduce } from '../reducer';

// Any escape sequence at all, and the two kinds a painted frame may carry:
// colour, and the erase-plus-cursor-column the pane divider is anchored with.
// eslint-disable-next-line no-control-regex
const ANY_ESCAPE = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|\[[0-?]*[ -/]*[@-~]?|[ -/]*[0-~]?)/g;
// eslint-disable-next-line no-control-regex
const PAINT_ESCAPE = /^\x1b\[[0-9;]*[mGK]$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;

beforeAll(() => {
  // Deterministic frames: colour codes would only make the assertions noisy.
  style.enabled = false;
});

const screen = (over: Partial<TuiState> = {}): string[] =>
  render(initialState({ rows: 24, cols: 80, ...over }));

const text = (over: Partial<TuiState> = {}): string => screen(over).join('\n');

const tasks: TaskView[] = [
  { id: 'a', order: 1, title: 'Add the login route', type: 'ai', status: 'completed', dependencies: [] },
  { id: 'b', order: 2, title: 'Write the tests', type: 'ai', status: 'running', dependencies: ['a'] },
  { id: 'c', order: 3, title: 'Review by hand', type: 'user', status: 'pending', dependencies: ['b'] },
];

describe('frame geometry', () => {
  it('fills the terminal exactly', () => {
    expect(screen({ rows: 24 })).toHaveLength(24);
    expect(screen({ rows: 40 })).toHaveLength(40);
  });

  it('never writes past the last column', () => {
    for (const line of screen({ cols: 60, tasks, messages: [{ role: 'assistant', content: 'x'.repeat(400), timestamp: '' }] })) {
      expect(width(line)).toBeLessThanOrEqual(60);
    }
  });

  it('keeps the pane divider on one display column in every body row', () => {
    const out = screen({
      cols: 100,
      tasks,
      messages: [{ role: 'assistant', content: 'Symbols ❯ ◐ ◆ ✓ and 日本 stay aligned.', timestamp: '' }],
    });
    const dividerColumns = out
      .filter((line) => stripAnsi(line).includes('│'))
      .map((line) => width(line.slice(0, line.indexOf('│'))));
    expect(new Set(dividerColumns)).toEqual(new Set([53]));
  });

  it('keeps the pane divider aligned and every row within `cols` for emoji, a ZWJ sequence, CJK text and a tab', () => {
    // A tab reaching this far would be a bug of its own (see keys.test.ts /
    // reducer tests for where it is meant to be stopped) — this only pins
    // that render() itself stays self-consistent if one ever does.
    const out = screen({
      cols: 100,
      tasks,
      messages: [
        { role: 'assistant', content: 'Emoji ✅ and a family \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466} plus 日本語 and a\ttab.', timestamp: '' },
      ],
    });
    const dividerColumns = out
      .filter((line) => stripAnsi(line).includes('│'))
      .map((line) => width(line.slice(0, line.indexOf('│'))));
    expect(new Set(dividerColumns)).toEqual(new Set([53]));
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(100);
  });

  it('anchors the divider to its column instead of trusting the chat side to end there', () => {
    // `width()` is a guess at how many columns the terminal will spend on the
    // chat side. The anchor is what makes a wrong guess cost a garbled chat row
    // rather than a plan pane painted five columns into the transcript.
    const body = screen({ cols: 100, tasks }).filter((line) => stripAnsi(line).includes('│'));
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) expect(line).toContain('\x1b[K\x1b[54G');
  });

  it('lets no control character or foreign escape out of a planner turn into the frame', () => {
    // What a coding agent's output actually carries: a bell, a spinner's
    // erase-and-return, a cursor move, a window title. Left in, the bell rings
    // on every spinner tick and the cursor move takes the divider with it.
    const hostile = 'failed:\x07 \x1b[2Krestart\r shifted\x1b[10C \x1b]0;title\x07 \x1b[31mred';
    const { messages } = reduce(initialState({ rows: 24, cols: 100, tasks }), {
      type: 'plannerMessage', content: hostile,
    }).state;

    for (const line of screen({ cols: 100, tasks, messages })) {
      for (const escape of line.match(ANY_ESCAPE) ?? []) expect(escape).toMatch(PAINT_ESCAPE);
      expect(line.replace(ANY_ESCAPE, '')).not.toMatch(CONTROL_CHAR);
    }
  });

  it('keeps the divider aligned when a task title arrives full of control codes', () => {
    const { tasks: normalized } = reduce(initialState({ rows: 24, cols: 100 }), {
      type: 'planUpdated',
      plan: { tasks: [{ id: 'a', order: 1, title: 'Add\tthe\x07 login\x1b[9C route', status: 'pending', type: 'ai' }] },
    }).state;

    const out = screen({ cols: 100, tasks: normalized });
    const dividers = out
      .filter((line) => stripAnsi(line).includes('│'))
      .map((line) => width(stripAnsi(line).slice(0, stripAnsi(line).indexOf('│'))));
    expect(new Set(dividers)).toEqual(new Set([53]));
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(100);
  });

  it('still renders in a cramped terminal', () => {
    expect(() => render(initialState({ rows: 6, cols: 20, tasks }))).not.toThrow();
    expect(render(initialState({ rows: 6, cols: 20, tasks }))).toHaveLength(6);
  });

  // Dragging a window edge is a stream of resizes, and every size in it gets a
  // frame — including the ones on either side of the width where the plan pane
  // appears, and the ones too small for it to be worth showing at all.
  it('fills the terminal exactly, and overruns nothing, at every width', () => {
    const hostile = 'ring\x07 \x1b[2Kmove\x1b[9C\r wide 日本語 ' + 'word '.repeat(60);
    const planned = reduce(initialState({ rows: 24, cols: 80 }), {
      type: 'planUpdated',
      plan: { tasks: [{ id: 'a', order: 1, title: hostile, status: 'running', type: 'ai' }] },
    }).state;
    const state = reduce(planned, { type: 'plannerMessage', content: hostile }).state;

    for (let cols = 1; cols <= 200; cols++) {
      for (const rows of [1, 3, 8, 24, 60]) {
        const resized = reduce(state, { type: 'resize', rows, cols }).state;
        const frame = render(resized);
        expect(frame).toHaveLength(rows);
        for (const line of frame) expect(width(line)).toBeLessThanOrEqual(cols);
      }
    }
  });
});

describe('top bar', () => {
  it('marks which skills are on', () => {
    const on = text({ skills: { ...initialState().skills, 'grill-me': true, tdd: true } });
    expect(on).toContain('grill-me');
    expect(on).toContain('tdd');
  });

  it('carries no product name, model, or workspace — those live in the welcome banner', () => {
    const out = screen({ orchestratorModel: 'deepseek/deepseek-v4-flash', workspace: '/home/dev/ordewell-tui' });
    expect(stripAnsi(out[0])).not.toMatch(/Ordewell|ordewell-tui|deepseek/i);
  });
});

// Mirrors render.ts's boldSans(): Unicode Mathematical Sans-Serif Bold reads as
// bold in any font without an ANSI escape, so the wordmark isn't the literal
// ASCII string "ordewell" — tests need the same mapping to find it.
function boldSans(word: string): string {
  return [...word].map((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 97 && code <= 122 ? String.fromCodePoint(0x1d5ee + (code - 97)) : ch;
  }).join('');
}

describe('welcome banner', () => {
  it('draws the logo as braille art — dot and wordmark on the same rows', () => {
    const out = screen({ cols: 90 });
    const lines = out.map(stripAnsi);
    // The dot's widest row, from the traced BANNER_ROWS art.
    const dotRow = lines.findIndex((l) => l.includes('⣀⣶⣿⣷⡄'));
    expect(dotRow).toBeGreaterThanOrEqual(0);
    // The wordmark sits to the right of the icon, not stacked under it.
    expect(lines[dotRow]).toMatch(/⣀⣶⣿⣷⡄\s+⣰⣿/);
  });

  it('falls back to the one-line lockup when the art cannot fit', () => {
    const out = screen({ cols: 60 });
    const lines = out.map(stripAnsi);
    const markLine = lines.findIndex((l) => l.includes(boldSans('ordewell')));
    expect(markLine).toBeGreaterThanOrEqual(0);
    expect(lines[markLine]).toContain('≫●');
  });

  it('shows the workspace directory just below the help hint', () => {
    const out = text({ workspace: '/home/dev/ordewell-tui' });
    const lines = out.split('\n').map(stripAnsi);
    const helpLine = lines.findIndex((l) => l.includes('/help'));
    expect(helpLine).toBeGreaterThanOrEqual(0);
    expect(lines[helpLine + 1]).toContain('ordewell-tui');
  });

  it('still renders in a terminal narrower than the wordmark', () => {
    expect(() => screen({ rows: 40, cols: 4, workspace: '/ws' })).not.toThrow();
  });
});

describe('transcript', () => {
  it('shows the newest messages', () => {
    const out = text({ messages: [{ role: 'assistant', content: 'Which database?', timestamp: '' }] });
    expect(out).toContain('Which database?');
  });

  it('drops the oldest messages when the pane is full rather than overflowing', () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const, content: `message ${i}`, timestamp: '',
    }));
    const out = text({ messages });
    expect(out).toContain('message 59');
    expect(out).not.toContain('message 0');
  });

  it('invites the user to start when there is nothing yet', () => {
    expect(text()).toMatch(/describe|goal|start/i);
  });

  it('keeps the welcome hints until a real conversation starts', () => {
    const out = text({ messages: [{ role: 'system', content: 'Refreshed runners.', timestamp: '' }] });
    expect(out).toMatch(/describe|goal/i);
    expect(out).toContain('Refreshed runners.');
  });

  it('keeps the welcome above the conversation while no plan exists', () => {
    const out = text({ messages: [{ role: 'assistant', content: 'Which database?', timestamp: '' }] });
    expect(out).toMatch(/Describe a goal/i);
    expect(out).toContain('Which database?');
  });

  it('drops the welcome once a plan is produced', () => {
    const out = text({ tasks, messages: [{ role: 'assistant', content: 'Which database?', timestamp: '' }] });
    expect(out).not.toMatch(/Describe a goal/i);
  });

  it('names the planner and the runners in the setup summary', () => {
    const out = text({
      plannerProvider: 'claude-code',
      orchestratorModel: 'claude-sonnet-4-5',
      runners: [
        { id: 'claude-code', name: 'Claude Code', enabled: true },
        { id: 'opencode', name: 'OpenCode', enabled: false },
      ],
    });
    expect(out).toContain('Claude Code · claude-sonnet-4-5');
    expect(out).toMatch(/Runners\s+Claude Code\s/);
    expect(out).not.toMatch(/needs one coding agent/i);
  });

  it('says what is missing when nothing can plan yet', () => {
    const out = text();
    expect(out).toMatch(/Claude Code, Codex, OpenCode/);
    expect(out).toContain('/key');
  });

  it('treats a configured API provider as enough to plan', () => {
    const out = text({ plannerProvider: 'openrouter', configuredProviders: ['openrouter'], orchestratorModel: 'x/y' });
    expect(out).toContain('OpenRouter · x/y');
    expect(out).not.toMatch(/needs one coding agent/i);
  });

  it('marks an error turn as an error', () => {
    expect(text({ messages: [{ role: 'error', content: 'it broke', timestamp: '' }] })).toContain('it broke');
  });

  it('renders planner Markdown as terminal-native chat', () => {
    const out = text({
      cols: 100,
      messages: [{
        role: 'assistant', timestamp: '', content: [
          '## What `/auto` does in the TUI',
          '',
          '`/auto` is a **global toggle** for new plans.',
          '',
          '### How it works',
          '',
          '| Command | Effect |',
          '|---|---|',
          '| `/auto` (no args) | Flips the current setting |',
          '| `/auto on` | Sets `ORDEWELL_AUTONOMOUS_MODE=true` |',
        ].join('\n'),
      }],
    });
    expect(out).toContain('What /auto does in the TUI');
    expect(out).toContain('/auto is a global toggle for new plans.');
    expect(out).toContain('How it works');
    expect(out).toContain('Command');
    expect(out).toContain('Effect');
    expect(out).toContain('Flips the current setting');
    expect(out).not.toContain('## What');
    expect(out).not.toContain('**global toggle**');
    expect(out).not.toContain('|---|');
  });

  it('keeps Markdown table rows within a narrow chat pane', () => {
    const out = screen({
      cols: 44,
      messages: [{
        role: 'assistant', timestamp: '', content: [
          '| Command | Effect |',
          '|---|---|',
          '| `/auto on` | Sets `ORDEWELL_AUTONOMOUS_MODE=true` |',
        ].join('\n'),
      }],
    });
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(44);
    expect(out.join('\n')).toContain('ORDEWELL_AUTONOMOUS_MODE');
  });
});

describe('plan pane', () => {
  it('lists the tasks with their numbers', () => {
    const out = text({ tasks });
    expect(out).toContain('Add the login route');
    expect(out).toContain('Write the tests');
  });

  it('distinguishes a manual task from an AI one', () => {
    expect(text({ tasks })).toContain('MAN');
  });

  it('marks the selected task when the plan pane has focus', () => {
    const out = screen({ tasks, focus: 'plan', selectedTask: 1 });
    const line = out.find((l) => stripAnsi(l).includes('Write the tests'));
    expect(stripAnsi(line!)).toMatch(/[❯> ]/);
  });

  it('is hidden when there is no plan', () => {
    expect(text()).not.toMatch(/Plan \d+\/\d+/);
  });

  it('summarises progress', () => {
    expect(text({ tasks })).toMatch(/1\s*\/\s*3/);
  });

  it('shows model and thinking effort in the task list', () => {
    const configured: TaskView[] = [{
      ...tasks[1],
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', thinkingEffort: 'high' },
    }];
    const out = text({ tasks: configured });
    expect(out).toContain('GPT-5');
    expect(out).toContain('effort: high');
  });

  it('expands the selected task to show its complete description and an editable prompt', () => {
    const detailed: TaskView = {
      ...tasks[1],
      description: 'Implement the complete authentication flow with refresh tokens and session rotation.',
      prompt: 'Touch the HTTP handler, persistence adapter, and public contract tests.',
    };
    const out = text({
      rows: 32,
      cols: 100,
      tasks: [detailed],
      focus: 'plan',
      expandedTaskId: detailed.id,
      taskEditor: { text: detailed.prompt!, cursor: detailed.prompt!.length, history: [], historyIndex: 0, draft: '' },
    });
    expect(out).toContain('complete authentication');
    expect(out).toContain('persistence');
    expect(out).toContain('adapter');
    expect(out).toContain('Description');
    expect(out).toContain('Prompt');
  });

  it('keeps the task prompt caret in view when an expanded prompt exceeds the pane', () => {
    const prompt = Array.from({ length: 24 }, (_, index) => `prompt line ${index + 1}`).join('\n');
    const task: TaskView = { ...tasks[0], prompt };
    const out = text({
      rows: 12,
      cols: 80,
      tasks: [task],
      focus: 'plan',
      expandedTaskId: task.id,
      taskEditor: { text: prompt, cursor: prompt.length, history: [], historyIndex: 0, draft: '' },
    });

    expect(out).toContain('prompt line 24');
  });

  it('makes an in-progress task unmistakably active without continuous repaints', () => {
    const running = [{ ...tasks[1], status: 'in_progress' }];
    const out = text({ tasks: running });
    expect(out).not.toContain('▶');
    expect(out).toMatch(/[⠀-⣿]/);
    expect(out).toContain('RUN');
    expect(out).toContain('working');
  });
});

describe('status line', () => {
  it('shows what the planner is doing', () => {
    expect(text({ status: 'planning', busyLabel: 'grep auth' })).toContain('grep auth');
  });

  it('says when a run is in progress', () => {
    expect(text({ status: 'executing', tasks })).toMatch(/executing/i);
  });
});

describe('input line', () => {
  it('shows what has been typed', () => {
    const s = initialState({ rows: 24, cols: 80 });
    const out = render({ ...s, editor: { ...s.editor, text: 'add a login page', cursor: 16 } });
    expect(out.join('\n')).toContain('add a login page');
  });

  it('scrolls a line longer than the terminal so the cursor stays visible', () => {
    const s = initialState({ rows: 24, cols: 40 });
    const long = 'x'.repeat(200);
    const out = render({ ...s, editor: { ...s.editor, text: long, cursor: long.length } });
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(40);
  });

  it('suggests commands while a slash command is being typed', () => {
    const s = initialState({ rows: 24, cols: 80 });
    const out = render({ ...s, editor: { ...s.editor, text: '/gr', cursor: 3 } });
    expect(out.join('\n')).toContain('grill-me');
  });

  it('renders multi-line input on separate rows with continuation prompt', () => {
    const s = initialState({ rows: 24, cols: 80 });
    const out = render({ ...s, editor: { ...s.editor, text: 'line1\nline2\nline3', cursor: 17 } });
    expect(out.join('\n')).toContain('line1');
    expect(out.join('\n')).toContain('line2');
    expect(out.join('\n')).toContain('line3');
    const lines = out.filter((l) => l.includes('line'));
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it('places cursor on the correct line in multi-line input', () => {
    style.enabled = true;
    try {
      const s = initialState({ rows: 24, cols: 80 });
      const out = render({ ...s, editor: { ...s.editor, text: 'first\nsecond', cursor: 7 } });
      const inputLines = out.slice(out.length - 3, out.length - 1);
      expect(inputLines.join('\n')).toContain(style.inverse('e') || 'e');
    } finally {
      style.enabled = false;
    }
  });

  it('handles cursor at the end of multi-line input', () => {
    const s = initialState({ rows: 24, cols: 80 });
    const text = 'line1\nline2';
    const out = render({ ...s, editor: { ...s.editor, text, cursor: text.length } });
    expect(out.join('\n')).toContain('line2');
  });
});

describe('overlays', () => {
  it('draws the picker with its items over the body', () => {
    const out = text({
      overlay: {
        kind: 'picker',
        picker: {
          title: 'Orchestrator model', items: [{ id: 'a/1', label: 'Alpha' }],
          filter: '', index: 0, multi: false, chosen: [], action: { kind: 'set-model' },
        },
      },
    });
    expect(out).toContain('Orchestrator model');
    expect(out).toContain('Alpha');
  });

  it('marks chosen items in a multi-select', () => {
    const out = text({
      overlay: {
        kind: 'picker',
        picker: {
          title: 'Allowed models',
          items: [{ id: 'a/1', label: 'Alpha' }, { id: 'b/2', label: 'Beta' }],
          filter: '', index: 0, multi: true, chosen: ['b/2'], action: { kind: 'set-allowlist', runner: 'opencode' },
        },
      },
    });
    const beta = out.split('\n').find((l) => l.includes('Beta'))!;
    expect(beta).toMatch(/[x✓●]/);
  });

  it('masks the key while it is being typed into the prompt', () => {
    const out = text({
      overlay: {
        kind: 'prompt', title: 'OpenRouter API key', value: 'sk-or-secret',
        action: { kind: 'api-key', provider: 'openrouter', envVar: 'OPENROUTER_API_KEY' },
      },
    });
    expect(out).toContain('OpenRouter API key');
    expect(out).not.toContain('sk-or-secret');
  });

  it('shows a plain prompt value that is not a secret', () => {
    const out = text({
      overlay: { kind: 'prompt', title: 'New task title', value: 'Write docs', action: { kind: 'add-task' } },
    });
    expect(out).toContain('Write docs');
  });

  it('scrolls the help sheet to reach the commands below the fold', () => {
    const top = text({ overlay: { kind: 'help', scroll: 0 }, rows: 24 });
    const down = text({ overlay: { kind: 'help', scroll: 14 }, rows: 24 });
    expect(top).not.toContain('/allowlist');
    expect(down).toContain('/allowlist');
  });

  it('keeps each help entry on a single line so the table stays aligned', () => {
    const lines = screen({ overlay: { kind: 'help', scroll: 6 }, rows: 30, cols: 80 });
    const orphan = lines.find((l) => /^\s*(dependencies|plans|catalogs)\s*$/.test(stripAnsi(l)));
    expect(orphan).toBeUndefined();
  });

  it('says there is more to scroll', () => {
    expect(text({ overlay: { kind: 'help', scroll: 0 }, rows: 24 })).toMatch(/↑↓|more/i);
  });

  it('lists every command in the help sheet', () => {
    const out = text({ overlay: { kind: 'help' }, rows: 60 });
    for (const name of ['/grill-me', '/allowlist', '/key', '/model', '/tdd', '/research-subagents']) {
      expect(out).toContain(name);
    }
  });
});

describe('footer', () => {
  it('advertises help and the pane switch', () => {
    expect(text()).toContain('/help');
    expect(text({ tasks })).toMatch(/tab/i);
  });

  it('shows the task shortcuts when the plan pane has focus', () => {
    const out = text({ tasks, focus: 'plan', cols: 140 });
    expect(out).toMatch(/f start/);
    expect(out).toMatch(/E run plan/);
    expect(out).not.toMatch(/retry/i);
  });

  it('advertises opening a terminal on the selected task', () => {
    expect(text({ tasks, focus: 'plan', cols: 140 })).toMatch(/terminal/i);
  });

  it('wraps the plan hints instead of truncating the tail off a narrow terminal', () => {
    // A single truncated line hid the keys the footer exists to teach.
    const out = render(initialState({ tasks, focus: 'plan', rows: 40, cols: 60 }));

    expect(out.join('\n')).toMatch(/t terminal/);
    expect(out.every((line) => line.length <= 60)).toBe(true);
  });

  it('keeps the frame exactly as tall as the terminal once the footer wraps', () => {
    for (const cols of [60, 100, 140, 200]) {
      expect(render(initialState({ tasks, focus: 'plan', rows: 24, cols })).length).toBe(24);
    }
  });
});

describe('input cursor', () => {
  // The driver hides the hardware cursor, so the frame itself must mark the
  // caret or mid-line edits (left arrow, ctrl-a) would be blind.
  const withColour = (fn: () => void) => {
    style.enabled = true;
    try { fn(); } finally { style.enabled = false; }
  };

  it('marks the character under the cursor', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80 });
      const out = render({ ...s, editor: { ...s.editor, text: 'abcdef', cursor: 2 } });
      const input = out[out.length - 2];
      expect(input).toContain(`ab${style.inverse('c')}def`);
    });
  });

  it('shows a block after the text when the cursor sits at the end', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80 });
      const out = render({ ...s, editor: { ...s.editor, text: 'abc', cursor: 3 } });
      expect(out[out.length - 2]).toContain(`abc${style.inverse(' ')}`);
    });
  });

  it('hides the caret while the plan pane has focus', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80, focus: 'plan' as const, tasks });
      const out = render({ ...s, editor: { ...s.editor, text: 'abc', cursor: 1 } });
      expect(out[out.length - 2]).not.toContain('\x1b[7m');
    });
  });

  it('hides the caret while an overlay is open', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80, overlay: { kind: 'help' as const, scroll: 0 } });
      const out = render({ ...s, editor: { ...s.editor, text: 'abc', cursor: 1 } });
      expect(out[out.length - 2]).not.toContain('\x1b[7m');
    });
  });
});

describe('plan pane scrolling', () => {
  const manyTasks = (n: number): TaskView[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`, order: i + 1, title: `Task number ${i + 1}`,
      type: 'ai' as const, status: 'pending', dependencies: [],
    }));

  it('keeps a mid-plan selection visible when tasks render one line each', () => {
    const out = text({ rows: 15, cols: 80, tasks: manyTasks(30), focus: 'plan', selectedTask: 9 });
    expect(out).toContain('Task number 10');
  });

  it('keeps the last task visible when it is selected', () => {
    const out = text({ rows: 15, cols: 80, tasks: manyTasks(30), focus: 'plan', selectedTask: 29 });
    expect(out).toContain('Task number 30');
  });

  it('planScroll shifts the viewport in the plan pane', () => {
    const out = text({ rows: 15, cols: 80, tasks: manyTasks(30), focus: 'plan', selectedTask: 0, planScroll: 12 });
    expect(out).not.toContain('Task number 1');
    expect(out).toContain('Task number 5');
  });

  it('scrolls above the selected task once the user has taken the viewport over', () => {
    // The delta-on-top-of-the-anchor model this replaces could only ever scroll
    // *down* from the selection, so the first task was unreachable while a task
    // far down the plan was selected.
    const out = text({ rows: 15, cols: 80, tasks: manyTasks(30), focus: 'plan', selectedTask: 29, planScroll: 0 });
    expect(out).toContain('Task number 1');
    expect(out).not.toContain('Task number 30');
  });

  it('follows the selection again once planScroll goes back to null', () => {
    const out = text({ rows: 15, cols: 80, tasks: manyTasks(30), focus: 'plan', selectedTask: 29, planScroll: null });
    expect(out).toContain('Task number 30');
  });
});

describe('chat scrolling', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: 'user' as const, content: `message number ${i + 1}`, timestamp: '',
  }));

  it('follows the tail by default', () => {
    expect(text({ messages })).toContain('message number 40');
  });

  it('reveals older messages when scrolled back', () => {
    const out = text({ messages, scroll: 30 });
    expect(out).not.toContain('message number 40');
    expect(out).toContain('message number 20');
  });

  it('stops at the top instead of scrolling into blank space', () => {
    // With a plan the transcript has no welcome header, so the very first
    // message is the top of the scrollback.
    expect(text({ messages, tasks, scroll: 9999 })).toContain('message number 1');
  });

  it('scrolling all the way back lands on the welcome while planning', () => {
    expect(text({ messages, scroll: 9999 })).toMatch(/Describe a goal/i);
  });
});

describe('plan pane — runner and mode', () => {
  const task = {
    id: 't1', order: 1, title: 'Refactor PlanStore', type: 'ai' as const, status: 'pending',
    dependencies: [], assignedRunner: 'codex', taskMode: 'agent',
    assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high' },
  };

  it('shows the task mode on its row, beside the runner it belongs to', () => {
    const out = render(initialState({ focus: 'plan', tasks: [task], rows: 40, cols: 100 })).join('\n');

    expect(out).toContain('codex');
    expect(out).toMatch(/mode: agent/);
  });

  it('omits the mode line for a manual task, which no runner executes', () => {
    const out = render(initialState({
      focus: 'plan', rows: 40, cols: 100,
      tasks: [{ ...task, type: 'user' as const, taskMode: undefined }],
    })).join('\n');

    expect(out).not.toMatch(/mode:/);
  });

  it('advertises the runner and mode keys in the plan footer', () => {
    const out = render(initialState({ focus: 'plan', tasks: [task], rows: 40, cols: 200 })).join('\n');

    expect(out).toContain('R runner');
    expect(out).toContain('M mode');
  });

  it('lists runner and mode in the expanded task key hints', () => {
    const out = render(initialState({
      focus: 'plan', tasks: [task], rows: 40, cols: 200,
      expandedTaskId: 't1',
      taskEditor: { text: 'do it', cursor: 5, history: [], historyIndex: 0, draft: '' },
    })).join('\n');

    expect(out).toMatch(/R runner/);
    expect(out).toMatch(/M mode/);
  });
});

describe('chat body memo', () => {
  // The body is the expensive part — one Markdown parse plus a string-width
  // pass per message per frame. The memo keys on the (immutable) `messages`
  // array reference, so a spinner tick or a `status_update` flood that never
  // touches `messages` reuses these lines instead of re-parsing every
  // assistant message on each frame. That is what stops arrow-key scrolling on
  // a task from lagging while a six-task plan runs.
  it('returns the same wrapped lines when messages are unchanged', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: '# Heading\nbody wrap here', timestamp: '' }];
    const first = chatBodyLines(messages, 80);
    expect(chatBodyLines(messages, 80)).toBe(first);
  });

  it('recomputes when the messages array reference changes (content changed)', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'hello', timestamp: '' }];
    const first = chatBodyLines(messages, 80);
    const recomputed = chatBodyLines([{ ...messages[0] }, ...messages.slice(1)], 80);
    expect(recomputed).not.toBe(first);
    expect(recomputed.join('\n')).toBe(first.join('\n'));
  });

  it('recomputes when the column width changes', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'x'.repeat(100), timestamp: '' }];
    const at80 = chatBodyLines(messages, 80);
    expect(chatBodyLines(messages, 40)).not.toBe(at80);
  });
});

describe('selection highlight', () => {
  // The rest of this file paints with colour off for legible assertions; the
  // highlight is an escape sequence, so it only exists with colour on.
  const painted = (over: Partial<TuiState>): string[] => {
    style.enabled = true;
    try {
      return render(initialState({ rows: 24, cols: 80, ...over }));
    } finally {
      style.enabled = false;
    }
  };

  const chatty: Partial<TuiState> = {
    tasks,
    messages: Array.from({ length: 30 }, (_, i): ChatMessage => ({
      role: 'user', content: `chat row ${i} with enough text to fill the pane`, timestamp: '',
    })),
  };

  const INVERSE_ON = '\x1b[7m';

  it('paints the selected cells in inverse video', () => {
    const out = painted({ ...chatty, selection: { anchor: { col: 3, row: 7 }, head: { col: 12, row: 7 }, pane: 'chat' } });

    expect(out[6]).toContain(INVERSE_ON);
    // Only the selected row is touched.
    expect(out[5]).not.toContain(INVERSE_ON);
    expect(out[7]).not.toContain(INVERSE_ON);
  });

  it('leaves every row exactly `cols` wide, so the divider cannot shift', () => {
    const plain = painted(chatty);
    const highlighted = painted({
      ...chatty,
      selection: { anchor: { col: 3, row: 6 }, head: { col: 40, row: 9 }, pane: 'chat' },
    });

    for (const line of highlighted) expect(width(line)).toBe(80);
    // Same glyphs underneath — the highlight adds paint, never columns.
    expect(highlighted.map(stripAnsi)).toEqual(plain.map(stripAnsi));
  });

  it('never paints past the pane the drag started in', () => {
    const out = painted({
      ...chatty,
      selection: { anchor: { col: 3, row: 6 }, head: { col: 43, row: 9 }, pane: 'chat' },
    });

    // Column 44 is the divider; nothing from it rightwards may be inverted.
    for (const line of out) {
      const at = line.indexOf(INVERSE_ON);
      if (at === -1) continue;
      expect(width(stripAnsi(line.slice(0, at)))).toBeLessThan(43);
    }
  });
});
