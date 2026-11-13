import { describe, it, expect, vi } from 'vitest';
import { createTask, type DaemonErrorCode, type ExecutionCommand, type MergeWordingHandoff, type Task, type TaskRevertPreview } from '@ordewell/core';
import { ChatSessionHost, type ChatTurn, type SessionPort, type TurnOutcome } from '../ChatSessionHost';
import type { ConfirmationRequest } from '../confirmations';
import { ConversationViewHost } from '../ConversationViewHost';
import type { MergeAnswer, MergeYes } from '../MergeAll';
import { TaskActions } from '../TaskControls';
import type { HostToWebview } from '../../protocol';

/**
 * A session the test drives: `busy` is the turn the surface saw open, and
 * each turn it is asked for is answered with what `answer` returns. The task
 * controls record what reached the seam, what the user was asked and what was
 * refused, and answer from `state`. The merge seam answers each call with the
 * next of `state.merges`, an Error being a refusal the seam throws.
 */
function harness(answer: (text: string, turn: ChatTurn) => TurnOutcome | Promise<TurnOutcome> = () => ({ ok: true })) {
  const posts: HostToWebview[] = [];
  const conversation = new ConversationViewHost((msg) => posts.push(msg));
  const notes = vi.spyOn(conversation, 'note');
  const turns: { text: string; turn: ChatTurn }[] = [];
  const state = {
    busy: false,
    answering: 0,
    tasks: [] as Task[],
    advances: false,
    gate: [] as string[],
    preview: { revertible: true, tasks: [] } as TaskRevertPreview,
    /** What the user does with a question: the one choice offered, or a dismissal as the surface says it. */
    reply: 'accept' as 'accept' | null | undefined,
    /** What the seam says to a command, thrown in its own words. */
    seamRefuses: undefined as string | undefined,
    handoff: undefined as MergeWordingHandoff | undefined,
    executing: false,
    merges: [] as (MergeAnswer | Error)[],
  };
  /** The yeses each call at the merge seam carried, and how many times a Merge all took the seam up. */
  const merged: MergeYes[] = [];
  let mergeCalls = 0;
  const executed: ExecutionCommand[] = [];
  const asked: ConfirmationRequest[] = [];
  const refused: string[] = [];
  const events: string[] = [];
  const port: SessionPort = {
    generating: () => state.busy || state.answering > 0,
    answering: () => state.answering > 0,
    converse: async (text, turn) => {
      turns.push({ text, turn });
      state.answering += 1;
      try {
        return await answer(text, turn);
      } finally {
        state.answering -= 1;
      }
    },
    tasks: () => state.tasks,
    advancesOnItsOwn: () => state.advances,
    mergeGate: vi.fn(async () => state.gate),
    revertPreview: vi.fn(async () => state.preview),
    execute: async (command) => {
      events.push(`execute ${command.command}`);
      if (state.seamRefuses) throw new Error(state.seamRefuses);
      executed.push(command);
    },
    ask: async (request) => {
      asked.push(request);
      return state.reply === 'accept' ? request.choices[0]?.id : state.reply;
    },
    starting: async (start) => {
      events.push('starting');
      await start();
    },
    refuse: (error) => { refused.push(error instanceof Error ? error.message : String(error)); },
    executePlan: vi.fn(async () => undefined),
    stopped: () => { events.push('stopped'); },
    cancelPlannerResend: vi.fn(async () => undefined),
    retryPlannerCompaction: vi.fn(async () => undefined),
    settled: vi.fn(),
    handoff: () => state.handoff,
    isExecuting: () => state.executing,
    mergeCall: () => {
      mergeCalls += 1;
      return async (yes) => {
        merged.push(yes);
        const answer = state.merges.shift() ?? { kind: 'done' as const };
        if (answer instanceof Error) throw answer;
        return answer;
      };
    },
  };
  const chat = new ChatSessionHost(conversation, port);
  return {
    chat, conversation, state, turns, port, executed, asked, refused, events, merged,
    mergeCalls: () => mergeCalls,
    sent: () => turns.map((t) => [t.text, t.turn.now]),
    held: () => posts.filter((m): m is Extract<HostToWebview, { type: 'heldPrompts' }> => m.type === 'heldPrompts').at(-1)?.prompts ?? [],
    unsent: () => posts.flatMap((m) => (m.type === 'promptUnsent' ? [m.text] : [])),
    userNotes: () => notes.mock.calls.filter(([role]) => role === 'user').map(([, text]) => text),
  };
}

