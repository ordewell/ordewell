import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TranscriptQuery, TranscriptReader } from '../interfaces/TaskOutputSource';

/**
 * Read a task's final answer from the agent's own session transcript — the
 * clean, structured record the agent writes about itself — instead of
 * reconstructing what a TUI painted (issue #16, built on #14's render).
 *
 * These stores are private and undocumented and DO rotate (OpenCode migrated
 * from files to SQLite mid-2026). Every reader is therefore defensive: any
 * missing file, unparseable line, or shape drift returns null and the caller
 * falls back to the terminal capture. Nothing here is a hard dependency.
 *
 * Directory and recency only narrow the candidates: with several attempts in
 * one cwd the newest session is whichever task finished last. A transcript is
 * accepted only when its content carries the task's completion marker.
 */
export class HomeTranscriptReader implements TranscriptReader {
  private readonly home: () => string;

  constructor(opts: { homeDir?: string } = {}) {
    // Resolved per call when not injected: `os.homedir()` may be cached once
    // per process by the runtime, while HOME can change under it.
    const { homeDir } = opts;
    this.home = homeDir ? () => homeDir : () => process.env.HOME || os.homedir();
  }

  async finalAssistantText(query: TranscriptQuery, maxChars = 4000): Promise<string | null> {
    try {
      if (query.runner === 'claude-code') return claudeFinal(this.home(), query, maxChars);
      if (query.runner === 'opencode') return await opencodeFinal(this.home(), query, maxChars);
      if (query.runner === 'codex') return codexFinal(this.home(), query, maxChars);
    } catch {
      /* store unreadable — fall through */
    }
    return null;
  }
}

// --- Claude Code: ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl ---
// Each line is a typed record; assistant records carry message.content blocks.

/** Past this length Claude Code keeps only the first this-many characters of a directory name and appends a hash. */
const CLAUDE_PROJECT_NAME_MAX = 200;

/**
 * Claude Code names the directory after the cwd with every non-alphanumeric
 * turned into '-'. A worktree lives under `.ordewell/`, so the dot matters, and
 * its path is long enough to reach the shortened form, whose hash is Claude
 * Code's own — every directory with the kept prefix is a candidate, and the
 * marker check decides between them.
 */
function claudeProjectDirs(home: string, cwd: string): string[] {
  const projects = path.join(home, '.claude', 'projects');
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (munged.length <= CLAUDE_PROJECT_NAME_MAX) {
    const dir = path.join(projects, munged);
    return existsSync(dir) ? [dir] : [];
  }
  if (!existsSync(projects)) return [];
  const prefix = `${munged.slice(0, CLAUDE_PROJECT_NAME_MAX)}-`;
  return readdirSync(projects).filter((name) => name.startsWith(prefix)).map((name) => path.join(projects, name));
}

function claudeFinal(home: string, query: TranscriptQuery, maxChars: number): string | null {
  const cutoff = query.startedAt ? Date.parse(query.startedAt) : 0;
  // A session file is created at spawn; anything last-modified before the task
  // started is a previous session in the same directory, not this task's.
  const candidates = claudeProjectDirs(home, query.cwd)
    .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)))
    .filter((f) => (cutoff ? statSync(f).mtimeMs >= cutoff - 5_000 : true))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of candidates) {
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes(query.marker)) continue;
    const text = claudeLastAssistant(raw);
    if (text) return clamp(text, maxChars);
  }
  return null;
}

function claudeLastAssistant(raw: string): string | null {
  let last: string | null = null;
  // Parse only the tail: transcripts reach megabytes and the final answer is
  // the last text-bearing line. The cut moves forward to a line boundary so
  // the first parsed record is whole.
  const start = Math.max(0, raw.length - 512 * 1024);
  const buf = start > 0 ? raw.slice(raw.indexOf('\n', start) + 1) : raw;
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    let rec: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'assistant' || rec.isSidechain) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (texts) last = texts;
  }
  return last;
}

// --- OpenCode: SQLite at ~/.local/share/opencode/opencode.db ---
// message rows hold role; part rows hold typed content pieces.

