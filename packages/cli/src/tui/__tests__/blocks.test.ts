import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DisplayBlock, MessageBlock, ToolBlock } from '@ordewell/core';
import { stripAnsi, style } from '../ansi';
import { conversationLines } from '../blocks';

const message = (role: MessageBlock['role'], text: string): MessageBlock =>
  ({ type: 'message', id: 'b1', role, text, streaming: false });

const rows = (role: MessageBlock['role'], text: string): string[] =>
  conversationLines([message(role, text)], 16, false).filter((row) => row !== '');

let wasEnabled: boolean;
beforeEach(() => { wasEnabled = style.enabled; style.enabled = true; });
afterEach(() => { style.enabled = wasEnabled; });

describe('a wrapped line keeps the colour it started in', () => {
  const long = 'alpha beta gamma delta epsilon zeta';

  it('paints every row of a system notice grey, under one bullet', () => {
    const lines = rows('system', long);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith('\x1b[90m')).toBe(true);
    expect(stripAnsi(lines.join('')).match(/·/g)).toHaveLength(1);
  });

  it('paints every row of an error red', () => {
    const lines = rows('error', long);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toContain('\x1b[31m');
  });

  it('leaves an agent\'s continuation rows unpainted, as before', () => {
    const lines = rows('agent', long);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1].startsWith('\x1b[')).toBe(false);
  });
});

describe('a huge message is cut for the frame, with a note', () => {
  it('shows its head and counts the characters it left out', () => {
    const huge = `start ${'word '.repeat(40_000)}end`;
    const out = conversationLines([message('planner', huge)], 60, false).map(stripAnsi).join('\n');

    expect(out).toContain('start');
    expect(out).toContain('not shown');
    expect(out).not.toContain('end');
  });
});

describe('model Markdown is sanitized before it is parsed (#83)', () => {  // Only the TUI's own colour may remain: any other escape would act on the terminal.
  const strayEscapes = (lines: string[]): string[] =>
    // eslint-disable-next-line no-control-regex
    lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g) ?? [];

  it('drops control sequences in a paragraph, heading, table cell, code block and link', () => {
    const text = [
      '# Head\x1b]0;owned\x07ing',
      'text \x1b[2Kwith \x1b[31mred\x1b[0m and a bell\x07',
      '',
      '| a | b |',
      '| --- | --- |',
      '| x\x1b[10Cy | z |',
      '',
      '```',
      'code\x1b[Hline',
      '```',
      '',
      '[docs\x1b[2J](https://example.com/\x1b[31m)',
    ].join('\n');
    const lines = conversationLines([message('planner', text)], 60, false);
    expect(strayEscapes(lines)).toEqual([]);
    const plain = stripAnsi(lines.join('\n'));
    expect(plain).toContain('Heading');
    expect(plain).toContain('text with red and a bell');
    expect(plain).toContain('xy');
    expect(plain).toContain('codeline');
    expect(plain).toContain('docs');
  });
});

describe('the live thinking line keeps the end of a row too short for it', () => {
  it('never cuts a joined emoji in half', () => {
    const family = '👨‍👩‍👧';
    const block = { type: 'thinking' as const, id: 't1', text: `${'x'.repeat(40)}${family}`, streaming: true };

    // Room for the ellipsis and two columns: one whole cluster, not a dangling joiner and its last member.
    const [row] = conversationLines([block], 25, false).filter((line) => line !== '');

    expect(stripAnsi(row)).toMatch(new RegExp(`·\\s…${family}$`, 'u'));
  });
});