describe('ChatSessionHost', () => {
  it('holds a prompt typed while a turn holds the session, and sends one typed after it as the user\'s', async () => {
    const h = harness();
    h.state.busy = true;

    await h.chat.send('and add tests', true);
    expect(h.held()).toEqual(['and add tests']);
    expect(h.turns).toEqual([]);

    h.state.busy = false;
    await h.chat.send('ship it', true, ['claude-code']);
    // What was held goes after that turn, never ahead of it.
    expect(h.turns).toEqual([
      { text: 'ship it', turn: { now: false, runners: ['claude-code'] } },
      { text: 'and add tests', turn: { now: false } },
    ]);
    expect(h.userNotes()).toEqual(['ship it', 'and add tests']);
  });

  it('answers a button\'s message at once, neither held nor shown as the user\'s', async () => {
    const h = harness();
    h.state.busy = true;

    await h.chat.send('Approve the plan', false);

    expect(h.sent()).toEqual([['Approve the plan', false]]);
    expect(h.userNotes()).toEqual([]);
  });

  it('holds what the chat held only while a turn still holds the session', () => {
    const h = harness();
    h.state.busy = true;
    expect(h.chat.hold('one')).toBe(true);
    h.state.busy = false;
    expect(h.chat.hold('two')).toBe(false);

    expect(h.held()).toEqual(['one']);
  });

  it('takes back the newest held prompt, into the composer when asked', () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('one');
    h.chat.hold('two');

    h.chat.unsend(true);

    expect(h.held()).toEqual(['one']);
    expect(h.unsent()).toEqual(['two']);
  });

  it('sends what was held during its turn, glued, once that turn has returned', async () => {
    const h = harness((text) => {
      if (text === 'first') { h.chat.hold('one'); h.chat.hold('two'); }
      return { ok: true };
    });

    await h.chat.send('first', true);

    expect(h.sent()).toEqual([['first', false], ['one\ntwo', false]]);
    expect(h.held()).toEqual([]);
    expect(h.userNotes()).toEqual(['first', 'one\ntwo']);
  });

  it('releases after its own turn though the surface has not yet seen the turn close', async () => {
    const h = harness((text) => {
      // Over a daemon the answer can come in before the frame that ends the turn.
      if (text === 'first') { h.state.busy = true; h.chat.hold('one'); }
      return { ok: true };
    });

    await h.chat.send('first', true);

    expect(h.sent()).toEqual([['first', false], ['one', false]]);
  });

  it('releases on demand only once no turn holds the session', async () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('typed during the retry');

    await h.chat.release();
    expect(h.turns).toEqual([]);

    h.state.busy = false;
    await h.chat.release();
    expect(h.sent()).toEqual([['typed during the retry', false]]);
  });

  it('sends now everything held with the draft last, stopping the turn in flight', async () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('one');
    h.chat.hold('two');

    await h.chat.sendNow('three');

    expect(h.sent()).toEqual([['one\ntwo\nthree', true]]);
    expect(h.held()).toEqual([]);
    expect(h.unsent()).toEqual([]);
    expect(h.userNotes()).toEqual(['one\ntwo\nthree']);
  });

  it('sends now with no turn in flight as a plain send, and nothing at all when nothing is held or typed', async () => {
    const h = harness();

    await h.chat.sendNow('');
    await h.chat.sendNow('a normal reply');

    expect(h.sent()).toEqual([['a normal reply', false]]);
  });

  it.each<[string, DaemonErrorCode | undefined, string[]]>([
    ['refused', 'planner_not_ready', ['one\nthree']],
    ['busy', 'conversation_busy', ['one\nthree']],
    ['failed with no code', undefined, ['one\nthree']],
    ['stopped', 'planner_turn_stopped', []],
    ['discarded with the session left', 'planner_turn_discarded', []],
  ])('gives back what a send now took only when its turn was not stopped or left (%s)', async (_case, code, unsent) => {
    const h = harness(() => ({ ok: false, ...(code ? { code } : {}) }));
    h.state.busy = true;
    h.chat.hold('one');

    await h.chat.sendNow('three');

    expect(h.unsent()).toEqual(unsent);
    expect(h.held()).toEqual([]);
  });

  it('sends what was typed during a send now once its turn returns, after giving back what it took', async () => {
    const order: string[] = [];
    const h = harness((text, turn) => {
      if (turn.now) { h.chat.hold('typed meanwhile'); order.push('forced'); return { ok: false, code: 'planner_not_ready' }; }
      order.push(`sent ${text} with ${h.unsent().join('|')} given back`);
      return { ok: true };
    });
    h.state.busy = true;

    const forced = h.chat.sendNow('use Postgres');
    h.state.busy = false;
    await forced;

    expect(order).toEqual(['forced', 'sent typed meanwhile with use Postgres given back']);
  });
});

