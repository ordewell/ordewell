import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { HomeTranscriptReader } from '../transcriptCapture';

let fakeHome: string;
let reader: HomeTranscriptReader;

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), 'transcript-'));
  reader = new HomeTranscriptReader({ homeDir: fakeHome });
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

const CWD = '/repo/work';
const MUNGED = '-repo-work';

/** The prompt carries the marker in two halves, exactly as promptAugment writes it. */
const promptFor = (marker: string) =>
  `do the work. Build it by writing \`<<<ORDEWELL_\` immediately followed by \`DONE_${marker}>>>\``;

function claudeLine(type: string, body: object): string {
  return JSON.stringify({ type, ...body });
}

function claudeSession(file: string, marker: string, answer: string): void {
  writeFileSync(
    file,
    [
      claudeLine('user', { message: { role: 'user', content: [{ type: 'text', text: promptFor(marker) }] } }),
      claudeLine('assistant', { isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }),
    ].join('\n'),
  );
}

function codexRollout(file: string, cwd: string, marker: string, answer: string): void {
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session_meta', payload: { cwd, session_id: path.basename(file) } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: promptFor(marker) }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } }),
    ].join('\n'),
  );
}

function touch(file: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  utimesSync(file, t, t);
}

describe('HomeTranscriptReader', () => {
  it('returns null for an unknown runner', async () => {
    expect(await reader.finalAssistantText({ runner: 'unknown-agent', cwd: CWD, marker: 'mk-1' })).toBeNull();
  });

  it('returns null when no store exists at all', async () => {
    expect(await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, marker: 'mk-1' })).toBeNull();
  });

  describe('claude-code', () => {
    it('extracts the last non-sidechain assistant text block', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', MUNGED);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'aaaa.jsonl'),
        [
          claudeLine('user', { message: { role: 'user', content: [{ type: 'text', text: promptFor('mk-1') }] } }),
          claudeLine('assistant', { isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'first draft' }] } }),
          claudeLine('assistant', { isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'The migration is complete and tests pass.' }] } }),
          claudeLine('assistant', { isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
          'not json at all',
        ].join('\n'),
      );
      const out = await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, marker: 'mk-1' });
      expect(out).toBe('The migration is complete and tests pass.');
    });

    it('picks the transcript carrying this task\'s marker when parallel tasks share the cwd', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', MUNGED);
      mkdirSync(dir, { recursive: true });
      const startedAt = new Date(Date.now() - 30_000).toISOString();
      claudeSession(path.join(dir, 'task-a.jsonl'), 'mk-a', 'answer for task A');
      claudeSession(path.join(dir, 'task-b.jsonl'), 'mk-b', 'answer for task B');
      // B finished last, so a newest-file rule would hand B's answer to A.
      touch(path.join(dir, 'task-a.jsonl'), 10_000);

      const a = await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, startedAt, marker: 'mk-a' });
      const b = await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, startedAt, marker: 'mk-b' });

      expect(a).toBe('answer for task A');
      expect(b).toBe('answer for task B');
    });

    it('returns null when no transcript in the cwd carries the marker', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', MUNGED);
      mkdirSync(dir, { recursive: true });
      claudeSession(path.join(dir, 'other.jsonl'), 'mk-other', 'someone else\'s answer');

      expect(await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, marker: 'mk-1' })).toBeNull();
    });

    it('skips sessions last modified before the task started', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', MUNGED);
      mkdirSync(dir, { recursive: true });
      const old = path.join(dir, 'old.jsonl');
      claudeSession(old, 'mk-1', 'stale session');
      touch(old, 60_000);
      const out = await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, startedAt: new Date().toISOString(), marker: 'mk-1' });
      expect(out).toBeNull();
    });

    it('returns null when the matching transcript holds no assistant text', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', MUNGED);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'x.jsonl'), claudeLine('user', { message: { content: [{ type: 'text', text: promptFor('mk-1') }] } }));
      expect(await reader.finalAssistantText({ runner: 'claude-code', cwd: CWD, marker: 'mk-1' })).toBeNull();
    });
  });

  describe('in a task worktree (ADR-0013)', () => {
    const WORKTREE = '/repo/.ordewell/worktrees/a1b2c3d4/2-add_login';

    it('finds a claude-code transcript under the directory Claude Code names after every non-alphanumeric', async () => {
      const dir = path.join(fakeHome, '.claude', 'projects', '-repo--ordewell-worktrees-a1b2c3d4-2-add-login');
      mkdirSync(dir, { recursive: true });
      claudeSession(path.join(dir, 's.jsonl'), 'mk-1', 'answer from the worktree');

      expect(await reader.finalAssistantText({ runner: 'claude-code', cwd: WORKTREE, marker: 'mk-1' })).toBe('answer from the worktree');
    });

    it('finds a claude-code transcript whose directory name Claude Code shortened, among others sharing its prefix', async () => {
      // Claude Code keeps the first 200 characters of a longer name and appends a hash of the full path.
      const root = `/home/someone/${'deeply-nested-projects/'.repeat(6)}repo`;
      const worktree = `${root}/.ordewell/worktrees/a1b2c3d4/12-add-the-login-form-and-its-validation`;
      const shortened = worktree.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
      const projects = path.join(fakeHome, '.claude', 'projects');
      mkdirSync(path.join(projects, `${shortened}-1x9k2a`), { recursive: true });
      mkdirSync(path.join(projects, `${shortened}-7qp0zz`), { recursive: true });
      claudeSession(path.join(projects, `${shortened}-1x9k2a`, 'a.jsonl'), 'mk-other', 'another task');
      claudeSession(path.join(projects, `${shortened}-7qp0zz`, 'b.jsonl'), 'mk-1', 'answer from the long worktree');

      expect(await reader.finalAssistantText({ runner: 'claude-code', cwd: worktree, marker: 'mk-1' })).toBe('answer from the long worktree');
    });

    it('binds a codex rollout to the worktree, not to the workspace root', async () => {
      const day = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '25');
      mkdirSync(day, { recursive: true });
      codexRollout(path.join(day, 'rollout-root.jsonl'), '/repo', 'mk-1', 'from the root');
      codexRollout(path.join(day, 'rollout-wt.jsonl'), WORKTREE, 'mk-1', 'from the worktree');

      expect(await reader.finalAssistantText({ runner: 'codex', cwd: WORKTREE, marker: 'mk-1' })).toBe('from the worktree');
    });
  });

  describe('codex', () => {
    it('binds a rollout to the task cwd via session_meta and takes the last assistant message', async () => {
      const day = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '22');
      mkdirSync(day, { recursive: true });
      writeFileSync(
        path.join(day, 'rollout-2026-09-22T10-00-00-aaaa.jsonl'),
        [
          JSON.stringify({ type: 'session_meta', payload: { cwd: CWD, session_id: 'a1' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: promptFor('mk-1') }] } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'final codex answer' }] } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'user line is not the answer' }] } }),
        ].join('\n'),
      );
      // Same marker, another cwd: the cwd binding still rejects it.
      codexRollout(path.join(day, 'rollout-2026-09-22T11-00-00-bbbb.jsonl'), '/elsewhere', 'mk-1', 'wrong session');
      const out = await reader.finalAssistantText({ runner: 'codex', cwd: CWD, marker: 'mk-1' });
      expect(out).toBe('final codex answer');
    });

    it('picks the rollout carrying this task\'s marker when parallel tasks share the cwd', async () => {
      const day = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '24');
      mkdirSync(day, { recursive: true });
      const startedAt = new Date(Date.now() - 30_000).toISOString();
      codexRollout(path.join(day, 'rollout-a.jsonl'), CWD, 'mk-a', 'codex answer A');
      codexRollout(path.join(day, 'rollout-b.jsonl'), CWD, 'mk-b', 'codex answer B');
      touch(path.join(day, 'rollout-a.jsonl'), 10_000);

      expect(await reader.finalAssistantText({ runner: 'codex', cwd: CWD, startedAt, marker: 'mk-a' })).toBe('codex answer A');
      expect(await reader.finalAssistantText({ runner: 'codex', cwd: CWD, startedAt, marker: 'mk-b' })).toBe('codex answer B');
      expect(await reader.finalAssistantText({ runner: 'codex', cwd: CWD, startedAt, marker: 'mk-c' })).toBeNull();
    });
  });

  describe('opencode', () => {
    it('returns null when the database is absent', async () => {
      expect(await reader.finalAssistantText({ runner: 'opencode', cwd: CWD, marker: 'mk-1' })).toBeNull();
    });

    it('picks the session carrying this task\'s marker when parallel tasks share the cwd', async () => {
      let sqlite: typeof import('node:sqlite');
      try {
        sqlite = await import('node:sqlite');
      } catch {
        return; // Node < 22: the reader itself degrades to null here.
      }
      const dir = path.join(fakeHome, '.local', 'share', 'opencode');
      mkdirSync(dir, { recursive: true });
      const db = new sqlite.DatabaseSync(path.join(dir, 'opencode.db'));
      db.exec(`
        create table project (id text primary key);
        create table session (id text primary key, project_id text, directory text, time_updated integer);
        create table message (id text primary key, session_id text, data text);
        create table part (id text primary key, message_id text, data text);
        insert into project values ('p1');
      `);
      const now = Date.now();
      const addSession = (id: string, marker: string, answer: string, updated: number) => {
        db.prepare('insert into session values (?, ?, ?, ?)').run(id, 'p1', CWD, updated);
        db.prepare('insert into message values (?, ?, ?)').run(`msg_${id}_1`, id, '{"role":"user"}');
        db.prepare('insert into part values (?, ?, ?)').run(`prt_${id}_1`, `msg_${id}_1`, JSON.stringify({ type: 'text', text: promptFor(marker) }));
        db.prepare('insert into message values (?, ?, ?)').run(`msg_${id}_2`, id, '{"role":"assistant"}');
        db.prepare('insert into part values (?, ?, ?)').run(`prt_${id}_2`, `msg_${id}_2`, JSON.stringify({ type: 'text', text: answer }));
      };
      addSession('ses_a', 'mk-a', 'opencode answer A', now - 10_000);
      addSession('ses_b', 'mk-b', 'opencode answer B', now);
      db.close();
      const startedAt = new Date(now - 30_000).toISOString();

      expect(await reader.finalAssistantText({ runner: 'opencode', cwd: CWD, startedAt, marker: 'mk-a' })).toBe('opencode answer A');
      expect(await reader.finalAssistantText({ runner: 'opencode', cwd: CWD, startedAt, marker: 'mk-c' })).toBeNull();
    });
  });
});