describe('a task\'s runner commands in its log (#66)', () => {
  const plainRows = (blocks: Parameters<typeof conversationLines>[0], detailAll = false) =>
    conversationLines(blocks, 80, detailAll).map(stripAnsi).filter((row) => row !== '');

  it('draws a command the user ran, how its turn ended, and what it printed', () => {
    expect(plainRows([{ type: 'command', id: 'b1', name: 'compact', args: 'keep the API notes', status: 'done', output: 'Compacted' }])).toEqual([
      '❯ /compact keep the API notes  done',
      '  ⎿  Compacted',
    ]);
    expect(plainRows([{ type: 'command', id: 'b1', name: 'pingskill', status: 'running', output: '' }])).toEqual(['❯ /pingskill  running']);
  });

  it('marks a compaction, with the context before and after it', () => {
    expect(plainRows([{ type: 'compaction', id: 'b1', trigger: 'manual', preTokens: 24939, postTokens: 3615 }])).toEqual(['≡ Context compacted · 25k → 3.6k tokens']);
    expect(plainRows([{ type: 'compaction', id: 'b1', trigger: 'auto' }])).toEqual(['≡ Context compacted by the runner on its own']);
  });

  describe('a planner compaction', () => {
    const planner = (over: Partial<Extract<DisplayBlock, { type: 'compaction' }>>): DisplayBlock =>
      ({ type: 'compaction', id: 'b1', trigger: 'manual', origin: 'ordewell', compactionId: 'c1', ...over });
    const detailRows = (block: DisplayBlock, cols = 60) => conversationLines([block], cols, true).map(stripAnsi).filter((row) => row !== '');

    it('says it is running, and how each end left the conversation', () => {
      expect(plainRows([planner({ status: 'running' })])).toEqual(['≡ Compacting context…']);
      expect(plainRows([planner({ status: 'stopped' })])).toEqual(['≡ Compaction stopped · nothing changed']);
      expect(plainRows([planner({ status: 'failed' })])).toEqual(['≡ Compaction failed · nothing changed']);
      expect(plainRows([planner({ status: 'paused' })])).toEqual(['≡ Context does not fit · the planner is paused']);
      expect(plainRows([planner({ status: 'pruned', trigger: 'auto' })])).toEqual(['≡ Older tool output trimmed from context']);
    });

    it('keeps a condensed one to a single quiet line that says where the summary is', () => {
      expect(plainRows([planner({ status: 'condensed', summary: 'Conversation condensed: the state' })])).toEqual(['≡ Context compacted (ctrl+o for the summary)']);
    });

    it('opens the summary under the line in full detail, wrapped to the pane', () => {
      const rowsOpen = detailRows(planner({ status: 'condensed', summary: 'Conversation condensed: the state of the parser work so far, in some detail' }), 30);

      expect(rowsOpen[0]).toBe('≡ Context compacted');
      expect(rowsOpen.length).toBeGreaterThan(2);
      expect(rowsOpen.slice(1).join(' ').replace(/[⎿\s]+/g, ' ')).toContain('the state of the parser work so far');
      for (const row of rowsOpen) expect(row.length).toBeLessThanOrEqual(30);
    });

    it('draws a native one by its own wording, with sizes only as the harness reported them', () => {
      expect(plainRows([planner({ origin: 'native', trigger: 'auto', status: 'condensed' })])).toEqual(['≡ The planner compacted its context on its own']);
      expect(plainRows([planner({ origin: 'native', status: 'condensed', preTokens: 24939, postTokens: 3615 })])).toEqual(['≡ The planner compacted its context · 25k → 3.6k tokens']);
    });

    it('paints a summary a model wrote as plain text: control sequences in it never reach the terminal', () => {
      const rowsOpen = conversationLines([planner({ status: 'condensed', summary: 'ok\x1b[2Jgone' })], 60, true);

      expect(rowsOpen.join('')).not.toContain('\x1b[2J');
    });
  });

  it('says how much of a huge output it leaves out instead of reading all of it', () => {
    const huge = Array.from({ length: 100_000 }, (_, i) => `test case ${i} passed`).join('\n');
    const block = { type: 'command' as const, id: 'b1', name: 'test', status: 'done' as const, output: huge };

    const collapsed = plainRows([block]);
    expect(collapsed.slice(1, 4)).toEqual(['  ⎿  test case 0 passed', '     test case 1 passed', '     test case 2 passed']);
    expect(collapsed.at(-1)).toBe('     … +99997 lines (ctrl+o to expand)');

    const detail = plainRows([block], true);
    expect(detail.length).toBeLessThanOrEqual(2_002);
    expect(detail.at(-1)).toBe('     … +98000 lines not shown');
  });

  it('collapses what the runner loaded to one line, and lists it in full detail', () => {
    const loaded = {
      type: 'runner_loaded' as const, id: 'b1',
      commands: [
        { name: 'pingskill', description: 'Reply', kind: 'skill' as const },
        { name: 'hellocmd', description: 'Say hello', kind: 'command' as const },
        { name: 'compact', description: 'Free up context', kind: 'builtin' as const },
        { name: 'model', description: 'Set the model', kind: 'builtin' as const },
      ],
      mcpServers: [{ name: 'docs-server', status: 'pending' }],
    };
    expect(plainRows([loaded])).toEqual(['● Runner loaded 1 skill, 1 command, 2 built-in commands, 1 MCP server']);
    expect(plainRows([loaded], true)).toEqual([
      '● Runner loaded 1 skill, 1 command, 2 built-in commands, 1 MCP server',
      '     skills: /pingskill',
      '     commands: /hellocmd',
      '     built-in: /compact /model',
      '     MCP servers: docs-server (pending)',
    ]);
  });
});

