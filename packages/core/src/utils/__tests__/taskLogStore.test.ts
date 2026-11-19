import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listTaskLogAttempts, openTaskLog, prepareTaskOutputFile, readTaskLog, readTaskPatch, saveTaskPatch, type TaskLogLocation } from '../taskLogStore';
import { deleteSession, saveSession, sessionDataDir } from '../sessionStore';
import { createEmptyPlan } from '../../models/Task';
import { toTaskLogEvent, type TaskLogEvent } from '../../models/TaskLog';

describe('taskLogStore', () => {
  let baseDir: string;
  let where: TaskLogLocation;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tasklog-'));
    where = { baseDir, sessionId: 'session-abc' };
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const turn: TaskLogEvent[] = [
    { type: 'turn_start', message: 'Do the task' },
    { type: 'text', text: 'Done.' },
  ];

  it('creates the attempt’s file when the attempt starts, under the session’s own directory', () => {
    const file = openTaskLog(where, 'task-1');
    const onDisk = path.join(baseDir, '.ordewell', 'sessions', 'session-abc', 'tasks', 'task-1', '1.jsonl');
    expect(file.attempt).toBe(1);
    expect(fs.readFileSync(onDisk, 'utf-8')).toBe('');
  });

  it("keeps a read-only attempt's patch beside its log, replaced whole by a later save, and no attempt of its own (ADR-0050)", () => {
    openTaskLog(where, 'task-1');
    const file = saveTaskPatch(where, 'task-1', 1, Buffer.from('diff --git a/a b/a\n'));
    expect(file).toBe(path.join(sessionDataDir('session-abc', baseDir), 'tasks', 'task-1', '1.patch'));
    saveTaskPatch(where, 'task-1', 1, Buffer.from('diff --git a/b b/b\n'));

    expect(readTaskPatch(where, 'task-1', 1)?.toString()).toBe('diff --git a/b b/b\n');
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['1.jsonl', '1.patch']);
    expect(listTaskLogAttempts(where, 'task-1')).toEqual([1]);
    expect(readTaskPatch(where, 'task-1', 2)).toBeUndefined();
    expect(readTaskPatch(where, 'task-1', 0)).toBeUndefined();
  });

  it('appends events as JSON lines and reads them back in order', () => {
    const file = openTaskLog(where, 'task-1');
    file.append(turn.slice(0, 1));
    file.append(turn.slice(1));
    expect(readTaskLog(where, 'task-1', 1)).toEqual(turn);
    const raw = fs.readFileSync(path.join(sessionDataDir('session-abc', baseDir), 'tasks', 'task-1', '1.jsonl'), 'utf-8');
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
  });

  it('keeps the upstream and generation id a usage record names across a save and a read', () => {
    const record = { source: 'ordewell', model: 'deepseek/deepseek-v4.1-flash', inputTokens: 9000, cachedInputTokens: 8704, provider: 'DeepInfra', generationId: 'gen-1763400000-dsk' };
    const logged = toTaskLogEvent({ type: 'usage', record });
    expect(logged).not.toBeNull();
    openTaskLog(where, 'task-1').append([logged as TaskLogEvent]);
    expect(readTaskLog(where, 'task-1', 1)).toEqual([{ type: 'usage', record }]);
  });

  it('prepares a script attempt\u2019s whole-output file beside its log, which is not itself an attempt', () => {
    const file = prepareTaskOutputFile(where, 'task-1', 2);

    expect(file).toBe(path.join(sessionDataDir('session-abc', baseDir), 'tasks', 'task-1', '2.output.txt'));
    expect(fs.statSync(path.dirname(file)).isDirectory()).toBe(true);
    fs.writeFileSync(file, 'whole output');
    expect(listTaskLogAttempts(where, 'task-1')).toEqual([]);
    expect(fs.readFileSync(path.join(baseDir, '.ordewell', '.gitignore'), 'utf-8')).not.toBe('');
  });

  it('keeps one file per attempt, numbered on from what is already on disk', () => {
    openTaskLog(where, 'task-1').append(turn);
    const second = openTaskLog(where, 'task-1');
    second.append([{ type: 'turn_start', message: 'Try again' }]);
    expect(second.attempt).toBe(2);
    expect(listTaskLogAttempts(where, 'task-1')).toEqual([1, 2]);
    expect(readTaskLog(where, 'task-1', 1)).toEqual(turn);
    expect(readTaskLog(where, 'task-1', 2)).toEqual([{ type: 'turn_start', message: 'Try again' }]);
    expect(listTaskLogAttempts(where, 'task-2')).toEqual([]);
  });

  it('saves an attempt under the number it was given, and never over a file already saved', () => {
    expect(openTaskLog(where, 'task-1', 3).attempt).toBe(3);
    expect(openTaskLog(where, 'task-1', 3).attempt).toBe(4);
    expect(openTaskLog(where, 'task-1', 1).attempt).toBe(1);
    expect(openTaskLog(where, 'task-1', 1).attempt).toBe(5);
    expect(listTaskLogAttempts(where, 'task-1')).toEqual([1, 3, 4, 5]);
  });

  it('skips a line cut off mid-write and keeps what was saved before it', () => {
    openTaskLog(where, 'task-1').append(turn);
    const file = path.join(sessionDataDir('session-abc', baseDir), 'tasks', 'task-1', '1.jsonl');
    fs.appendFileSync(file, '{"type":"text","te');
    expect(readTaskLog(where, 'task-1', 1)).toEqual(turn);
  });

  it('answers empty for an attempt with no log', () => {
    expect(readTaskLog(where, 'task-1', 3)).toEqual([]);
    expect(readTaskLog(where, 'task-1', 0)).toEqual([]);
  });

  it('keeps an id that could climb out of its directory inside it', () => {
    const file = openTaskLog({ baseDir, sessionId: '../../escape' }, '../x');
    file.append(turn);
    const sessions = path.join(baseDir, '.ordewell', 'sessions');
    expect(fs.readdirSync(sessions)).toHaveLength(1);
    expect(fs.existsSync(path.join(baseDir, 'escape'))).toBe(false);
    expect(readTaskLog({ baseDir, sessionId: '../../escape' }, '../x', 1)).toEqual(turn);
  });

  it('is deleted with its session', () => {
    const plan = createEmptyPlan();
    const meta = saveSession(plan, 'goal', baseDir, 'session-abc');
    openTaskLog(where, 'task-1').append(turn);
    expect(deleteSession(meta.id, baseDir)).toBe(true);
    expect(fs.existsSync(sessionDataDir('session-abc', baseDir))).toBe(false);
    expect(listTaskLogAttempts(where, 'task-1')).toEqual([]);
  });
});