const ai = (id: string, order: number, title: string, overrides: Partial<Task> = {}): Task => createTask({ id, order, title, ...overrides });

describe('ChatSessionHost system commands', () => {
  describe('the one-command actions', () => {
    it.each([
      ['cancel', { command: 'stop_task', task: 't1' }],
      ['cancelResume', { command: 'cancel_resume', task: 't1' }],
      ['resumeNow', { command: 'retry_task', task: 't1', from: 'session' }],
      ['retry', { command: 'retry_task', task: 't1', from: 'fresh' }],
      // Skip lands nothing, so it is never a mark: it carries no override and asks nothing.
      ['skip', { command: 'skip_task', task: 't1' }],
    ] as const)('%s is that one command at the seam, asked of no one', async (command, sent) => {
      const h = harness();

      await h.chat.systemCommand(command, 't1');

      expect(h.executed).toEqual([sent]);
      expect(h.asked).toEqual([]);
      expect(h.refused).toEqual([]);
    });
  });

  describe('Mark complete and Mark not done (ADR-0029)', () => {
    it('signs off a manual task for the user, asking nothing', async () => {
      const h = harness();
      h.state.tasks = [ai('t1', 1, 'Review by hand', { type: 'user' })];

      await h.chat.systemCommand('markComplete', 't1');

      expect(h.executed).toEqual([{ command: 'mark_complete', task: 't1' }]);
      expect(h.asked).toEqual([]);
    });

    it('asks first about an AI task, naming it, and sends the yes with the status the user was asked about', async () => {
      const h = harness();
      h.state.tasks = [ai('t1', 1, 'Build')];

      await h.chat.systemCommand('markComplete', 't1');

      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]).toMatchObject({ kind: 'manual_override', choices: [{ id: 'override', label: 'Mark complete' }] });
      expect(h.asked[0]?.message).toContain('#1 Build');
      expect(h.executed).toEqual([{ command: 'mark_complete', task: 't1', confirmed: true, seen: 'pending' }]);
    });

    it('finds a subtask by walking the plan, and names it by its dotted ref', async () => {
      const h = harness();
      h.state.tasks = [ai('parent', 1, 'Parent', { subtasks: [ai('child', 1, 'Child', { status: 'completed' })] })];

      await h.chat.systemCommand('markIncomplete', 'child');

      expect(h.asked[0]?.message).toContain('#1.1 Child');
      expect(h.executed).toEqual([{ command: 'mark_not_done', task: 'child', confirmed: true, seen: 'completed' }]);
      expect(h.asked[0]?.choices).toEqual([{ id: 'override', label: 'Mark not done' }]);
    });

    it.each([['null', null], ['undefined', undefined]])('overrides nothing when the dialog is dismissed (%s)', async (_surface, reply) => {
      const h = harness();
      h.state.tasks = [ai('t1', 1, 'Build')];
      h.state.reply = reply;

      await h.chat.systemCommand('markComplete', 't1');

      expect(h.asked).toHaveLength(1);
      expect(h.executed).toEqual([]);
      expect(h.refused).toEqual([]);
    });

    it('says to stop the run first while one could move the task on, and asks nothing', async () => {
      const h = harness();
      h.state.tasks = [ai('t1', 1, 'Build')];
      h.state.advances = true;

      await h.chat.systemCommand('markIncomplete', 't1');

      expect(h.asked).toEqual([]);
      expect(h.executed).toEqual([]);
      expect(h.refused).toHaveLength(1);
      expect(h.refused[0]).toContain('Task #1 Build cannot be marked not done');
      expect(h.refused[0]).toContain('Stop the run first');
    });

    it('leaves a task the plan does not hold to the seam, which names what it refuses', async () => {
      const h = harness();
      h.state.seamRefuses = 'No task ghost.';

      await h.chat.systemCommand('markComplete', 'ghost');

      expect(h.asked).toEqual([]);
      expect(h.refused).toEqual(['No task ghost.']);
    });

    it('tells the user in the seam\'s words when the task moved on while the dialog was open', async () => {
      const h = harness();
      h.state.tasks = [ai('t1', 1, 'Build')];
      h.state.seamRefuses = 'Task t1 has changed since you were asked.';

      await h.chat.systemCommand('markComplete', 't1');

      expect(h.refused).toEqual(['Task t1 has changed since you were asked.']);
      expect(h.port.settled).toHaveBeenCalledOnce();
    });
  });

  describe('Revert (ADR-0054)', () => {
    const preview: TaskRevertPreview = {
      revertible: true,
      tasks: [
        { taskId: 't2', order: 2, title: 'Fix', repos: ['.'], dependent: false },
        { taskId: 't3', order: 3, title: 'Docs', repos: ['.'], dependent: true },
      ],
    };

    it('shows what goes with the task, and the yes carries the ids the user was shown', async () => {
      const h = harness();
      h.state.preview = preview;

      await h.chat.systemCommand('revertTask', 't2');

      expect(h.port.revertPreview).toHaveBeenCalledWith('t2');
      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]).toMatchObject({ kind: 'revert_task', choices: [{ id: 'revert', label: 'Revert' }] });
      expect(h.asked[0]?.detail).toContain('#3 Docs (goes with it)');
      expect(h.executed).toEqual([{ command: 'revert_task', task: 't2', confirmed: true, seen: ['t2', 't3'] }]);
    });

    it.each([['null', null], ['undefined', undefined]])('reverts nothing when the dialog is dismissed (%s)', async (_surface, reply) => {
      const h = harness();
      h.state.preview = preview;
      h.state.reply = reply;

      await h.chat.systemCommand('revertTask', 't2');

      expect(h.executed).toEqual([]);
      expect(h.refused).toEqual([]);
    });

    it('says core\'s reason a task cannot be reverted, and asks nothing', async () => {
      const h = harness();
      h.state.preview = { revertible: false, reason: 'no-landing', message: 'Nothing of this task has landed.' };

      await h.chat.systemCommand('revertTask', 't2');

      expect(h.asked).toEqual([]);
      expect(h.executed).toEqual([]);
      expect(h.refused).toEqual(['Nothing of this task has landed.']);
    });

    it('says a revert the seam refuses after the yes, such as a plan that changed meanwhile', async () => {
      const h = harness();
      h.state.preview = preview;
      h.state.seamRefuses = 'The plan changed since you were shown the revert.';

      await h.chat.systemCommand('revertTask', 't2');

      expect(h.refused).toEqual(['The plan changed since you were shown the revert.']);
    });
  });

  describe('Force start and Run past a merge gate (ADR-0020)', () => {
    it('asks naming the unmerged work as the plan titles it, and force starts on a yes, as a start', async () => {
      const h = harness();
      h.state.tasks = [ai('fix', 1, 'Fix'), ai('ops', 2, 'Deploy', { dependencies: ['fix'] })];
      h.state.gate = ['fix', 'ghost'];

      await h.chat.systemCommand('forceStart', 'ops');

      expect(h.asked).toHaveLength(1);
      expect(h.asked[0]).toMatchObject({ kind: 'start_past_gate', choices: [{ id: 'start', label: 'Start anyway' }] });
      // An id the plan does not hold stays bare, as it is.
      expect(h.asked[0]?.message).toContain('the work of #1 Fix, ghost is not merged into your branch yet');
      expect(h.events).toEqual(['starting', 'execute force_start']);
      expect(h.executed).toEqual([{ command: 'force_start', task: 'ops' }]);
    });

    it.each([['null', null], ['undefined', undefined]])('starts nothing, and clears nothing, when the dialog is dismissed (%s)', async (_surface, reply) => {
      const h = harness();
      h.state.gate = ['fix'];
      h.state.reply = reply;

      await h.chat.systemCommand('forceStart', 'ops');

      expect(h.events).toEqual([]);
      expect(h.executed).toEqual([]);
    });

    it('asks nothing of a task no gate holds', async () => {
      const h = harness();

      await h.chat.systemCommand('forceStart', 'ops');

      expect(h.asked).toEqual([]);
      expect(h.executed).toEqual([{ command: 'force_start', task: 'ops' }]);
      expect(h.events).toEqual(['starting', 'execute force_start']);
    });

    it('says a start the seam refused, from inside the start the surface wrapped', async () => {
      const h = harness();
      h.state.seamRefuses = 'Another task is starting.';

      await h.chat.systemCommand('forceStart', 'ops');

      expect(h.events).toEqual(['starting', 'execute force_start']);
      expect(h.refused).toEqual(['Another task is starting.']);
    });

    it('Run on a gated task is a force start, asked first, off the one read of the gate', async () => {
      const h = harness();
      h.state.tasks = [ai('fix', 1, 'Fix')];
      h.state.gate = ['fix'];

      await h.chat.systemCommand('runTask', 'ops');

      expect(h.port.mergeGate).toHaveBeenCalledTimes(1);
      expect(h.asked).toHaveLength(1);
      expect(h.executed).toEqual([{ command: 'force_start', task: 'ops' }]);
    });

    it('Run on a gated task starts nothing when the user says no', async () => {
      const h = harness();
      h.state.gate = ['fix'];
      h.state.reply = null;

      await h.chat.systemCommand('runTask', 'ops');

      expect(h.executed).toEqual([]);
    });

    it('Run on an ungated task is run_task as a start, asking nothing', async () => {
      const h = harness();

      await h.chat.systemCommand('runTask', 'ops');

      expect(h.asked).toEqual([]);
      expect(h.events).toEqual(['starting', 'execute run_task']);
      expect(h.executed).toEqual([{ command: 'run_task', task: 'ops' }]);
    });

    it('a force start given a gate its caller already read does not read it again', async () => {
      const h = harness();
      h.state.tasks = [ai('fix', 1, 'Fix')];

      await new TaskActions(h.port).forceStart('ops', ['fix']);

      expect(h.port.mergeGate).not.toHaveBeenCalled();
      expect(h.asked).toHaveLength(1);
    });
  });

  describe('the run-wide controls', () => {
    it('stops the run at the seam, then lets the surface stop what it holds of it', async () => {
      const h = harness();

      await h.chat.systemCommand('stopExecution', '');

      expect(h.events).toEqual(['execute stop_run', 'stopped']);
      expect(h.executed).toEqual([{ command: 'stop_run' }]);
    });

    it('keeps the surface\'s run when the seam refuses the stop', async () => {
      const h = harness();
      h.state.seamRefuses = 'The run could not be stopped.';

      await h.chat.systemCommand('stopExecution', '');

      expect(h.events).toEqual(['execute stop_run']);
      expect(h.refused).toEqual(['The run could not be stopped.']);
    });

    it('hands Execute the request it answers, for the surface to settle', async () => {
      const h = harness();

      await h.chat.systemCommand('executePlan', '', 7);

      expect(h.port.executePlan).toHaveBeenCalledWith(7);
      expect(h.executed).toEqual([]);
    });

    it('cancels a planner resend and retries a compaction through the surface', async () => {
      const h = harness();

      await h.chat.systemCommand('cancelPlannerResend', '');
      await h.chat.systemCommand('retryPlannerCompaction', '');

      expect(h.port.cancelPlannerResend).toHaveBeenCalledOnce();
      expect(h.port.retryPlannerCompaction).toHaveBeenCalledOnce();
      expect(h.executed).toEqual([]);
    });

    it('says a refused retry as any control\'s refusal', async () => {
      const h = harness();
      vi.mocked(h.port.retryPlannerCompaction).mockRejectedValueOnce(new Error('The planner is not paused on its context.'));

      await h.chat.systemCommand('retryPlannerCompaction', '');

      expect(h.refused).toEqual(['The planner is not paused on its context.']);
    });
  });

  describe('however a command ends', () => {
    it.each(['skip', 'markComplete', 'revertTask', 'forceStart', 'runTask', 'stopExecution', 'executePlan', 'retryPlannerCompaction', 'nothing-we-know'])(
      'draws the plan from what the session holds after %s, whether it landed, was refused or threw',
      async (command) => {
        const landed = harness();
        await landed.chat.systemCommand(command, 't1');
        expect(landed.port.settled).toHaveBeenCalledOnce();

        const threw = harness();
        threw.state.seamRefuses = 'refused';
        vi.mocked(threw.port.mergeGate).mockRejectedValue(new Error('refused'));
        vi.mocked(threw.port.revertPreview).mockRejectedValue(new Error('refused'));
        vi.mocked(threw.port.executePlan).mockRejectedValue(new Error('refused'));
        vi.mocked(threw.port.retryPlannerCompaction).mockRejectedValue(new Error('refused'));
        await expect(threw.chat.systemCommand(command, 't1')).resolves.toBeUndefined();
        expect(threw.refused).toEqual(command === 'nothing-we-know' ? [] : ['refused']);
        expect(threw.port.settled).toHaveBeenCalledOnce();
      },
    );

    it('ignores a command it does not know, which a newer webview may send', async () => {
      const h = harness();

      await h.chat.systemCommand('nothing-we-know', 't1');

      expect(h.executed).toEqual([]);
      expect(h.asked).toEqual([]);
      expect(h.refused).toEqual([]);
    });

    it('is not a turn: what was typed meanwhile waits for the surface to release it', async () => {
      const h = harness();
      h.state.busy = true;
      h.chat.hold('and add tests');
      h.state.busy = false;

      await h.chat.systemCommand('skip', 't1');
      expect(h.turns).toEqual([]);
      expect(h.held()).toEqual(['and add tests']);

      await h.chat.release();
      expect(h.sent()).toEqual([['and add tests', false]]);
    });
  });
});