describe('a command that ran sealed (ADR-0036 S4)', () => {
  const sealedRun = (over: Partial<ToolBlock> = {}): ToolBlock => ({
    type: 'tool', id: 'b1', tool: 'bash', headline: { name: 'Bash', keyArg: 'for f in *.md; do wc -l "$f"; done' },
    args: '{"command":"for f in *.md; do wc -l \\"$f\\"; done"}', status: 'ok', outcome: 'success',
    output: '3 README.md', outputLineCount: 1, sealed: true, ...over,
  });
  const plainRows = (block: ToolBlock, cols = 80, detailAll = false) =>
    conversationLines([block], cols, detailAll).map(stripAnsi).filter((row) => row !== '');

  it('says so after the command, and still closes it when the row is short', () => {
    expect(plainRows(sealedRun())).toEqual(['● Bash(for f in *.md; do wc -l "$f"; done) · sealed', '  ⎿  3 README.md']);
    expect(plainRows(sealedRun(), 30)[0]).toBe('● Bash(for f in *.m…) · sealed');
    expect(plainRows(sealedRun(), 80, true)[0]).toBe('● Bash(for f in *.md; do wc -l "$f"; done) · sealed');
  });

  it('leads a failure with its own reason', () => {
    const failed = sealedRun({ status: 'error', outcome: 'failure', output: 'Command exited 6:\ncurl: (6) Could not resolve host' });
    expect(plainRows(failed)[1]).toBe('  ⎿  Error: Command exited 6:');
  });
});

describe('a run update that delivers a research report (ADR-0037 R2)', () => {
  const digest = (report: string[]): string => [
    'Run update:',
    `- task #3 "Scout the cache", whose result you asked for, has ended. ${report.join('\n  ')}`,
  ].join('\n');
  // The pane leaves a blank row after a block, which is no part of it.
  const drawn = (text: string, detailAll: boolean, cols = 60): string[] =>
    conversationLines([message('wake_up', text)], cols, detailAll).map(stripAnsi).filter((row, i, all) => i < all.length - 1 || row !== '');
  const numbered = (n: number): string[] => ['It passed.', ...Array.from({ length: n - 1 }, (_, i) => `finding ${i + 1}`)];

  it('draws a short report whole, beneath its task', () => {
    const out = drawn(digest(numbered(4)), false);
    expect(out[0]).toBe('↯ Run update:');
    expect(out[1]).toContain('- task #3 "Scout the cache" ended, with this report:');
    expect(out.slice(2)).toEqual(['    It passed.', '    finding 1', '    finding 2', '    finding 3']);
  });

  it('folds a long report, and says how many lines it leaves out', () => {
    const out = drawn(digest(numbered(20)), false);
    expect(out).toContain('    finding 7');
    expect(out).not.toContain('    finding 8');
    expect(out.at(-1)).toBe('    … +12 lines of the report (ctrl+o to expand)');
  });

  it('draws all of it when the detail is on, and says how to fold it back', () => {
    const out = drawn(digest(numbered(20)), true);
    expect(out).toContain('    finding 19');
    expect(out.join('\n')).not.toContain('lines of the report');
    expect(out.at(-1)).toBe('    … (ctrl+o to collapse)');
  });

  it('wraps a long line of the report rather than cutting it', () => {
    const word = 'unbroken-'.repeat(3);
    const out = drawn(digest(['It passed.', `${word} ${word} ${word}`]), false, 40).join('\n');
    expect(out.match(/unbroken-/g)).toHaveLength(9);
  });

  it('keeps the update\'s other lines as they were', () => {
    const text = `${digest(numbered(2))}\n- task #4 "Fix it" failed: tests red`;
    expect(drawn(text, false)).toContain('  - task #4 "Fix it" failed: tests red');
  });

  it('draws an update with no report as it always was', () => {
    expect(drawn('Run update:\n- task #4 "Fix it" failed: tests red', false)).toEqual(['↯ Run update:', '  - task #4 "Fix it" failed: tests red']);
  });
});

