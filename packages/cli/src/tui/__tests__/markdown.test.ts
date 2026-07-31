import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../markdown';
import { style, width } from '../ansi';

beforeAll(() => {
  // Deterministic frames: colour codes would only make the assertions noisy.
  style.enabled = false;
});

const md = (source: string, cols = 80): string[] => renderMarkdown(source, cols);

describe('renderMarkdown — block elements', () => {
  it('strips leading/trailing blank lines and carriage returns', () => {
    expect(md('\r\n\nhello\r\n\n')).toEqual(['hello']);
  });

  it('renders headings without the hash markers', () => {
    expect(md('# Title')).toEqual(['Title']);
    expect(md('### Deep heading')).toEqual(['Deep heading']);
    expect(md('## Closed ##')).toEqual(['Closed']);
  });

  it('renders bullets with a • regardless of the source marker', () => {
    expect(md('- one\n* two\n+ three')).toEqual(['• one', '• two', '• three']);
  });

  it('preserves bullet indentation for nested lists', () => {
    expect(md('- top\n  - nested')).toEqual(['• top', '  • nested']);
  });

  it('renders blockquotes with a │ gutter', () => {
    expect(md('> quoted text')).toEqual(['│ quoted text']);
  });

  it('renders a horizontal rule across the full width', () => {
    const [rule] = md('---', 20);
    expect(rule).toBe('─'.repeat(20));
  });

  it('drops code fences but keeps code content verbatim and indented', () => {
    const out = md('```ts\nconst x = **not bold**;\n```');
    expect(out).toEqual(['  const x = **not bold**;']);
  });

  it('treats an unclosed fence as code until the end', () => {
    expect(md('```\nline1\nline2')).toEqual(['  line1', '  line2']);
  });

  it('wraps long paragraphs at the requested width', () => {
    const out = md('word '.repeat(40).trim(), 20);
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(20);
  });
});

describe('renderMarkdown — inline formatting', () => {
  it('strips bold and italic markers', () => {
    expect(md('**bold** and *italic* and __also__ and _this_')).toEqual([
      'bold and italic and also and this',
    ]);
  });

  it('keeps underscores inside identifiers untouched', () => {
    expect(md('set ORDEWELL_AUTONOMOUS_MODE=1 before running')).toEqual([
      'set ORDEWELL_AUTONOMOUS_MODE=1 before running',
    ]);
  });

  it('unwraps inline code spans', () => {
    expect(md('run `npm install` now')).toEqual(['run npm install now']);
  });

  it('renders links as text (url) and images as their alt text', () => {
    expect(md('[docs](https://example.com)')).toEqual(['docs (https://example.com)']);
    expect(md('![diagram](https://example.com/x.png)')).toEqual(['diagram']);
  });
});

describe('renderMarkdown — tables', () => {
  const table = '| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Grace | Admiral |';

  it('renders aligned columns with a rule under the header', () => {
    const out = md(table);
    expect(out[0]).toMatch(/^Name\s+│ Role/);
    expect(out[1]).toContain('─┼─');
    expect(out[2]).toMatch(/^Ada\s+│ Engineer/);
    expect(out[3]).toMatch(/^Grace\s+│ Admiral/);
  });

  it('requires a rule row — a lone pipe line is plain text', () => {
    expect(md('| just | text |')).toEqual(['| just | text |']);
  });

  it('shrinks columns to fit narrow terminals without overflowing', () => {
    const wide = '| Column A | Column B |\n| --- | --- |\n| a very long cell value here | short |';
    for (const line of md(wide, 30)) expect(width(line)).toBeLessThanOrEqual(30);
  });

  it('falls back to a stacked layout when columns would collapse below readability', () => {
    const cramped = '| Header one | Header two |\n| --- | --- |\n| aaa | bbb |';
    const out = md(cramped, 8);
    const flat = out.join('\n');
    expect(flat).not.toContain('│');
    expect(flat).toContain('one: aaa');
    expect(flat).toContain('two: bbb');
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(8);
  });

  it('stops the table at the first row with a different cell count', () => {
    const out = md('| a | b |\n| --- | --- |\n| 1 | 2 |\nplain text after');
    expect(out[out.length - 1]).toBe('plain text after');
  });
});
