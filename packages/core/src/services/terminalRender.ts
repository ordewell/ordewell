/*
 * Pure terminal rendering: turns raw PTY bytes into the text a user would see.
 * No state and no I/O, so the verdict scan and every output reader share it.
 */

// eslint-disable-next-line no-control-regex
const ANSI_OR_CTRL_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][AB012]|\x1b[=>]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Collapse terminal rendering out of raw PTY output: strip ANSI/OSC escape
 * sequences, box-drawing gutter characters, and ALL whitespace. Interactive
 * TUIs soft-wrap long lines, so a completion marker arrives split across
 * lines with escapes interleaved — a raw `includes()` never matches it.
 * Markers contain no whitespace, so this flattened view is safe to scan.
 */
export function flattenTerminalOutput(raw: string): string {
  return raw
    .replace(ANSI_OR_CTRL_RE, '')
    .replace(/[─-▟]/g, '') // box-drawing + block elements (TUI borders/gutters)
    .replace(/\s+/g, '');
}

/**
 * Reconstruct the small terminal screen represented by a PTY output tail.
 *
 * Full-screen TUIs do not emit answer text as one chronological stream. They
 * paint fragments at absolute cursor positions and repaint unrelated widgets
 * between those writes. OpenCode, for example, may emit:
 *
 *   row 9:  "<<<ORDEW"
 *   row 23: spinner repaint
 *   row 9:  "ELL_DONE_..."
 *
 * Flattening that byte stream inserts the spinner inside the marker. Rendering
 * the cursor-positioned writes first recovers the token the user actually sees.
 * This intentionally implements only the common cursor/erase subset used by
 * coding-agent TUIs; the chronological scanner remains the fallback for plain
 * output and soft-wrapped lines.
 */
export function renderTerminalOutput(raw: string): string {
  const rows = new Map<number, string[]>();
  let row = 1;
  let col = 1;
  let savedRow = 1;
  let savedCol = 1;

  const cells = (r: number): string[] => {
    let line = rows.get(r);
    if (!line) {
      line = [];
      rows.set(r, line);
    }
    return line;
  };
  const firstParam = (params: number[], fallback = 1): number => params[0] || fallback;
  const eraseLine = (mode: number): void => {
    const line = cells(row);
    if (mode === 2) {
      rows.set(row, []);
    } else if (mode === 1) {
      for (let c = 0; c < col; c++) line[c] = ' ';
    } else {
      line.length = Math.max(0, col - 1);
    }
  };

  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === '\x1b') {
      const kind = raw[i + 1];
      if (kind === '[') {
        let end = i + 2;
        while (end < raw.length) {
          const code = raw.charCodeAt(end);
          if (code >= 0x40 && code <= 0x7e) break;
          end++;
        }
        if (end >= raw.length) break;
        const final = raw[end];
        const body = raw.slice(i + 2, end).replace(/^[?<>=!]+/, '');
        const params = body.split(';').map((p) => Number.parseInt(p, 10) || 0);
        switch (final) {
          case 'H':
          case 'f':
            row = params[0] || 1;
            col = params[1] || 1;
            break;
          case 'G': col = firstParam(params); break;
          case 'd': row = firstParam(params); break;
          case 'A': row = Math.max(1, row - firstParam(params)); break;
          case 'B': row += firstParam(params); break;
          case 'C': col += firstParam(params); break;
          case 'D': col = Math.max(1, col - firstParam(params)); break;
          case 'E': row += firstParam(params); col = 1; break;
          case 'F': row = Math.max(1, row - firstParam(params)); col = 1; break;
          case 's': savedRow = row; savedCol = col; break;
          case 'u': row = savedRow; col = savedCol; break;
          case 'K': eraseLine(params[0] || 0); break;
          case 'J':
            if ((params[0] || 0) === 2 || (params[0] || 0) === 3) rows.clear();
            break;
          case 'X': {
            const line = cells(row);
            for (let c = 0; c < firstParam(params); c++) line[col - 1 + c] = ' ';
            break;
          }
          case 'P': {
            cells(row).splice(col - 1, firstParam(params));
            break;
          }
          case '@': {
            cells(row).splice(col - 1, 0, ...Array(firstParam(params)).fill(' '));
            break;
          }
          default:
            break;
        }
        i = end + 1;
        continue;
      }
      if (kind === ']' || kind === 'P' || kind === '^' || kind === '_') {
        let end = i + 2;
        while (end < raw.length && raw[end] !== '\x07' && !(raw[end] === '\x1b' && raw[end + 1] === '\\')) end++;
        if (end >= raw.length) break;
        i = raw[end] === '\x07' ? end + 1 : end + 2;
        continue;
      }
      if (kind === '7') {
        savedRow = row;
        savedCol = col;
      } else if (kind === '8') {
        row = savedRow;
        col = savedCol;
      } else if (kind === 'c') {
        rows.clear();
        row = 1;
        col = 1;
      }
      // Character-set selection sequences carry one extra byte.
      i += kind === '(' || kind === ')' ? 3 : 2;
      continue;
    }
    if (ch === '\r') {
      col = 1;
      i++;
      continue;
    }
    if (ch === '\n') {
      row++;
      i++;
      continue;
    }
    if (ch === '\b') {
      col = Math.max(1, col - 1);
      i++;
      continue;
    }
    if (ch === '\t') {
      col += 8 - ((col - 1) % 8);
      i++;
      continue;
    }
    if (ch < ' ' || ch === '\x7f') {
      i++;
      continue;
    }
    cells(row)[col - 1] = ch;
    col++;
    i++;
  }

  const populated = [...rows.keys()].sort((a, b) => a - b);
  return populated.map((r) => cells(r).join('')).join('\n');
}

/**
 * Reconstruct what the user actually saw, then stop at the completion marker.
 * Used for anything captured as a task's durable output (outputSummary.logTail,
 * and any future planner read channel): the raw chronological PTY tail is
 * dominated by TUI paint — spinner lines, status bars, box-drawing borders,
 * cursor-positioned fragments — because screen-painting agents emit answer
 * text at absolute positions and repaint unrelated widgets around it.
 *
 * The marker row is the cut anchor: everything below it is the TUI's
 * persistent chrome, not task output. Falls back to the chronological
 * (stripAnsi'd) tail when neither render exposes the marker — the common case
 * for headless runners, whose raw stream IS meaningful.
 */
export function renderCleanCapture(raw: string, doneToken?: string): string {
  const rendered = renderTerminalOutput(raw).replace(/[\s─-▟]+$/gm, '');
  if (!doneToken) return rendered.trim();
  const lines = rendered.split('\n');
  const flat = (s: string) => flattenTerminalOutput(s);
  for (let i = 0; i < lines.length; i++) {
    // The marker may be split across two rendered rows (painted at a row
    // boundary): the first row alone won't match, so a two-row window is
    // scanned too. The cut is the last row that carries marker text — rows
    // above it are content, rows below are TUI chrome.
    const own = flat(lines[i]).includes(doneToken);
    if (own) return lines.slice(0, i).join('\n').trim();
    const window = flat(lines[i]) + (i + 1 < lines.length ? flat(lines[i + 1]) : '');
    if (window.includes(doneToken)) return lines.slice(0, i + 1).join('\n').trim();
  }
  return rendered.trim();
}