describe('a task\'s first message folds what Ordewell added around the brief', () => {
  const sections: NonNullable<MessageBlock['sections']> = [
    { title: 'Handoffs from earlier tasks', sections: [
      { kind: 'priorOutputs', title: 'Prior task outputs', text: 'Task 1 built the parser.' },
      { kind: 'carriedOver', title: 'Carried over', text: 'Left the lexer half done.' },
    ] },
    { title: 'Ordewell\'s instructions to the runner', sections: [
      { kind: 'checkpoint', title: 'Checkpoint', text: 'Call checkpoint when blocked.' },
    ] },
  ];
  const first = (over: Partial<MessageBlock> = {}): MessageBlock => ({ ...message('user', 'Fix the lexer'), sections, ...over });
  const plain = (blocks: DisplayBlock[], cols: number, detail: boolean): string[] => conversationLines(blocks, cols, detail).map(stripAnsi);

  it('draws one dim line per group with its section count, above the brief on its band', () => {
    const out = plain([first()], 80, false);
    expect(out.filter((row) => row.trim() !== '')).toEqual([
      'Handoffs from earlier tasks · 2 sections (ctrl+o to expand)',
      'Ordewell\'s instructions to the runner · 1 section (ctrl+o to expand)',
      '❯ Fix the lexer'.padEnd(80),
    ]);
    expect(out.join('\n')).not.toContain('Task 1 built the parser.');
    const lines = conversationLines([first()], 80, false);
    expect(lines[0].startsWith('\x1b[90m')).toBe(true);
  });

  it('opens each group in place with detail on: every section under its title, wrapped', () => {
    const out = plain([first({ sections: [{ title: 'Handoffs from earlier tasks', sections: [
      { kind: 'priorOutputs', title: 'Prior task outputs', text: 'alpha beta gamma delta epsilon zeta' },
    ] }] })], 30, true);
    const at = out.findIndex((row) => row.includes('Handoffs from earlier tasks'));
    expect(out.slice(at, at + 4).map((row) => row.trimEnd())).toEqual([
      expect.stringContaining('Handoffs from earlier tasks'),
      '  Prior task outputs',
      '    alpha beta gamma delta',
      '    epsilon zeta',
    ]);
    expect(out.some((row) => row.startsWith('❯ Fix the lexer'))).toBe(true);
  });

  it('cuts the brief by its own length only, never by how long the sections are', () => {
    const huge = 'x '.repeat(60_000);
    const block = first({ text: 'The brief ends here', sections: [{ title: 'Handoffs from earlier tasks', sections: [
      { kind: 'priorOutputs', title: 'Prior task outputs', text: huge },
    ] }] });
    for (const detail of [false, true]) {
      const out = plain([block], 60, detail).join('\n');
      expect(out).toContain('The brief ends here');
    }
    expect(plain([block], 60, false).join('\n')).not.toContain('not shown');
    const opened = plain([block], 60, true);
    expect(opened.join('\n')).toContain('not shown');
    expect(opened.length).toBeLessThan(5_000);
  });

  it('still cuts a brief past the display cap, as before', () => {
    const out = plain([first({ text: `start ${'word '.repeat(40_000)}end` })], 60, false).join('\n');
    expect(out).toContain('not shown');
    expect(out).not.toContain('end\n');
  });

  it('draws a message without sections frame for frame as before, whatever the detail', () => {
    const bare = message('user', 'Fix the lexer');
    const empty = { ...bare, sections: [] };
    for (const detail of [false, true]) {
      expect(conversationLines([empty], 40, detail)).toEqual(conversationLines([bare], 40, detail));
      expect(plain([bare], 40, detail)).toEqual([' '.repeat(40), `❯ Fix the lexer${' '.repeat(25)}`, ' '.repeat(40), '']);
    }
  });
});
