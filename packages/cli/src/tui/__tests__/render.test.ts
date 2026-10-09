import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render } from '../render';
import { bodyRows, chatBodyLines, helpLayout } from '../layout';
import { stripAnsi, style, width } from '../ansi';
import { initialState, type TaskView, type TuiState } from '../state';
import { reduce, type Action } from '../reducer';
import type { ResearchStepOutcome, SessionMessage } from '@ordewell/core';
import { chatOf } from './chat';
import { registerSkillCommands } from '../slash';

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

/** The planner's settled reply, as the session broadcasts it. */
const reply = (content: string): Action => ({
  type: 'sessionMessage', message: { type: 'planner_message', content, timestamp: '2026-09-27T10:00:00.000Z' },
});

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
    for (const line of screen({ cols: 60, tasks, conversation: chatOf(['planner', 'x'.repeat(400)]) })) {
      expect(width(line)).toBeLessThanOrEqual(60);
    }
  });

  it('keeps the pane divider on one display column in every body row', () => {
    const out = screen({
      cols: 100,
      tasks,
      conversation: chatOf(['planner', 'Symbols ❯ ◐ ◆ ✓ and 日本 stay aligned.']),
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
      conversation: chatOf(['planner', 'Emoji ✅ and a family \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466} plus 日本語 and a\ttab.']),
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
    const { conversation } = reduce(initialState({ rows: 24, cols: 100, tasks }), reply(hostile)).state;

    for (const line of screen({ cols: 100, tasks, conversation })) {
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
    const state = reduce(planned, reply(hostile)).state;

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
    const on = text({ skills: { ...initialState().skills, verify: true } });
    expect(on).toContain('● verify');
  });

  it('names the autonomy level, Full or Guarded', () => {
    expect(text({ autonomous: true })).toContain('Full');
    const auto = text({ autonomous: false });
    expect(auto).toContain('Guarded');
    expect(auto).not.toContain('Full');
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
    const out = text({ conversation: chatOf(['planner', 'Which database?']) });
    expect(out).toContain('Which database?');
  });

  it('drops the oldest messages when the pane is full rather than overflowing', () => {
    const out = text({ conversation: chatOf(...Array.from({ length: 60 }, (_, i): ['user', string] => ['user', `message ${i}`])) });
    expect(out).toContain('message 59');
    expect(out).not.toContain('message 0');
  });

  it('invites the user to start when there is nothing yet', () => {
    expect(text()).toMatch(/describe|goal|start/i);
  });

  it('keeps the welcome hints until a real conversation starts', () => {
    const out = text({ conversation: chatOf(['system', 'Refreshed runners.']) });
    expect(out).toMatch(/describe|goal/i);
    expect(out).toContain('Refreshed runners.');
  });

  it('keeps the welcome above the conversation while no plan exists', () => {
    const out = text({ conversation: chatOf(['planner', 'Which database?']) });
    expect(out).toMatch(/Describe a goal/i);
    expect(out).toContain('Which database?');
  });

  it('keeps the welcome on the top body row with zero or one message', () => {
    const none = screen({ rows: 40 }).map(stripAnsi);
    const one = screen({ rows: 40, conversation: chatOf(['system', 'hello there']) }).map(stripAnsi);
    const firstRow = none.findIndex((l, i) => i > 0 && /\S/.test(l));
    expect(firstRow).toBeLessThan(4);
    expect(one[firstRow]).toBe(none[firstRow]);
  });

  it('puts the newest message on the last body row once the chat overflows', () => {
    const conversation = chatOf(...Array.from({ length: 60 }, (_, i): ['user', string] => ['user', `message ${i + 1}`]));
    const rows = screen({ rows: 24, conversation }).map(stripAnsi);
    const last = rows.map((l, i) => (l.includes('message 60') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(last).toBeGreaterThan(rows.length - 8);
  });

  it('top-anchors the remaining messages once a plan replaces the welcome', () => {
    const rows = screen({ rows: 24, tasks, conversation: chatOf(['planner', 'Which database?']) }).map(stripAnsi);
    const at = rows.findIndex((l) => l.includes('Which database?'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(6);
  });

  it('drops the welcome once a plan is produced', () => {
    const out = text({ tasks, conversation: chatOf(['planner', 'Which database?']) });
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
    expect(text({ conversation: chatOf(['error', 'it broke']) })).toContain('it broke');
  });

  it('renders planner Markdown as terminal-native chat', () => {
    const out = text({
      cols: 100,
      conversation: chatOf(['planner', [
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
      ].join('\n')]),
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
      conversation: chatOf(['planner', [
        '| Command | Effect |',
        '|---|---|',
        '| `/auto on` | Sets `ORDEWELL_AUTONOMOUS_MODE=true` |',
      ].join('\n')]),
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
    const out = render({ ...s, editor: { ...s.editor, text: '/term', cursor: 5 } });
    expect(out.join('\n')).toContain('terminal');
  });

  describe('mid-prompt skill suggestions', () => {
    afterEach(() => registerSkillCommands([]));

    it('suggests a discovered skill for a token typed mid-prompt', () => {
      registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
      const s = initialState({ rows: 24, cols: 80 });
      const text = 'explain this bug /gri';
      const out = render({ ...s, editor: { ...s.editor, text, cursor: text.length } });
      expect(out.join('\n')).toContain('grilling');
    });

    it('does not suggest a built-in command for a token typed mid-prompt', () => {
      const s = initialState({ rows: 24, cols: 80 });
      const text = 'explain this bug /te';
      const out = render({ ...s, editor: { ...s.editor, text, cursor: text.length } });
      expect(out.join('\n')).not.toContain('terminal');
    });

    it('shows no hint once the caret has moved past the token', () => {
      registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
      const s = initialState({ rows: 24, cols: 80 });
      const text = 'explain /grilling to me';
      const out = render({ ...s, editor: { ...s.editor, text, cursor: text.length } });
      const occurrences = out.join('\n').split('grilling').length - 1;
      expect(occurrences).toBe(1); // the typed token itself, no repeated hint
    });
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

  describe('the rewind confirmation', () => {
    const rewindOverlay = (quote: string, index = 0): TuiState['overlay'] => ({
      kind: 'confirm',
      title: 'Rewind',
      message: 'Confirm you want to restore to the point before you sent this message:',
      quote,
      note: 'The conversation will be forked.\nThe code will be unchanged.',
      action: { kind: 'rewind', index: 4 },
      choice: {
        options: [{ label: 'Restore Conversation', confirms: true }, { label: 'Never mind', confirms: false }],
        index,
      },
    });
    const lines = (over: Partial<TuiState>) => screen(over).map((l) => stripAnsi(l).trimEnd());

    it('reads as the popup the user was promised, wording and all', () => {
      const out = lines({ overlay: rewindOverlay('Make it stream\nand resumable') });
      const at = out.findIndex((l) => l.includes('Confirm you want to restore'));

      expect(out.some((l) => l.startsWith('┌─ Rewind'))).toBe(true);
      expect(out.slice(at, at + 12).map((l) => l.trim())).toEqual([
        'Confirm you want to restore to the point before you sent this message:',
        '',
        '│ Make it stream',
        '│ and resumable',
        '',
        'The conversation will be forked.',
        'The code will be unchanged.',
        '',
        '❯ 1. Restore Conversation',
        '2. Never mind',
        '',
        expect.stringMatching(/^↑↓ move · .*esc/),
      ]);
    });

    it('moves the caret to the highlighted option', () => {
      const out = lines({ overlay: rewindOverlay('hi', 1) }).map((l) => l.trim());

      expect(out).toContain('1. Restore Conversation');
      expect(out).toContain('❯ 2. Never mind');
    });

    it('wraps a long message inside the pane, keeping the gutter on every row', () => {
      const out = lines({ cols: 50, overlay: rewindOverlay('word '.repeat(30).trim()) });
      const quoted = out.filter((l) => l.trim().startsWith('│'));

      expect(quoted.length).toBeGreaterThan(2);
      for (const l of quoted) expect(width(l)).toBeLessThanOrEqual(50);
    });

    it('caps a long message with an ellipsis line and still shows the options', () => {
      const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
      const out = lines({ overlay: rewindOverlay(long) }).map((l) => l.trim());

      expect(out).toContain('│ line 1');
      expect(out).not.toContain('│ line 40');
      expect(out).toContain('│ …');
      expect(out).toContain('❯ 1. Restore Conversation');
      expect(out).toContain('2. Never mind');
    });

    it('does not add an ellipsis to a message that fits', () => {
      expect(lines({ overlay: rewindOverlay('short\nand sweet') }).join('\n')).not.toContain('│ …');
    });
  });

  it('draws the existing confirms as before: message and the enter/esc hint', () => {
    const out = text({ overlay: { kind: 'confirm', title: 'Remove?', message: 'Sure?', action: { kind: 'remove-task', taskId: 't1' } } });

    expect(out).toContain('Remove?');
    expect(out).toContain('Sure?');
    expect(out).toContain('enter confirms · esc cancels');
    expect(out).not.toContain('1. ');
  });

  it('scrolls the help sheet to reach the commands below the fold', () => {
    const top = text({ overlay: { kind: 'help', scroll: 0 }, rows: 24 });
    const down = text({ overlay: { kind: 'help', scroll: 14 }, rows: 24 });
    expect(top).not.toContain('/allowlist');
    expect(down).toContain('/allowlist');
  });

  it('names the conversation commands in the help sheet', () => {
    const sheet = helpLayout(200, 120).lines.map(stripAnsi).join('\n');
    for (const command of ['/fork', '/rewind', '/compact']) expect(sheet).toContain(command);
  });

  it('names the detail-all toggle in the help sheet', () => {
    const sheet = helpLayout(200, 120).lines.map(stripAnsi).join('\n');
    expect(sheet).toContain('ctrl-o toggles full detail');
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
    for (const name of ['/verify', '/allowlist', '/key', '/model']) {
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
  // Located by the prompt glyph rather than a fixed offset from the end: the
  // footer wraps when its hints overflow, and the input row moves with it.
  const inputRow = (out: string[]): string => out.reduce((found, row) => (row.includes('❯') ? row : found), '');

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
      const input = inputRow(out);
      expect(input).toContain(`ab${style.inverse('c')}def`);
    });
  });

  it('shows a block after the text when the cursor sits at the end', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80 });
      const out = render({ ...s, editor: { ...s.editor, text: 'abc', cursor: 3 } });
      expect(inputRow(out)).toContain(`abc${style.inverse(' ')}`);
    });
  });

  it('hides the caret while the plan pane has focus', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80, focus: 'plan' as const, tasks });
      const out = render({ ...s, editor: { ...s.editor, text: 'abc', cursor: 1 } });
      expect(inputRow(out)).not.toContain('\x1b[7m');
    });
  });

  it('hides the caret while an overlay is open', () => {
    withColour(() => {
      const s = initialState({ rows: 24, cols: 80, overlay: { kind: 'help' as const, scroll: 0 } });
      const out = render({ ...s, editor: { ...s.editor, text: 'abc', cursor: 1 } });
      expect(inputRow(out)).not.toContain('\x1b[7m');
    });
  });

  describe('skill token colouring', () => {
    afterEach(() => registerSkillCommands([]));

    it('colours a matched skill command token', () => {
      withColour(() => {
        registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
        const s = initialState({ rows: 24, cols: 80 });
        const out = render({ ...s, editor: { ...s.editor, text: '/grilling ', cursor: 10 } });
        expect(inputRow(out)).toContain(style.cyan('/grilling'));
      });
    });

    it('does not colour an unmatched token', () => {
      withColour(() => {
        const s = initialState({ rows: 24, cols: 80 });
        const out = render({ ...s, editor: { ...s.editor, text: '/foo', cursor: 0 } });
        expect(inputRow(out)).not.toContain(style.cyan('/foo'));
      });
    });

    it('does not colour a built-in command token', () => {
      withColour(() => {
        const s = initialState({ rows: 24, cols: 80 });
        const out = render({ ...s, editor: { ...s.editor, text: '/help', cursor: 0 } });
        expect(inputRow(out)).not.toContain(style.cyan('/help'));
      });
    });

    it('colours a live-typed prefix of a discovered skill, before it is exact', () => {
      withColour(() => {
        registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
        const s = initialState({ rows: 24, cols: 80 });
        const out = render({ ...s, editor: { ...s.editor, text: '/gri', cursor: 4 } });
        expect(inputRow(out)).toContain(style.cyan('/gri'));
      });
    });

    it('does not colour a token that has diverged from every skill name', () => {
      withColour(() => {
        registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
        const s = initialState({ rows: 24, cols: 80 });
        const out = render({ ...s, editor: { ...s.editor, text: '/grix', cursor: 5 } });
        expect(inputRow(out)).not.toContain(style.cyan('/grix'));
      });
    });

    it('colours a skill token typed in the middle of a longer prompt, not just a leading one', () => {
      withColour(() => {
        registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
        const s = initialState({ rows: 24, cols: 80 });
        const text = 'explain this bug /grilling please';
        const out = render({ ...s, editor: { ...s.editor, text, cursor: text.length } });
        expect(inputRow(out)).toContain(style.cyan('/grilling'));
      });
    });

    it('keeps the caret column unchanged with and without colouring', () => {
      registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
      try {
        const s = initialState({ rows: 24, cols: 80 });

        style.enabled = false;
        const plain = stripAnsi(render({ ...s, editor: { ...s.editor, text: '/grilling', cursor: 3 } })[24 - 2]);

        style.enabled = true;
        const coloured = stripAnsi(render({ ...s, editor: { ...s.editor, text: '/grilling', cursor: 3 } })[24 - 2]);

        expect(coloured).toBe(plain);
      } finally {
        style.enabled = false;
      }
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

  it('shows the selection when nothing has positioned the viewport yet', () => {
    const out = text({ rows: 15, cols: 80, tasks: manyTasks(30), focus: 'plan', selectedTask: 29, planScroll: null });
    expect(out).toContain('Task number 30');
  });
});

describe('chat scrolling', () => {
  const conversation = chatOf(...Array.from({ length: 40 }, (_, i): ['user', string] => ['user', `message number ${i + 1}`]));

  it('follows the tail by default', () => {
    expect(text({ conversation })).toContain('message number 40');
  });

  it('reveals older messages when scrolled back', () => {
    const out = text({ conversation, scroll: 30 });
    expect(out).not.toContain('message number 40');
    expect(out).toContain('message number 20');
  });

  it('stops at the top instead of scrolling into blank space', () => {
    // With a plan the transcript has no welcome header, so the very first
    // message is the top of the scrollback.
    expect(text({ conversation, tasks, scroll: 9999 })).toContain('message number 1');
  });

  it('scrolling all the way back lands on the welcome while planning', () => {
    expect(text({ conversation, scroll: 9999 })).toMatch(/Describe a goal/i);
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
  // pass per message per frame. The memo keys on the conversation's `blocks`
  // array, which core hands back unchanged for anything that changes nothing,
  // so a spinner tick or a `status_update` flood reuses these lines instead of
  // re-parsing every planner message on each frame.
  it('returns the same wrapped lines when the blocks are unchanged', () => {
    const { blocks } = chatOf(['planner', '# Heading\nbody wrap here']);
    const first = chatBodyLines(blocks, 80, false);
    expect(chatBodyLines(blocks, 80, false)).toBe(first);
  });

  it('recomputes when the blocks array reference changes (content changed)', () => {
    const { blocks } = chatOf(['planner', 'hello']);
    const first = chatBodyLines(blocks, 80, false);
    const recomputed = chatBodyLines([{ ...blocks[0] }, ...blocks.slice(1)], 80, false);
    expect(recomputed).not.toBe(first);
    expect(recomputed.join('\n')).toBe(first.join('\n'));
  });

  it('recomputes when the column width changes', () => {
    const { blocks } = chatOf(['planner', 'x'.repeat(100)]);
    const at80 = chatBodyLines(blocks, 80, false);
    expect(chatBodyLines(blocks, 40, false)).not.toBe(at80);
  });

  it('recomputes when the detail-all switch flips', () => {
    const { blocks } = chatOf(['planner', 'hello']);
    const collapsed = chatBodyLines(blocks, 80, false);
    expect(chatBodyLines(blocks, 80, true)).not.toBe(collapsed);
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
    conversation: chatOf(...Array.from({ length: 30 }, (_, i): ['user', string] => ['user', `chat row ${i} with enough text to fill the pane`])),
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

// ── The conversation's blocks (#52) ─────────────────────────────────────────

/** A state that has heard these session messages, at a pane `cols` wide. */
function heard(cols: number, ...messages: SessionMessage[]): TuiState {
  return messages.reduce((s, message) => reduce(s, { type: 'sessionMessage', message }).state, initialState({ rows: 40, cols }));
}

/** The same state with the detail-all switch on. */
const detailed = (state: TuiState): TuiState => ({ ...state, detailAll: true });

/** The painted rows of the block whose first row starts with `head`, up to the blank row after it. */
function blockRows(state: TuiState, head: string): string[] {
  const rows = render(state).map((row) => stripAnsi(row).trimEnd());
  const start = rows.findIndex((row) => row.startsWith(head));
  if (start < 0) throw new Error(`no row starts with "${head}" in:\n${rows.join('\n')}`);
  const end = rows.indexOf('', start);
  return rows.slice(start, end < 0 ? undefined : end);
}

const bash = (command: string, toolCallId = 'tc-1'): SessionMessage =>
  ({ type: 'research_step', tool: 'bash', args: JSON.stringify({ command }), toolCallId });

const ran = (command: string, result: string, outcome: ResearchStepOutcome = 'success', toolCallId = 'tc-1'): SessionMessage => ({
  type: 'research_step_done',
  step: {
    id: `rs-${toolCallId}`, tool: 'bash', args: JSON.stringify({ command }), result, success: outcome === 'success', outcome,
    toolCallId, timestamp: '2026-09-27T10:00:00.000Z',
  },
});

/** 215 lines of `gh issue view` output. */
const ISSUES = ['=== #47 ===', 'Planner view: a transparent, streaming conversation', 'line 3', ...Array.from({ length: 212 }, (_, i) => `line ${i + 4}`)].join('\n');

const LOOP = 'for i in 47 48 49 50 51 52 53; do gh issue view $i; done';

describe('command rows', () => {
  it('draws a command as its header over a three-line preview, noting what the preview hides', () => {
    const state = heard(80, bash('gh issue view 47'), ran('gh issue view 47', ISSUES));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(gh issue view 47)',
      '  ⎿  === #47 ===',
      '     Planner view: a transparent, streaming conversation',
      '     line 3',
      '     … +212 lines (ctrl+o to expand)',
    ]);
  });

  it('cuts the argument, not the tool name or the closing parenthesis, to fit a 40-column pane', () => {
    const state = heard(40, bash(LOOP), ran(LOOP, ISSUES));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(for i in 47 48 49 50 51 52 53; …)',
      '  ⎿  === #47 ===',
      '     Planner view: a transparent, strea…',
      '     line 3',
      '     … +212 lines (ctrl+o to expand)',
    ]);
  });

  it('cuts a path from the left, at a directory, so the file it names stays in view', () => {
    const path = '/home/dev/app/.ordewell/worktrees/3c3de77a/2-a-task/packages/core/src/conversation/taskLog.ts';
    const args = JSON.stringify({ path });
    const state = heard(40,
      { type: 'research_step', tool: 'read_file', args, toolCallId: 'tc-1' },
      { type: 'research_step_done', step: { id: 'rs-tc-1', tool: 'read_file', args, result: 'export {}', success: true, outcome: 'success', toolCallId: 'tc-1', timestamp: '2026-09-27T10:00:00.000Z' } });

    expect(blockRows(state, '●')[0]).toBe('● Read(…/src/conversation/taskLog.ts)');
  });

  it('cuts a URL from the right, keeping the host', () => {
    const url = 'https://docs.example.com/guides/structured-transport/codex/file-changes';
    const args = JSON.stringify({ url });
    const state = heard(40,
      { type: 'research_step', tool: 'fetch', args, toolCallId: 'tc-1' },
      { type: 'research_step_done', step: { id: 'rs-tc-1', tool: 'fetch', args, result: 'ok', success: true, outcome: 'success', toolCallId: 'tc-1', timestamp: '2026-09-27T10:00:00.000Z' } });

    expect(blockRows(state, '●')[0]).toBe('● Fetch(https://docs.example.com/guide…)');
  });

  it('shows the whole header and preview when a 120-column pane has room', () => {
    const state = heard(120, bash(LOOP), ran(LOOP, ISSUES));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(for i in 47 48 49 50 51 52 53; do gh issue view $i; done)',
      '  ⎿  === #47 ===',
      '     Planner view: a transparent, streaming conversation',
      '     line 3',
      '     … +212 lines (ctrl+o to expand)',
    ]);
  });

  it('keeps a multi-line command to one header row, counting the lines it leaves out', () => {
    const heredoc = "cat <<'EOF' > notes.md\n# Notes\nline two\nEOF";
    const state = heard(80, bash(heredoc), ran(heredoc, 'wrote notes.md'));

    expect(blockRows(state, '●')).toEqual([
      "● Bash(cat <<'EOF' > notes.md … +3 lines)",
      '  ⎿  wrote notes.md',
    ]);
  });

  it('says so when a command printed nothing', () => {
    const state = heard(80, bash('touch notes.md'), ran('touch notes.md', ''));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(touch notes.md)',
      '  ⎿  (no output)',
    ]);
  });

  it('shows a failed command as one error line, in place of the preview', () => {
    const state = heard(80, bash('npm test'), ran('npm test', 'FAIL src/a.test.ts\n  expected 1 to be 2\n  at a.test.ts:3', 'failure'));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(npm test)',
      '  ⎿  Error: FAIL src/a.test.ts',
    ]);
  });

  const refused = () => heard(80, bash('rm -rf build'), ran('rm -rf build', "Command refused: writes are the runners' job.", 'refused'));
  const denied = () => heard(80, bash('curl example.com'), ran('curl example.com', 'Denied by the user.', 'denied'));
  const stopped = () => heard(80, bash('npm test'), { type: 'planner_turn_ended', turnId: 't1', outcome: 'stopped' });

  it('shows a refused, a denied and an interrupted command each as one status line', () => {
    expect(blockRows(refused(), '●')).toEqual(['● Bash(rm -rf build)', "  ⎿  Refused: Command refused: writes are the runners' job."]);
    expect(blockRows(denied(), '●')).toEqual(['● Bash(curl example.com)', '  ⎿  Denied: Denied by the user.']);
    expect(blockRows(stopped(), '●')).toEqual(['● Bash(npm test)', '  ⎿  Interrupted']);
  });

  it('paints a status line as the outcome marks were: failure red, refusal and denial yellow, interruption grey', () => {
    const failed = heard(80, bash('npm test'), ran('npm test', 'FAIL', 'failure'));
    const row = (state: TuiState, label: string): string => {
      style.enabled = true;
      try {
        return render(state).find((line) => stripAnsi(line).includes(`⎿  ${label}`)) ?? '';
      } finally {
        style.enabled = false;
      }
    };

    expect(row(failed, 'Error')).toContain('\x1b[31mError: FAIL');
    expect(row(refused(), 'Refused')).toContain('\x1b[33mRefused:');
    expect(row(denied(), 'Denied')).toContain('\x1b[33mDenied:');
    expect(row(stopped(), 'Interrupted')).toContain('\x1b[90mInterrupted');
  });

  it('marks a command still running', () => {
    const state = heard(80, bash('npm test'));

    expect(blockRows(state, '○ Bash')).toEqual([
      '○ Bash(npm test)',
      '  ⎿  Running…',
    ]);
  });

  it('never paints a row wider than the pane, at any width', () => {
    for (const cols of [8, 12, 20, 40, 80]) {
      for (const row of render(heard(cols, bash(LOOP), ran(LOOP, ISSUES)))) expect(width(row)).toBeLessThanOrEqual(cols);
      for (const row of render(detailed(heard(cols, bash(LOOP), ran(LOOP, ISSUES))))) expect(width(row)).toBeLessThanOrEqual(cols);
    }
  });
});

