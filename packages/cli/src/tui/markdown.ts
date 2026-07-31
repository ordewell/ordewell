import { pad, style, width, wrap } from './ansi';

/**
 * Render the small, useful Markdown subset planners normally use into terminal
 * lines. Keeping this here (rather than adding a browser-oriented Markdown
 * dependency) means chat remains fast, deterministic, and usable in narrow
 * terminals.
 */
export function renderMarkdown(source: string, cols: number): string[] {
  const lines = source.replace(/\r/g, '').replace(/^\n+|\n+$/g, '').split('\n');
  const out: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      out.push(...wrap(style.grey(`  ${line}`), cols));
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      out.push(...renderTable(table.headers, table.rows, cols));
      i = table.end;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const paint = heading[1].length <= 2
        ? (text: string) => style.bold(style.cyan(text))
        : style.bold;
      out.push(...wrap(paint(inline(heading[2])), cols));
      continue;
    }

    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      out.push(style.grey('─'.repeat(Math.max(1, cols))));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      out.push(...wrap(`${bullet[1]}• ${inline(bullet[2])}`, cols));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(...wrap(style.grey(`│ ${inline(quote[1])}`), cols));
      continue;
    }

    out.push(...wrap(inline(line), cols));
  }

  return out;
}

interface Table {
  headers: string[];
  rows: string[][];
  /** Index of the final source line belonging to this table. */
  end: number;
}

function tableAt(lines: string[], start: number): Table | null {
  if (!lines[start]?.includes('|') || !isTableRule(lines[start + 1] ?? '')) return null;

  const headers = tableCells(lines[start]);
  if (headers.length < 2) return null;

  const rows: string[][] = [];
  let end = start + 1;
  for (let i = start + 2; i < lines.length && lines[i].includes('|'); i += 1) {
    const cells = tableCells(lines[i]);
    if (cells.length !== headers.length) break;
    rows.push(cells);
    end = i;
  }
  return { headers, rows, end };
}

function isTableRule(line: string): boolean {
  const cells = tableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function renderTable(headers: string[], rows: string[][], cols: number): string[] {
  const separator = ' │ ';
  const separatorWidth = width(separator);
  const available = Math.max(headers.length, cols - separatorWidth * (headers.length - 1));
  const natural = headers.map((header, column) =>
    Math.max(width(inline(header)), ...rows.map((row) => width(inline(row[column] ?? '')))),
  );
  const columnWidths = fitTableColumns(natural, available);

  if (columnWidths.some((size) => size < 4)) return renderStackedTable(headers, rows, cols);

  const renderRow = (cells: string[], paint: (text: string) => string = (text) => text): string[] => {
    const wrapped = cells.map((cell, index) => wrap(inline(cell), columnWidths[index]));
    const height = Math.max(...wrapped.map((cell) => cell.length));
    return Array.from({ length: height }, (_, line) =>
      wrapped.map((cell, column) => pad(paint(cell[line] ?? ''), columnWidths[column])).join(separator),
    );
  };

  const rule = columnWidths.map((size) => style.grey('─'.repeat(size))).join(style.grey('─┼─'));
  return [
    ...renderRow(headers, style.bold),
    rule,
    ...rows.flatMap((row) => renderRow(row)),
  ];
}

function fitTableColumns(natural: number[], available: number): number[] {
  const widths = [...natural];
  let total = widths.reduce((sum, size) => sum + size, 0);
  while (total > available) {
    const widest = widths.reduce((best, size, index) => size > widths[best] ? index : best, 0);
    if (widths[widest] <= 3) break;
    widths[widest] -= 1;
    total -= 1;
  }
  return widths;
}

function renderStackedTable(headers: string[], rows: string[][], cols: number): string[] {
  return rows.flatMap((row, rowIndex) => [
    ...(rowIndex === 0 ? [] : ['']),
    ...row.flatMap((cell, column) => wrap(`${style.bold(inline(headers[column]))}: ${inline(cell)}`, cols)),
  ]);
}

/** Remove Markdown punctuation while retaining simple, useful terminal styling. */
function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => style.bold(bold))
    .replace(/__([^_]+)__/g, (_, bold: string) => style.bold(bold))
    // Emphasis delimiters must not be part of an identifier such as
    // ORDEWELL_AUTONOMOUS_MODE. Code runs last so their content is untouched.
    .replace(/(^|[^\w])\*([^*]+)\*(?![\w*])/g, (_, prefix: string, italic: string) => `${prefix}${style.italic(italic)}`)
    .replace(/(^|[^\w])_([^_]+)_(?![\w_])/g, (_, prefix: string, italic: string) => `${prefix}${style.italic(italic)}`)
    .replace(/`([^`]+)`/g, (_, code: string) => style.cyan(code));
}
