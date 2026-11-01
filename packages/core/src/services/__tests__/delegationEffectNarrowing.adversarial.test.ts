import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRunner } from '../../interfaces/IRunner';
import type { Task } from '../../models/Task';
import { FakeRunnerSession, fakeConfig } from '../../testing';
import { listChildSessions, loadChildSession } from '../../utils/sessionStore';
import { CALL, SUBMIT, check, childTask, delegated, removeRepos, tree } from './delegationTestKit';
import type { PlannerTurn } from './sessionTestKit';

/*
 * ADR-0056 M1/M9: a change at the root reaches the subtree at once, and a
 * child's script runs only a body covered at every level of the effect rules.
 * A child's mandate is carved once, so its `effectRules` are the root's rules
 * as they stood at that moment. Narrowing the root's allowlist while the child
 * runs must still reach the child: otherwise the user withdraws an effect and
 * the child keeps its old authority, unsealed, in the user's checkout.
 */

afterEach(removeRepos);

/** A script runner that records what each script was given, and passes at once. */
function scriptSpy() {
  const spawned: Parameters<IRunner['spawn']>[0][] = [];
  const runner: IRunner = {
    spawn: async (opts) => {
      spawned.push(opts);
      const session = new FakeRunnerSession(`script-${opts.taskId}-${spawned.length}`, opts.taskId);
      setTimeout(() => session.reportScriptExit({ outcome: 'passed' }), 5);
      return session;
    },
    stop: async () => undefined,
    stopAll: () => undefined,
    activeCount: 0,
  };
  return { spawned, runner };
}

/** The one child's plan as it stands on disk. */
function childPlanOf(root: string): readonly Task[] {
  const [sessionId] = listChildSessions('session-root', root);
  return (sessionId ? loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId })?.plan.tasks : undefined) ?? [];
}

const STOP = CALL({ status: 'blocked', summary: 'The effect was withdrawn.' });
const quiet = { signal: new AbortController().signal };
const tasks = () => [delegated({ grants: ['effect'] }), check({ taskMode: 'plan', readOnly: true })];
const pushScript = { id: 'push', order: 2, title: 'Push', description: 'push', type: 'script', sliceType: 'AFK', commands: [['git', 'push', 'origin', 'main']] };

describe('a root effect rule changed under a running child (ADR-0056 M1, M9)', () => {
  it('seals a child script the root no longer covers, rather than running it unsealed', async () => {
    const config = fakeConfig({ effectAllowlist: ['git push origin *'] });
    const scripts = scriptSpy();
    const narrow: PlannerTurn = async (tools) => {
      // The user withdraws the push rule after the child was carved: the tag rule remains, so the root still holds `effect`.
      config.effectAllowlist = ['git tag *'];
      const reply = await tools.runScript!({ title: 'Push', commands: [['git', 'push', 'origin', 'main']] }, quiet);
      if (reply.isError) throw new Error(reply.text);
    };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), narrow, STOP], { config, scriptRunner: scripts.runner, seals: true, tasks: tasks() });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(scripts.spawned.length).toBeGreaterThan(0), { timeout: 20_000 });
    expect(scripts.spawned[0]?.sealed).toBeTruthy();
    parent.destroy();
  });

  it('refuses at its start a script that landed covered and no longer is, whoever starts it', async () => {
    const config = fakeConfig({ effectAllowlist: ['git push origin *'] });
    const scripts = scriptSpy();
    // Landed unsealed under the push rule, which goes before the turn ends and the run starts it.
    const land: PlannerTurn = async (tools, text) => {
      await SUBMIT([childTask('a', 1), pushScript])(tools, text);
      config.effectAllowlist = ['git tag *'];
    };
    const { parent, root } = tree([land, STOP], { config, scriptRunner: scripts.runner, seals: true, tasks: tasks() });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => {
      const push = childPlanOf(root).find((task) => task.title === 'Push');
      expect(push?.status).toBe('failed');
      expect(push?.outputSummary?.reviewReason).toContain('effect rules');
    }, { timeout: 20_000 });
    expect(scripts.spawned).toEqual([]);
    parent.destroy();
  });

  it('reaches a child when the root widens too, or a rule put back could never cover anything', async () => {
    const config = fakeConfig({ effectAllowlist: ['git tag *'] });
    const scripts = scriptSpy();
    const widen: PlannerTurn = async (tools) => {
      config.effectAllowlist = ['git tag *', 'git push origin *'];
      const reply = await tools.runScript!({ title: 'Push', commands: [['git', 'push', 'origin', 'main']] }, quiet);
      if (reply.isError) throw new Error(reply.text);
    };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), widen, STOP], { config, scriptRunner: scripts.runner, seals: true, tasks: tasks() });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(scripts.spawned.length).toBeGreaterThan(0), { timeout: 20_000 });
    expect(scripts.spawned[0]?.sealed).toBeUndefined();
    parent.destroy();
  });
});
