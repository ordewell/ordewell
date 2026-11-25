/*
 * A child plan's task held for configuration a sibling landed (ADR-0028,
 * ADR-0055 D20), on real repositories: the hold says what its subplanner can
 * do there, which a person can ask it for. Doing what it says starts the task.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { IRunner } from '../../interfaces/IRunner';
import { FakeRunnerSession, removeDir } from '../../testing';
import { closeSessions, type PlannerTurn as Turn } from './sessionTestKit';
import { roots, delegated, childTask, SUBMIT, tree, WAIT } from './childNavigationKit';

afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

type SpawnOptions = Parameters<IRunner['spawn']>[0];

const HOOK = '.claude/settings.json';
const SIGNAL = new AbortController().signal;
const ASKED = 'b is held for the hook a added: make it read-only and start it.';

/** A runner that writes `a`'s hook or each other task's file and reports done, noting each spawn and whether the hook was where it started. */
function hookRunner() {
  const spawns: { taskId: string; hook: boolean; options: SpawnOptions }[] = [];
  const runner: IRunner = {
    spawn: vi.fn(async (options: SpawnOptions) => {
      spawns.push({ taskId: options.taskId, hook: existsSync(join(options.cwd, HOOK)), options });
      const session = new FakeRunnerSession(`s-${options.taskId}-${spawns.length}`, options.taskId);
      setTimeout(() => {
        const file = options.taskId === 'a' ? HOOK : `${options.taskId}.txt`;
        mkdirSync(dirname(join(options.cwd, file)), { recursive: true });
        writeFileSync(join(options.cwd, file), options.taskId === 'a' ? '{"hooks":{}}\n' : `written by ${options.taskId}\n`);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, spawns };
}

/** The subplanner as the hold tells it to act, once a person asks: b made read-only and started. */
const asked: Turn = async (tools, text) => {
  if (!text.includes(ASKED)) return;
  const edit = await tools.editPlan!({ ops: [{ op: 'update', taskId: 'b', changes: { readOnly: true } }] }, { signal: SIGNAL });
  if (edit.isError) throw new Error(edit.text);
  const run = await tools.runTask!({ task: 'b' }, { signal: SIGNAL });
  if (run.isError) throw new Error(run.text);
};

describe.skipIf(!hasGit)('a child plan\'s task held for configuration its sibling landed', () => {
  it('is held with words a person can act on there, and starts once the subplanner does what they ask', async () => {
    const { runner, spawns } = hookRunner();
    // Guarded, the child's level too, where a start is held whatever its runner's mode (ADR-0028).
    const { parent } = tree({ d: [SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), ...Array.from({ length: 8 }, () => asked)] }, {
      runner, tasks: [delegated({ grants: ['delegate'] })], autonomous: false,
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(async () => expect((await parent.children.list()).length).toBe(1), WAIT);
    const [entry] = await parent.children.list();
    const child = (await parent.children.find(entry.sessionId))!;
    const holdOfB = () => child.view().run.tasks.find((t) => t.id === 'b')?.holdReason ?? '';
    await vi.waitFor(() => expect(holdOfB()).toContain(HOOK), WAIT);

    // What the person reads there: what they can ask the subplanner for, and no claim that a start of anyone's gets past it or not.
    expect(holdOfB()).toBe(`repository configuration "${HOOK}" differs from where this run started. The subplanner can make this task read-only, which loads no project configuration, and start it, or take it out of the plan and say why in its report; a person can ask it to with a message`);
    expect(holdOfB()).toContain('The subplanner can make this task read-only');
    expect(holdOfB()).toContain('a person can ask it to with a message');
    expect(holdOfB()).not.toContain('start this task yourself');
    expect(spawns.map((s) => s.taskId)).toEqual(['a']);

    expect(child.message(ASKED)).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(spawns.map((s) => s.taskId)).toEqual(['a', 'b']), WAIT);
    // Read-only, it loads no project configuration, though the hook is in its worktree.
    expect(spawns[1]).toMatchObject({ taskId: 'b', hook: true });
    // Claude Code's read-only mode, against a's own, Guarded's.
    expect(spawns.map((s) => s.options.mode)).toEqual(['auto', 'plan']);
    await vi.waitFor(() => expect(child.view().run.tasks.find((t) => t.id === 'b')?.status).toBe('completed'), WAIT);
    parent.destroy();
  });
});
