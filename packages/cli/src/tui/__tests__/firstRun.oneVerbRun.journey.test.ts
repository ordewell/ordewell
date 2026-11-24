import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleApprove } from '../../commands/approve';
import { stripAnsi } from '../ansi';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { completions, slashCommandTable } from '../slash';
import type { TaskView, TuiState } from '../state';
import { messagesOf } from './chat';
import { draftPlan, liveDaemon, type LiveDaemon, type Tui } from './liveDaemon';

/*
 * Machine B's first run (slug oneVerbRun), in the terminal UI and on the
 * command line. With autorun off the user was shown both /approve and /run for
 * one drafted plan and could not tell them apart, and a second /run on the plan
 * already running added a second "You started the plan." Decided: starting a
 * drafted plan has one verb, run; /approve still starts one and says approve is
 * now run; a /run on a running plan says it is already running.
 */

const task = (over: Partial<TaskView>): TaskView => ({
  id: 't1', order: 1, title: 'Add --shout to hello.py', type: 'ai', status: 'pending', dependencies: [], attempted: false, ...over,
});

const drafted: Partial<TuiState> = {
  sessionId: 'session-b',
  tasks: [task({}), task({ id: 't2', order: 2, title: 'Test --shout', dependencies: ['t1'] })],
};

function typedLine(text: string, over: Partial<TuiState> = {}) {
  const base = initialState(over);
  return reduce({ ...base, editor: { ...base.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
}

/** Every line the conversation gained after `before`. */
const linesSince = (before: TuiState, after: TuiState): string[] =>
  messagesOf(after).slice(messagesOf(before).length).map((m) => m.text);

const saysApproveIsRun = (line: string): boolean => /approve/i.test(line) && /is now/i.test(line) && /\brun\b/i.test(line);

describe('machine B, oneVerbRun: the terminal UI lists one verb for starting a plan', () => {
  it('has no /approve in the slash menu', () => {
    expect(completions('/').map((c) => c.name)).not.toContain('approve');
    expect(completions('/ap').map((c) => c.name)).not.toContain('approve');
    expect(completions('/').map((c) => c.name)).toContain('run');
  });

  it('has no /approve in the help list', () => {
    expect(slashCommandTable().map((c) => c.name)).not.toContain('approve');
    const help = render(initialState({ rows: 400, cols: 160, overlay: { kind: 'help', scroll: 0 } })).map(stripAnsi).join('\n');
    expect(help).toContain('/run');
    expect(help).not.toMatch(/\/approve\b/);
  });
});

describe('machine B, oneVerbRun: /approve typed on a drafted plan', () => {
  it('still starts the plan, and says in one line that approve is now run', () => {
    const before = initialState(drafted);
    const { state, effects } = typedLine('/approve', drafted);

    expect(effects).toEqual([{ type: 'execute', sessionId: 'session-b' }]);
    const said = linesSince(before, state).filter((line) => /approve/i.test(line));
    expect(said).toHaveLength(1);
    expect(saysApproveIsRun(said[0])).toBe(true);
    expect(messagesOf(state).filter((m) => m.role === 'error')).toEqual([]);
  });
});

describe('machine B, oneVerbRun: `ordewell approve` on the command line', () => {
  it('starts a drafted plan as `ordewell run` does, and says in one line that approve is now run', async () => {
    type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];
    const finished: Event[] = [{ type: 'execution_complete', summary: { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 } }];
    const api = {
      getSettings: vi.fn().mockRejectedValue(new Error('no settings here')),
      getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { status: 'draft', pendingTasks: [] } }),
      executePlan: vi.fn().mockResolvedValue({ status: 'running' }),
      approveReview: vi.fn().mockResolvedValue({ message: 'Plan approved: continuing execution.' }),
      streamExecution: vi.fn((_id: string, onEvent: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
        setTimeout(() => onReady?.(), 0);
        setTimeout(() => { finished.forEach(onEvent); resolve(); }, 5);
      })),
    } as unknown as ApiClient;
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { written.push(`${args.join(' ')}\n`); });
    const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { written.push(`${args.join(' ')}\n`); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);

    try {
      await handleApprove(['--session-id', 's1'], api);
    } finally {
      stderr.mockRestore();
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }

    expect(vi.mocked(api.executePlan)).toHaveBeenCalledTimes(1);
    const said = written.join('').split('\n').filter((line) => /approve/i.test(line));
    expect(said).toHaveLength(1);
    expect(saysApproveIsRun(said[0])).toBe(true);
    process.exitCode = undefined;
  });
});

describe('machine B, oneVerbRun: /run on a plan that is already running, over the real daemon', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  const press = (tui: Tui, name: 'enter' | 'char' | 'tab', char?: string) => tui.act({ type: 'key', key: { name, ...(char ? { char } : {}) } });
  /**
   * Typed into the composer and sent. Enter is not awaited, as the app's loop
   * does not await it: a /run's request follows the run until it ends.
   */
  async function typed(tui: Tui, text: string): Promise<void> {
    if (tui.state().focus !== 'chat') await press(tui, 'tab');
    expect(tui.state().focus).toBe('chat');
    for (const char of text) await press(tui, 'char', char);
    void press(tui, 'enter');
  }
  const started = (tui: Tui) => messagesOf(tui.state()).filter((m) => m.text === 'You started the plan.');

  it('answers that it is already running and adds no second "You started the plan."', async () => {
    daemon.save(draftPlan(), 's');
    const tui = daemon.tui({ wholeLoop: true });
    await tui.run({ type: 'loadSession', sessionId: 's' });
    // Each start the TUI asks of the daemon, settled once the daemon has answered it.
    const answered: Promise<unknown>[] = [];
    const execute = tui.api.executePlan.bind(tui.api);
    vi.spyOn(tui.api, 'executePlan').mockImplementation((...args) => {
      const reply = execute(...args);
      answered.push(reply.catch(() => undefined));
      return reply;
    });

    await typed(tui, '/run');
    await vi.waitFor(() => {
      expect(started(tui)).toHaveLength(1);
      expect(tui.state().status).toBe('executing');
    });
    const before = tui.state();

    await typed(tui, '/run');
    await vi.waitFor(() => expect(answered).toHaveLength(2));
    await answered[1];
    // What the daemon broadcasts of the second call reaches the socket after its answer.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(started(tui)).toHaveLength(1);
    expect(linesSince(before, tui.state()).filter((line) => /already running/i.test(line))).toHaveLength(1);
    expect(tui.state().status).toBe('executing');
  });
});
