import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EMPTY_TASK_LOG } from '@ordewell/core';
import { initialState, reduce, type Step } from '../reducer';
import { chatLayout, footerHints, planLayout } from '../layout';
import { chatPromptLabel } from '../geometry';
import { style } from '../ansi';
import { createInbound } from '../inbound';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { TaskLogState, TaskView, TuiState } from '../state';
import type { WsEvent } from '../../apiClient';

/**
 * A task paused on its runner's usage limit that resumes on its own (#84):
 * the row and the task view say when, `r` resumes it now, and `c` / `ctrl-x`
 * keep it from resuming on its own.
 */

const RESUME_AT = new Date(2026, 9, 11, 20, 10).toISOString();

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Fix the parser', type: 'ai', status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT,
  dependencies: [], assignedRunner: 'claude-code', continuable: true, ...over,
});

const state = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 60, cols: 220, focus: 'plan', tasks, ...over });
const frame = (tasks: TaskView[]): string => planLayout(state(tasks), 60, 200).lines.join('\n');
const press = (s: TuiState, char: string): Step => reduce(s, { type: 'key', key: { name: 'char', char } });

const opened = (tasks: TaskView[]): TuiState => {
  const tv: TaskLogState = { taskId: 't1', view: EMPTY_TASK_LOG, attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0 };
  return state(tasks, { focus: 'chat', taskView: tv });
};

beforeEach(() => {
  style.enabled = false;
  vi.useFakeTimers({ now: new Date(2026, 9, 11, 17, 0), toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a task paused on a usage limit in the TUI', () => {
  it('says on its row when it resumes, and how to resume it now or keep it from resuming', () => {
    const shown = frame([task()]);
    expect(shown).toContain('    paused on a usage limit · claude-code');
    expect(shown).toContain('⏸ resumes at 8:10pm, once the usage limit resets: r resume now · c don\'t resume');
  });

  it('says nothing of a resume once it waits for a manual retry, but still offers to resume it now', () => {
    const shown = frame([task({ resumeAt: undefined })]);
    expect(shown).toContain('    paused on a usage limit · claude-code');
    expect(shown).not.toContain('resumes at');
    expect(shown).toContain('⏸ waits for the usage limit to reset: r resume now');
    expect(frame([task({ resumeAt: undefined, continuable: false })])).not.toContain('r resume now');
  });

  it('resumes it now with r, with or without a resume time, and names that and skip in the footer', () => {
    const paused = state([task()]);
    expect(press(paused, 'r').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'resume-now', watch: true }]);
    expect(press(state([task({ resumeAt: undefined })]), 'r').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'resume-now', watch: true }]);
    expect(footerHints(paused)).toEqual(expect.arrayContaining(['r resume now', 's skip']));
    expect(footerHints(state([task({ resumeAt: undefined })]))).toEqual(expect.arrayContaining(['r resume now', 's skip']));

    expect(press(state([task({ continuable: false })]), 'r').effects).toEqual([]);
    expect(press(state([task({ status: 'failed', awaitingReason: undefined, resumeAt: undefined })]), 'r').effects).toEqual([]);
  });

  it('keeps it from resuming on its own with c, and names that plainly in the footer', () => {
    const paused = state([task()]);
    expect(press(paused, 'c').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel-resume' }]);
    expect(footerHints(paused)).toContain('c don\'t resume');

    const running = state([task({ status: 'in_progress', awaitingReason: undefined, resumeAt: undefined })]);
    expect(press(running, 'c').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel' }]);
    expect(footerHints(running)).toContain('c cancel');
  });

  it('says when it resumes in the task view, where ctrl-x keeps it from resuming', () => {
    const view = opened([task()]);
    const header = chatLayout(view, 30, 200).header;
    expect(header[0]).toContain('→ Task 1 · Fix the parser · claude-code · paused on a usage limit · resumes at 8:10pm');
    expect(header[1]).toContain('ctrl-x don\'t resume');
    expect(reduce(view, { type: 'key', key: { name: 'ctrl-x' } }).effects)
      .toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel-resume' }]);

    const manual = opened([task({ resumeAt: undefined })]);
    expect(reduce(manual, { type: 'key', key: { name: 'ctrl-x' } }).effects).toEqual([{ type: 'interruptTask', sessionId: 's1', taskId: 't1' }]);
  });

  it('resumes it from the task view\'s composer with what is typed, which follows the reset notice', () => {
    for (const paused of [task(), task({ resumeAt: undefined })]) {
      const view = { ...opened([paused]), editor: { ...opened([paused]).editor, text: 'limits reset, go on', cursor: 19 } };
      expect(chatLayout(view, 30, 200).lines.join('\n') + chatPromptLabel(view)).toContain('→ Resume task 1');
      expect(reduce(view, { type: 'key', key: { name: 'enter' } }).effects)
        .toEqual([{ type: 'continueTask', sessionId: 's1', taskId: 't1', text: 'limits reset, go on', watch: true }]);
    }
  });

  it('takes the resume time from a status update, and drops it when the update does', () => {
    const event = (resumeAt?: string): WsEvent => ({
      type: 'status_update',
      tasks: [{ id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'usage-limit', ...(resumeAt ? { resumeAt } : {}) }],
    }) as WsEvent;
    let current = state([task({ resumeAt: undefined })]);
    const receive = createInbound((action) => { current = reduce(current, action).state; }, 's1').receive;

    receive(event(RESUME_AT));
    expect(current.tasks[0].resumeAt).toBe(RESUME_AT);

    receive(event());
    expect(current.tasks[0].resumeAt).toBeUndefined();
  });

  it('asks the daemon to resume it now', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Resumed.' });
    const deps: EffectDeps = {
      api: { execute } as unknown as OrdewellApi,
      workspace: '/ws', port: 3742, dispatch: vi.fn(), newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true,
      login: async () => ({ ok: true }),
      exit: vi.fn(),
      reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
    };
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'resume-now' }, deps).catch(() => undefined);
    expect(execute).toHaveBeenCalledWith('s1', { command: 'retry_task', task: 't1', from: 'session' });
  });

  it('asks the daemon to cancel the resume, leaving what it says to the timeline', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'No longer resumes.' });
    const dispatch = vi.fn();
    const deps: EffectDeps = {
      api: { execute } as unknown as OrdewellApi,
      workspace: '/ws', port: 3742, dispatch, newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true,
      login: async () => ({ ok: true }),
      exit: vi.fn(),
      reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
    };
    // Only the request is pinned; the plan refresh after it has no daemon to reach.
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel-resume' }, deps).catch(() => undefined);
    expect(execute).toHaveBeenCalledWith('s1', { command: 'cancel_resume', task: 't1' });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'notice' }));
  });
});
