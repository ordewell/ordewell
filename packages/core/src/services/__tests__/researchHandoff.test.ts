import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { openTaskLog } from '../../utils/taskLogStore';
import { FakeWorktreeIsolation } from '../../testing';
import { applyTaskOps } from '../TaskOps';
import { validatePlanTasks } from '../PlanValidator';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig } from './sessionTestKit';

/**
 * Evidence a later task acts on is a task of its own that the later task
 * depends on (ADR-0037 R5), a research task when the planner must decide on
 * its report: its findings reach the later task as a handoff (ADR-0047), never
 * re-typed by the planner into its brief.
 */
const research = { title: 'Why does the cache serve stale entries?', description: 'Reports the evidence', type: 'ai' as const, prompt: 'Investigate', readOnly: true, research: true, autonomy: 'AFK' as const, sliceType: 'AFK' as const };
/** The research task as the plan holds it: read-only is its runner's read-only mode. */
const scout = (id: string, order: number) => createTask({ id, order, title: research.title, description: research.description, prompt: research.prompt, research: true, taskMode: 'plan', assignedRunner: 'claude-code' });
const fix = { title: 'Fix the cache key', description: 'Fixes it', type: 'ai' as const, prompt: 'Fix the cause the research names.', autonomy: 'AFK' as const, sliceType: 'AFK' as const };

describe('a task that depends on a research task (ADR-0037, ADR-0047)', () => {
  it('is a plan the validator accepts, and an edit task-ops accepts', () => {
    expect(validatePlanTasks({ tasks: [{ id: 'r', order: 1, ...research }, { id: 'f', order: 2, ...fix, dependencies: ['r'] }] }, ['claude-code']).ok).toBe(true);

    const added = applyTaskOps([scout('r', 1)], [{ op: 'add', task: { ...fix, dependencies: ['r'] } }], ['claude-code']);
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.tasks.find((t) => t.title === fix.title)?.dependencies).toEqual(['r']);
  });

  it('gets the research handoff in its prompt, and reads the report through read, as does a task further down', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-research-handoff-'));
    const agents: FakeRunnerSession[] = [];
    const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const agent = new FakeRunnerSession(`s${agents.length + 1}`, opts.taskId);
      agents.push(agent);
      return agent;
    });
    const promptOf = (taskId: string) => spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0];
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true }), isolation: new FakeWorktreeIsolation(),
      workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 },
    });
    try {
      session.loadPlan({
        tasks: [
          scout('r', 1),
          createTask({ id: 'f', order: 2, ...fix, assignedRunner: 'claude-code', dependencies: ['r'] }),
          createTask({ id: 'd', order: 3, title: 'Document the fix', prompt: 'Document it.', assignedRunner: 'claude-code', dependencies: ['f'] }),
        ],
        generatedAt: '', lastUpdated: '', status: 'approved', runners: ['claude-code'],
      }, 'Fix the stale cache', root);
      expect(taskOf(session, 'r')?.research).toBe(true);
      await session.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(agents).toHaveLength(1));
      expect(promptOf('f')).toBeUndefined();

      agents[0].reportComplete({
        status: 'done',
        summary: 'RESEARCH_SUMMARY: the cache key omits the tenant.',
        findings: [{ severity: 'blocker', title: 'RESEARCH_FINDING: key built without tenant', detail: 'src/cache/store.ts:42 builds the key from the path alone.' }],
        report: 'RESEARCH_REPORT: the failing test and its output.',
      });
      await vi.waitFor(() => expect(promptOf('f')).toBeDefined());
      expect(taskOf(session, 'r')?.status).toBe('completed');

      const prompt = promptOf('f')!.prompt!;
      expect(prompt).toContain('RESEARCH_SUMMARY: the cache key omits the tenant.');
      expect(prompt).toContain('F1 [blocker] RESEARCH_FINDING: key built without tenant');
      expect(prompt).toContain('src/cache/store.ts:42 builds the key from the path alone.');
      expect(prompt).not.toContain('RESEARCH_REPORT');

      const read = promptOf('f')!.readTask!;
      const handoff = (await read({ task: 'r', include_report: true })).text;
      expect(handoff).toContain('RESEARCH_SUMMARY');
      expect(handoff).toContain('RESEARCH_REPORT: the failing test and its output.');

      agents[1].reportComplete({ status: 'done', summary: 'Keyed the cache by tenant.' });
      await vi.waitFor(() => expect(promptOf('d')).toBeDefined());
      // Only direct dependencies are in the prompt; the research is a transitive one, read on demand.
      expect(promptOf('d')!.prompt).not.toContain('RESEARCH_SUMMARY');
      expect((await promptOf('d')!.readTask!({ task: 'r' })).text).toContain('RESEARCH_SUMMARY');
    } finally {
      session.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