describe('command rows in full detail', () => {
  it('shows the full arguments and the full output, wrapped to the pane', () => {
    const loop = 'for i in 47 48 49; do\n  gh issue view $i --json title\ndone';
    const output = '=== #47 ===\nPlanner view: a transparent, streaming conversation that wraps\nline 3\nline 4';
    const state = detailed(heard(50, bash(loop), ran(loop, output)));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(for i in 47 48 49; do … +2 lines)',
      '     command: for i in 47 48 49; do',
      '       gh issue view $i --json title',
      '     done',
      '  ⎿  === #47 ===',
      '     Planner view: a transparent, streaming',
      '     conversation that wraps',
      '     line 3',
      '     line 4',
      '     … (ctrl+o to collapse)',
    ]);
  });

  it('wraps a header too long for the pane instead of cutting it', () => {
    const state = detailed(heard(40, bash(LOOP), ran(LOOP, 'ok')));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(for i in 47 48 49 50 51 52 53; do',
      '  gh issue view $i; done)',
      '     command: for i in 47 48 49 50 51 52',
      '     53; do gh issue view $i; done',
      '  ⎿  ok',
    ]);
  });

  it('shows every line of a long output, with the expand note flipped to its collapse hint', () => {
    const tall = { ...heard(80, bash('gh issue view 47'), ran('gh issue view 47', ISSUES)), rows: 260 };
    const rows = blockRows(detailed(tall), '●');

    expect(rows).toHaveLength(1 + 1 + 215 + 1);
    expect(rows.at(-1)).toBe('     … (ctrl+o to collapse)');
  });

  it('appends no collapse note to an output the preview would have shown whole', () => {
    const short = heard(80, bash('ls'), ran('ls', 'src\n'));
    const rows = blockRows(detailed(short), '●');

    expect(rows).toEqual(['● Bash(ls)', '     command: ls', '  ⎿  src']);
    expect(rows.join('\n')).not.toContain('ctrl+o');
  });

  it('keeps the status line of a failure, followed by the rest of what it printed', () => {
    const state = detailed(heard(80, bash('npm test'), ran('npm test', 'FAIL src/a.test.ts\n  expected 1 to be 2', 'failure')));

    expect(blockRows(state, '●')).toEqual([
      '● Bash(npm test)',
      '     command: npm test',
      '  ⎿  Error: FAIL src/a.test.ts',
      '       expected 1 to be 2',
    ]);
  });
});

