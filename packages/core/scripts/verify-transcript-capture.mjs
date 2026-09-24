/**
 * Live-store verification for transcriptCapture (#16). Run with the repo's
 * tsx: `npx tsx scripts/verify-transcript-capture.mjs` from packages/core.
 * Reads the REAL stores under $HOME — read-only, no writes anywhere.
 *
 * Pass a task's completion marker as the first argument to check the binding
 * to that task; without one the marker is empty, which every transcript
 * contains, so this only exercises the parsers.
 */
import { HomeTranscriptReader } from '../src/services/transcriptCapture';

const reader = new HomeTranscriptReader();
const marker = process.argv[2] ?? '';
const readFinalAssistantText = (query) => reader.finalAssistantText({ ...query, marker });

function show(label, out) {
  console.log(`\n=== ${label} ===`);
  if (out == null) { console.log('(null — no transcript found)'); return; }
  console.log(`chars: ${out.length}`);
  console.log(out.slice(0, 400).replace(/\n+/g, ' | '));
}

// 1. Claude Code: real project dirs exist under ~/.claude/projects. Use one
//    with a known munged cwd and a recent session.
import { readdirSync, statSync } from 'fs';
import * as path from 'path';
const projRoot = path.join(process.env.HOME, '.claude', 'projects');
const dirs = readdirSync(projRoot).filter((d) => !d.startsWith('.'));
for (const d of dirs.slice(0, 3)) {
  const cwd = '/' + d.replace(/^-/, '').replace(/-/g, '/');
  const out = await readFinalAssistantText({ runner: 'claude-code', cwd });
  show(`claude-code cwd≈${cwd}`, out);
}

// 2. OpenCode: find a real directory from the live DB, then read by cwd.
try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(process.env.HOME, '.local/share/opencode/opencode.db'), { open: true });
  const rows = db.prepare('select directory, time_updated from session order by time_updated desc limit 3').all();
  db.close();
  for (const r of rows) {
    const out = await readFinalAssistantText({ runner: 'opencode', cwd: r.directory, startedAt: new Date(r.time_updated - 6_000_000).toISOString() });
    show(`opencode cwd=${r.directory}`, out);
  }
} catch (e) {
  console.log('opencode check skipped:', e.message);
}

// 3. Codex: no rollouts on this box — expect null, which is the correct
//    degrade path.
show('codex (no store expected)', await readFinalAssistantText({ runner: 'codex', cwd: '/root' }));

// 4. Unknown runner: null.
show('unknown runner', await readFinalAssistantText({ runner: 'nope', cwd: '/root' }));