async function opencodeFinal(home: string, query: TranscriptQuery, maxChars: number): Promise<string | null> {
  // node:sqlite exists from Node 22; core's engine floor is 20, so import it
  // lazily — an older Node simply falls back to the terminal capture.
  let DatabaseSync: (new (loc: string, opts?: { open?: boolean }) => {
    prepare: (sql: string) => { get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] };
    close: () => void;
  });
  try {
    ({ DatabaseSync } = await import('node:sqlite') as { DatabaseSync: typeof DatabaseSync });
  } catch {
    return null;
  }
  const dbPath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { open: true });
  } catch {
    return null;
  }
  try {
    const cutoff = query.startedAt ? Date.parse(query.startedAt) : 0;
    // Sessions in the task's directory, newest first. `directory` is the
    // spawn cwd; time_updated covers both "created after start" (fresh
    // session) and "kept writing after start" (resumed session).
    const rows = db
      .prepare(
        `select s.id, s.time_updated from session s
         join project p on p.id = s.project_id
         where s.directory = ?
         order by s.time_updated desc limit 20`,
      )
      .all(query.cwd) as Array<{ id: string; time_updated: number }>;
    const carriesMarker = db.prepare(
      `select 1 from part pt
       join message m on m.id = pt.message_id
       where m.session_id = ? and instr(pt.data, ?) > 0
       limit 1`,
    );
    for (const row of rows) {
      if (cutoff && row.time_updated < cutoff - 5_000) continue;
      if (!carriesMarker.get(row.id, query.marker)) continue;
      // Assistant message ids sort chronologically (msg_<base36-ish>); the
      // newest assistant message's text parts are the final answer.
      const parts = db
        .prepare(
          `select pt.data from part pt
           join message m on m.id = pt.message_id
           where m.session_id = ? and m.data like '%"role":"assistant"%'
           order by pt.id asc`,
        )
        .all(row.id) as Array<{ data: string }>;
      let text: string | null = null;
      for (const p of parts) {
        try {
          const d = JSON.parse(p.data) as { type?: string; text?: string };
          if (d.type === 'text' && d.text && d.text.trim()) text = d.text.trim();
        } catch {
          continue;
        }
      }
      if (text) return clamp(text, maxChars);
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl ---
// Each line {timestamp, type, payload}; assistant text lives in
// response_item/message records with role assistant. The thread id is
// server-minted, so a task maps by its marker within its cwd.

function codexFinal(home: string, query: TranscriptQuery, maxChars: number): string | null {
  const root = path.join(home, '.codex', 'sessions');
  if (!existsSync(root)) return null;
  const cutoff = query.startedAt ? Date.parse(query.startedAt) : 0;
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      let st: import('fs').Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (e.startsWith('rollout-') && e.endsWith('.jsonl') && (!cutoff || st.mtimeMs >= cutoff - 5_000)) files.push(full);
    }
  }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  // Without a start time the store's whole history qualifies, so only the
  // newest few are opened; with one, every rollout since is a real candidate.
  for (const file of cutoff ? files : files.slice(0, 10)) {
    const text = codexLastAssistant(file, query);
    if (text) return clamp(text, maxChars);
  }
  return null;
}

function codexLastAssistant(file: string, query: TranscriptQuery): string | null {
  const raw = readFileSync(file, 'utf8');
  if (!raw.includes(query.marker)) return null;
  const lines = raw.split('\n').filter((l) => l.trim());
  let sawCwd = false;
  let last: string | null = null;
  for (const line of lines) {
    let rec: { type?: string; payload?: { cwd?: string; type?: string; role?: string; content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session_meta' && rec.payload?.cwd === query.cwd) sawCwd = true;
    if (rec.type !== 'response_item') continue;
    const p = rec.payload;
    if (p?.role !== 'assistant' || p.type !== 'message') continue;
    const texts = (Array.isArray(p.content) ? p.content : [])
      .map((c) => (typeof c === 'object' && c !== null && (c as { text?: string }).text) || '')
      .join('\n')
      .trim();
    if (texts) last = texts;
  }
  // cwd binding: accept the file only if its session_meta names this cwd. A
  // home-dir default agent run elsewhere must not answer for this task.
  return sawCwd ? last : null;
}

function clamp(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}