describe('thinking', () => {
  const thought = (text: string): SessionMessage => ({ type: 'planner_thinking_delta', turnId: 't1', segmentId: 's1', text });
  const ended: SessionMessage = { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' };

  it('collapses to one line that counts its words', () => {
    const state = heard(80, thought('Reading the auth module.\nNext, the session store'), ended);

    expect(blockRows(state, '∴')).toEqual(['∴ Thinking (8 words)']);
  });

  it('shows its latest line while it streams, the newest words kept when the row is short', () => {
    const streaming = [thought('Reading the auth module.\n'), thought('Next, the session store')];

    expect(blockRows(heard(80, ...streaming), '∴')).toEqual(['∴ Thinking (8 words) · Next, the session store']);
    expect(blockRows(heard(40, ...streaming), '∴')).toEqual(['∴ Thinking (8 words) · …he session store']);
  });

  it('shows the whole text in full detail', () => {
    const state = detailed(heard(40, thought('Reading the auth module.\nNext, the session store and then the cookie jar'), ended));

    expect(blockRows(state, '∴')).toEqual([
      '∴ Thinking (13 words)',
      '  Reading the auth module.',
      '  Next, the session store and then the',
      '  cookie jar',
    ]);
  });

  it('is dim, collapsed or not', () => {
    style.enabled = true;
    try {
      const collapsed = heard(80, thought('one word'), ended);
      const row = render(collapsed).find((line) => stripAnsi(line).startsWith('∴')) ?? '';
      expect(row.startsWith('\x1b[90m')).toBe(true);
    } finally {
      style.enabled = false;
    }
  });
});

describe('subagents', () => {
  const started: SessionMessage = { type: 'subagent_started', subagentId: 'sa1', brief: 'Find the auth handlers\nLook in src/ only.' };
  const grep: SessionMessage = { type: 'research_step', subagentId: 'sa1', tool: 'grep', args: '{"pattern":"auth"}', toolCallId: 'c1' };
  const grepped: SessionMessage = {
    type: 'research_step_done', subagentId: 'sa1',
    step: { id: 'r1', tool: 'grep', args: '{"pattern":"auth"}', result: 'src/auth.ts:3', success: true, outcome: 'success', toolCallId: 'c1', subagentId: 'sa1', timestamp: '' },
  };
  const read: SessionMessage = { type: 'research_step', subagentId: 'sa1', tool: 'read_file', args: '{"path":"src/auth.ts"}', toolCallId: 'c2' };
  const finished: SessionMessage = {
    type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'Found 3 handlers in src/auth.ts\nDetails follow.',
  };

  it('is one line with its brief, and its step count while it runs', () => {
    expect(blockRows(heard(80, started, grep, grepped, read), '◆')).toEqual(['◆ Agent: Find the auth handlers  running · 2 steps']);
  });

  it('ends with its status and the first line of what it handed back', () => {
    expect(blockRows(heard(80, started, grep, grepped, finished), '◆')).toEqual([
      '◆ Agent: Find the auth handlers  done · Found 3 handlers in src/auth.ts',
    ]);
  });

  it('keeps the status when the pane is narrow, letting the digest go first', () => {
    expect(blockRows(heard(40, started, grep, grepped, finished), '◆')).toEqual(['◆ Agent: Find the auth handlers  done']);
  });

  it('shows its children indented beneath it, and all it handed back, in full detail', () => {
    expect(blockRows(detailed(heard(80, started, grep, grepped, finished)), '◆')).toEqual([
      '◆ Agent: Find the auth handlers  done · Found 3 handlers in src/auth.ts',
      '    ● Grep(auth)',
      '         pattern: auth',
      '      ⎿  src/auth.ts:3',
      '  ⎿  Found 3 handlers in src/auth.ts',
      '     Details follow.',
    ]);
  });
});

describe('approvals', () => {
  const asked: SessionMessage = { type: 'approval_request', id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test' };

  it('is one line that says where the request stands', () => {
    // Its modal covers the pane while it is up; behind another request's, the line shows.
    expect(blockRows({ ...heard(80, asked), overlay: null }, '?')).toEqual(['? Waiting for you · Run a command: npm test']);
    expect(blockRows(heard(80, asked, { type: 'approval_settled', id: 'ap-1', granted: true }), '✓')).toEqual(['✓ Approved · Run a command: npm test']);
    expect(blockRows(heard(80, asked, { type: 'approval_settled', id: 'ap-1', granted: false }), '⊘')).toEqual(['⊘ Denied · Run a command: npm test']);
  });

  it('names the policy behind a decision nobody was asked about', () => {
    const decided = (granted: boolean, source: 'pre-approved' | 'mode'): SessionMessage => ({
      type: 'approval_decided', kind: 'url_fetch', subject: 'https://example.com', scope: 'example.com', granted, source,
    });

    expect(blockRows(heard(80, decided(true, 'pre-approved')), '✓')).toEqual(['✓ Auto-approved (pre-approved) · Fetch a URL: https://example.com']);
    expect(blockRows(heard(80, decided(false, 'mode')), '⊘')).toEqual(['⊘ Auto-denied (policy) · Fetch a URL: https://example.com']);
  });
});

describe('plan markers', () => {
  // `turnId` is the planner turn whose commit the broadcast carries.
  const plan = (content: string, turnId?: string): SessionMessage => ({
    type: 'plan_generated',
    goal: 'g',
    runners: [],
    plan: {
      tasks: [], runners: [], generatedAt: '',
      conversationHistory: [{ role: 'assistant', content, timestamp: '2026-09-27T10:00:00.000Z', kind: 'plan_generated' }],
    },
    ...(turnId ? { turnId } : {}),
  });

  it('reads "Building plan…" while the plan streams', () => {
    expect(blockRows(heard(80, { type: 'plan_token', turnId: 't1', token: '{"tasks":' }), '◇')).toEqual(['◇ Building plan…']);
  });

  it('then says what the plan became, and how many tasks it has', () => {
    const building: SessionMessage = { type: 'plan_token', turnId: 't1', token: '{"tasks":' };

    expect(blockRows(heard(80, building, plan('Plan generated with 2 tasks.', 't1')), '◇')).toEqual(['◇ Plan generated (2 tasks)']);
    expect(blockRows(heard(80, plan('Plan updated — now 1 task.')), '◇')).toEqual(['◇ Plan updated (1 task)']);
  });
});

describe('the token line', () => {
  const usage = (over: Partial<Extract<SessionMessage, { type: 'planner_usage' }>> = {}): SessionMessage => ({
    type: 'planner_usage', totals: { inputTokens: 12_400, outputTokens: 3_100 }, ...over,
  });
  /** The chat pane's bottom row: the last body row, just above the status row. */
  const bottomRow = (state: TuiState): string => stripAnsi(render(state)[bodyRows(state)]).trimEnd();

  it('sits on the chat pane\'s bottom row with the totals and how full the context is', () => {
    const state = heard(80, { type: 'planner_message', content: 'Which database?', timestamp: '' }, usage({ contextFill: { usedTokens: 36_000, windowTokens: 200_000 } }));

    expect(bottomRow(state)).toBe('12.4k in · 3.1k out · 18% ctx');
  });

  it('leaves out the context fill when the window is unknown', () => {
    expect(bottomRow(heard(80, usage()))).toBe('12.4k in · 3.1k out');
  });

  it('shows a cost only when one was reported', () => {
    const state = heard(80, usage({ totals: { inputTokens: 12_400, outputTokens: 3_100, reportedCost: { usd: 0.42 } }, contextFill: { usedTokens: 36_000, windowTokens: 200_000 } }));

    expect(bottomRow(state)).toBe('12.4k in · 3.1k out · 18% ctx · $0.42');
  });

  it('counts what subagents used in the total', () => {
    const state = heard(80, usage({ totals: { inputTokens: 1_500, outputTokens: 200 }, bySubagent: { sa1: { inputTokens: 500, outputTokens: 100 } } }));

    expect(bottomRow(state)).toBe('1.5k in · 200 out');
  });

  it('stays put while the transcript scrolls back beneath it', () => {
    const long = heard(80, ...Array.from({ length: 40 }, (_, i): SessionMessage => ({ type: 'planner_message', content: `reply ${i}`, timestamp: '' })), usage());
    const back = reduce(long, { type: 'key', key: { name: 'pageup' } }).state;

    expect(back.scroll).toBeGreaterThan(0);
    expect(bottomRow(back)).toBe('12.4k in · 3.1k out');
    expect(render(back).map(stripAnsi).join('\n')).not.toContain('reply 39');
  });

  it('takes no row until usage is reported', () => {
    const state = heard(80, ...Array.from({ length: 40 }, (_, i): SessionMessage => ({ type: 'planner_message', content: `reply ${i}`, timestamp: '' })));

    expect(bottomRow(state)).toBe('');
    expect(stripAnsi(render(state)[bodyRows(state) - 1])).toContain('reply 39');
  });
});

describe('streamed replies', () => {
  const delta = (text: string, segmentId = 's1'): SessionMessage => ({ type: 'planner_text_delta', turnId: 't1', segmentId, text });
  const hear = (state: TuiState, message: SessionMessage): TuiState => reduce(state, { type: 'sessionMessage', message }).state;

  it('grow in place, on the rows they started on', () => {
    const started = heard(80, { type: 'planner_turn_started', turnId: 't1', prompt: 'Add rate limiting' }, delta('Checking the '));
    const grown = hear(started, delta('**auth** module'));
    const rowOf = (state: TuiState) => render(state).map((r) => stripAnsi(r).trimEnd()).findIndex((r) => r.startsWith('◆'));

    expect(blockRows(started, '◆')).toEqual(['◆ Checking the']);
    expect(blockRows(grown, '◆')).toEqual(['◆ Checking the auth module']);
    expect(rowOf(grown)).toBe(rowOf(started));
  });

  it('drop an attempt the turn took back, and show the one that replaced it', () => {
    const attempt = heard(80, { type: 'planner_turn_started', turnId: 't1', prompt: 'Add rate limiting' }, delta('A first attempt that went wrong'));
    const retracted = hear(attempt, { type: 'planner_text_retracted', turnId: 't1' });
    const retried = hear(retracted, delta('The corrected answer', 's2'));
    const screenOf = (state: TuiState) => render(state).map(stripAnsi).join('\n');

    expect(screenOf(attempt)).toContain('A first attempt that went wrong');
    expect(screenOf(retracted)).not.toContain('A first attempt that went wrong');
    expect(screenOf(retried)).not.toContain('A first attempt that went wrong');
    expect(blockRows(retried, '◆')).toEqual(['◆ The corrected answer']);
  });
});

describe('a reloaded session', () => {
  const at = (second: number) => `2026-09-27T10:00:${String(second).padStart(2, '0')}.000Z`;
  const read = { id: 'r1', tool: 'read_file' as const, args: '{"path":"src/app.ts"}', result: 'import express from "express";\nconst app = express();', success: true, outcome: 'success' as const, toolCallId: 'c1', timestamp: at(2) };
  const grep = { id: 'r3', tool: 'grep' as const, args: '{"pattern":"app.use"}', result: 'src/mw.ts:4', success: true, outcome: 'success' as const, toolCallId: 'c3', subagentId: 'sa-1', timestamp: at(4) };
  const spawn = { id: 'r2', tool: 'spawn_research_agent' as const, args: '{"prompt":"Find the middleware"}', result: 'Middleware lives in src/mw.ts', success: true, outcome: 'success' as const, toolCallId: 'c2', timestamp: at(6) };
  const history = [
    { role: 'user' as const, content: 'Add rate limiting', timestamp: at(0) },
    { role: 'assistant' as const, content: 'Here is the plan.', timestamp: at(7) },
    { role: 'assistant' as const, content: 'Plan generated with 1 task.', timestamp: at(8), kind: 'plan_generated' as const },
  ];
  const subagentUsage = { inputTokens: 400, outputTokens: 40 };
  const totals = { inputTokens: 3_400, outputTokens: 240 };

  const live = heard(
    80,
    { type: 'planner_turn_started', turnId: 't1', prompt: 'Add rate limiting' },
    { type: 'planner_thinking_delta', turnId: 't1', segmentId: 's0', text: 'Reading the app first' },
    { type: 'research_step', tool: 'read_file', args: read.args, toolCallId: 'c1', turnId: 't1' },
    { type: 'research_step_done', step: read, turnId: 't1' },
    { type: 'research_step', tool: 'spawn_research_agent', args: spawn.args, subagentId: 'sa-1', toolCallId: 'c2', turnId: 't1' },
    { type: 'subagent_started', subagentId: 'sa-1', brief: 'Find the middleware', turnId: 't1' },
    { type: 'research_step', tool: 'grep', args: grep.args, subagentId: 'sa-1', toolCallId: 'c3', turnId: 't1' },
    { type: 'research_step_done', step: grep, subagentId: 'sa-1', turnId: 't1' },
    { type: 'subagent_finished', subagentId: 'sa-1', outcome: 'done', digest: 'Middleware lives in src/mw.ts', usage: subagentUsage, turnId: 't1' },
    { type: 'research_step_done', step: spawn, subagentId: 'sa-1', turnId: 't1' },
    { type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Here is ' },
    { type: 'planner_message', content: 'Here is the plan.', timestamp: at(7), turnId: 't1' },
    { type: 'plan_generated', goal: 'Add rate limiting', runners: [], plan: { tasks: [], runners: [], generatedAt: at(8), conversationHistory: history } },
    { type: 'planner_usage', turnId: 't1', totals, bySubagent: { 'sa-1': subagentUsage }, contextFill: { usedTokens: 3_000, windowTokens: 128_000 } },
    { type: 'planner_turn_ended', turnId: 't1', outcome: 'plan' },
  );

  const reloaded = reduce(initialState({ rows: 40, cols: 80 }), {
    type: 'chatRestored',
    history,
    researchLog: [read, grep, { id: 'sa', type: 'subagent', subagentId: 'sa-1', brief: 'Find the middleware', outcome: 'done', digest: 'Middleware lives in src/mw.ts', usage: subagentUsage, timestamp: at(5) }, spawn],
    plannerUsage: { totals, bySubagent: { 'sa-1': subagentUsage }, lastPromptTokens: 3_000, contextWindow: 128_000 },
  }).state;

  /**
   * The conversation's rows, from the prompt down to the token line, without
   * the reasoning — the one block a session never saves.
   */
  const saved = (state: TuiState): string[] => {
    const tall = { ...state, rows: 80 };
    const rows = render(tall).map((r) => stripAnsi(r).trimEnd());
    const shown = rows.slice(rows.indexOf('❯ Add rate limiting'), bodyRows(tall) + 1);
    const thinking = shown.findIndex((r) => r.startsWith('∴'));
    const kept = thinking < 0 ? shown : [...shown.slice(0, thinking), ...shown.slice(shown.indexOf('', thinking))];
    return kept.filter(Boolean);
  };

  it('draws what the live view drew, for everything the session saves', () => {
    expect(render(live).map(stripAnsi).join('\n')).toContain('∴ Thinking');
    expect(saved(reloaded)).toEqual(saved(live));
    expect(saved(reloaded).at(-1)).toBe('3.4k in · 240 out · 2% ctx');
  });

  it('draws the same in full detail too', () => {
    expect(saved(detailed(reloaded))).toEqual(saved(detailed(live)));
  });
});

describe('queued prompts with the conversation', () => {
  it('still wait as bubbles below the transcript, with the token line under them', () => {
    const talking = heard(
      80,
      { type: 'planner_turn_started', turnId: 't1', prompt: 'Add rate limiting' },
      bash('npm test'),
      { type: 'planner_usage', totals: { inputTokens: 900, outputTokens: 80 } },
    );
    const state = { ...talking, status: 'planning' as const, queuedPrompts: ['Use SQLite'] };
    const rows = render(state).map((r) => stripAnsi(r).trimEnd());
    const bubble = rows.findIndex((r) => r.startsWith('◇ Use SQLite'));

    expect(rows[bubble]).toBe('◇ Use SQLite · queued · esc to unsend');
    expect(bubble).toBeGreaterThan(rows.findIndex((r) => r.startsWith('○ Bash(npm test)')));
    expect(rows[bodyRows(state)]).toBe('900 in · 80 out');
    expect(bubble).toBeLessThan(bodyRows(state));
  });
});