describe('ChatSessionHost Merge all (ADR-0020, ADR-0055 D9)', () => {
  const held = (hold: 'pastChecks' | 'besideOps', message: string): MergeAnswer => ({ kind: 'held', hold, message });
  const onMain: MergeWordingHandoff = { repos: [{ path: '.', baseBranch: 'main', landed: [] }] };

  it('asks first, naming where it lands and the checkout rule it insists on, and sends nothing on a no', async () => {
    const h = harness();
    h.state.handoff = onMain;
    h.state.reply = null;

    await expect(h.chat.mergeAll()).resolves.toBe(false);

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ kind: 'merge_all' });
    expect(h.asked[0]!.message).toContain('into main.');
    expect(h.asked[0]!.message).toContain('Nothing is merged unless main is checked out.');
    expect(h.mergeCalls()).toBe(0);
  });

  it('merges once the person said yes, with no yes given beforehand', async () => {
    const h = harness();

    await expect(h.chat.mergeAll()).resolves.toBe(true);

    expect(h.merged).toEqual([{}]);
    expect(h.asked.map((q) => q.kind)).toEqual(['merge_all']);
  });

  it('reads a dismissal as no, as it does a refusal to answer', async () => {
    for (const reply of [null, undefined] as const) {
      const h = harness();
      h.state.reply = reply;

      await expect(h.chat.mergeAll()).resolves.toBe(false);
      expect(h.mergeCalls()).toBe(0);
    }
  });

  it('words the question for a branch it cannot name, and for a run still going', async () => {
    const h = harness();
    h.state.executing = true;

    await h.chat.mergeAll();
    expect(h.asked[0]!.message).toContain('into the branch you have checked out.');
    expect(h.asked[0]!.message).toContain('The run goes on');

    const idle = harness();
    await idle.chat.mergeAll();
    expect(idle.asked[0]!.message).toContain('Merge the isolated run into');
    expect(idle.asked[0]!.message).not.toContain('The run goes on');
  });

  it('names every repo of a group and the rule that each is on the branch it started on', async () => {
    const h = harness();
    h.state.handoff = { repos: [{ path: 'api', baseBranch: 'main', landed: [{}] }, { path: 'web', baseBranch: 'main', landed: [{}] }] };

    await h.chat.mergeAll();

    expect(h.asked[0]!.message).toContain('into main in each of api, web.');
    expect(h.asked[0]!.message).toContain('each repository is on the branch it started on');
  });

  describe('what the seam holds the merge for', () => {
    it('asks about work no check has passed in the seam\'s own words, and sends its yes on the next call', async () => {
      const h = harness();
      h.state.handoff = onMain;
      h.state.merges = [held('pastChecks', 'Task a has not passed its checks.')];

      await expect(h.chat.mergeAll()).resolves.toBe(true);

      expect(h.asked.map((q) => q.kind)).toEqual(['merge_all', 'merge_past_checks']);
      expect(h.asked[1]!.message).toBe('Task a has not passed its checks. Merge main anyway?');
      expect(h.merged).toEqual([{}, { pastChecks: true }]);
    });

    it('asks about ops tasks running in the checkout, and sends its yes on the next call', async () => {
      const h = harness();
      h.state.handoff = onMain;
      h.state.merges = [held('besideOps', 'Task ops is running in your checkout.')];

      await expect(h.chat.mergeAll()).resolves.toBe(true);

      expect(h.asked.map((q) => q.kind)).toEqual(['merge_all', 'merge_beside_ops']);
      expect(h.asked[1]!.message).toBe('Task ops is running in your checkout. Merge main anyway?');
      expect(h.merged).toEqual([{}, { besideOps: true }]);
    });

    it('asks one question at a time and keeps each yes beside the ones before it', async () => {
      const h = harness();
      h.state.merges = [held('pastChecks', 'unchecked'), held('besideOps', 'beside ops')];

      await expect(h.chat.mergeAll()).resolves.toBe(true);

      expect(h.asked.map((q) => q.kind)).toEqual(['merge_all', 'merge_past_checks', 'merge_beside_ops']);
      expect(h.merged).toEqual([{}, { pastChecks: true }, { pastChecks: true, besideOps: true }]);
    });

    it('asks in the order the seam holds the merge, not a fixed one', async () => {
      const h = harness();
      h.state.merges = [held('besideOps', 'beside ops'), held('pastChecks', 'unchecked')];

      await expect(h.chat.mergeAll()).resolves.toBe(true);

      expect(h.asked.map((q) => q.kind)).toEqual(['merge_all', 'merge_beside_ops', 'merge_past_checks']);
      expect(h.merged).toEqual([{}, { besideOps: true }, { besideOps: true, pastChecks: true }]);
    });

    it.each(['pastChecks', 'besideOps'] as const)('stops at a no to the %s question, with the yes it never gave not sent', async (hold) => {
      const h = harness();
      h.state.merges = [held(hold, 'held')];
      // The opening question is answered yes; only the one the seam raised is refused.
      let answers = 0;
      h.port.ask = async (request) => { h.asked.push(request); return answers++ === 0 ? request.choices[0]?.id : null; };

      await expect(h.chat.mergeAll()).resolves.toBe(false);

      expect(h.merged).toEqual([{}]);
      expect(h.asked).toHaveLength(2);
    });

    it('reads a dismissed question as no, and leaves the seam where it was', async () => {
      const h = harness();
      h.state.merges = [held('pastChecks', 'unchecked')];
      let answers = 0;
      h.port.ask = async (request) => { h.asked.push(request); return answers++ === 0 ? request.choices[0]?.id : undefined; };

      await expect(h.chat.mergeAll()).resolves.toBe(false);

      expect(h.merged).toEqual([{}]);
    });

    it.each(['pastChecks', 'besideOps'] as const)('does not ask again for a %s hold it already has a yes for, and throws the seam\'s words', async (hold) => {
      const h = harness();
      h.state.merges = [held(hold, 'first'), held(hold, 'still held')];

      await expect(h.chat.mergeAll()).rejects.toThrow('still held');

      expect(h.asked.map((q) => q.kind)).toEqual(['merge_all', hold === 'pastChecks' ? 'merge_past_checks' : 'merge_beside_ops']);
      expect(h.merged).toHaveLength(2);
    });

    it('takes the seam up once, so a session switched to meanwhile is not sent a yes meant for another', async () => {
      const h = harness();
      h.state.merges = [held('pastChecks', 'unchecked'), held('besideOps', 'beside ops')];

      await h.chat.mergeAll();

      expect(h.merged).toHaveLength(3);
      expect(h.mergeCalls()).toBe(1);
    });
  });

  it('throws the seam\'s refusal, in its words, for the surface to say', async () => {
    const h = harness();
    h.state.merges = [new Error('Merge all needs main checked out.')];

    await expect(h.chat.mergeAll()).rejects.toThrow('Merge all needs main checked out.');
  });

  it('throws a refusal that comes after a yes too, having asked nothing more', async () => {
    const h = harness();
    h.state.merges = [held('pastChecks', 'unchecked'), new Error('The run has moved on.')];

    await expect(h.chat.mergeAll()).rejects.toThrow('The run has moved on.');

    expect(h.asked.map((q) => q.kind)).toEqual(['merge_all', 'merge_past_checks']);
  });

  it('does not touch the prompt hold, the plan or the turns', async () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('and add tests');

    await h.chat.mergeAll();

    expect(h.held()).toEqual(['and add tests']);
    expect(h.turns).toEqual([]);
    expect(h.executed).toEqual([]);
    expect(h.port.settled).not.toHaveBeenCalled();
  });

  describe('when the surface asked the opening question itself (ADR-0062 G8)', () => {
    it('merges without asking it again', async () => {
      const h = harness();

      await expect(h.chat.mergeConfirmed()).resolves.toBe(true);

      expect(h.asked).toEqual([]);
      expect(h.merged).toEqual([{}]);
    });

    it('still asks what the seam holds the merge for, each once', async () => {
      const h = harness();
      h.state.handoff = onMain;
      h.state.merges = [held('pastChecks', 'unchecked'), held('besideOps', 'beside ops')];

      await expect(h.chat.mergeConfirmed()).resolves.toBe(true);

      expect(h.asked.map((q) => q.kind)).toEqual(['merge_past_checks', 'merge_beside_ops']);
      expect(h.asked[0]!.message).toBe('unchecked Merge main anyway?');
      expect(h.merged).toEqual([{}, { pastChecks: true }, { pastChecks: true, besideOps: true }]);
    });

    it('is false on a no to one of them, and throws a refusal', async () => {
      const no = harness();
      no.state.merges = [held('besideOps', 'beside ops')];
      no.state.reply = null;
      await expect(no.chat.mergeConfirmed()).resolves.toBe(false);
      expect(no.merged).toEqual([{}]);

      const refused = harness();
      refused.state.merges = [new Error('Nothing to merge.')];
      await expect(refused.chat.mergeConfirmed()).rejects.toThrow('Nothing to merge.');
    });
  });
});
