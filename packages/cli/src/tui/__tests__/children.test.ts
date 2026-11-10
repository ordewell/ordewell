import { createTask, reduceRun, serializePlan, type ChildPlanEntry, type ChildPlanView, EMPTY_RUN, type SurfacePlan } from '@ordewell/core';
import { describe, expect, it, vi } from 'vitest';
import { reduce, initialState, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { style } from '../ansi';
import type { Key } from '../keys';
import { chatLayout, composerView, footerHints, helpLayout } from '../layout';
import { render } from '../render';
import { messagesOf } from './chat';

vi.mock('@ordewell/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@ordewell/core')>(), DELEGATION_OFFERED: true }));

style.enabled = false;

const key = (name: Key['name'], char?: string): Action => ({ type: 'key', key: { name, ...(char ? { char } : {}) } });

function plan(...tasks: Array<{ id: string; title: string; delegated?: boolean; status?: string; checkpoint?: string; attempted?: boolean; awaitingReason?: string }>): SurfacePlan {
  return serializePlan({
    tasks: tasks.map((t, i) => ({
      ...createTask({
        id: t.id, order: i + 1, title: t.title, ...(t.delegated ? { type: 'delegated', goal: `Do ${t.title}`, budget: { tokens: 1000 } } : {}),
        ...(t.status ? { status: t.status } : {}), ...(t.checkpoint ? { checkpoint: t.checkpoint } : {}), ...(t.attempted ? { attempted: true } : {}),
      } as Parameters<typeof createTask>[0]),
      ...(t.awaitingReason ? { awaitingReason: t.awaitingReason } : {}),
    })),
    generatedAt: new Date().toISOString(), status: 'approved', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
  } as Parameters<typeof serializePlan>[0]) as SurfacePlan;
}

const entry = (over: Partial<ChildPlanEntry> & { sessionId: string }): ChildPlanEntry => ({
  node: over.sessionId, parent: 'root', taskId: 'd', title: 'Delegated', depth: 1, state: 'working', ...over,
});

/** The daemon's read of a child: its `run` is the plan and nothing the stream said (`ChildDirectory.view`). */
const view = (child: ChildPlanEntry, over: Partial<ChildPlanView> = {}): ChildPlanView => ({
  child, plan: null, ...over, run: over.plan ? reduceRun(EMPTY_RUN, { type: 'plan_snapshot', plan: over.plan }) : EMPTY_RUN,
});

function step(state: TuiState, action: Action): TuiState {
  return reduce(state, action).state;
}

function effectsOf(state: TuiState, action: Action): Effect[] {
  return reduce(state, action).effects;
}

const atRoot = (over: Partial<TuiState> = {}): TuiState =>
  step(initialState({ sessionId: 'root', goal: 'The goal', rows: 40, cols: 100, focus: 'plan', ...over }), { type: 'planUpdated', sessionId: 'root', plan: plan({ id: 'd', title: 'Delegated', delegated: true }, { id: 'a', title: 'Plain' }) });

const tree = (state: TuiState, ...children: ChildPlanEntry[]): TuiState => step(state, { type: 'childTree', sessionId: 'root', children });

const inChild = (...more: ChildPlanEntry[]): TuiState => {
  const child = entry({ sessionId: 'c1' });
  const opened = step(tree(atRoot(), child, ...more), key('enter'));
  return step(opened, { type: 'childOpened', sessionId: 'c1', view: view(child, { goal: 'Do Delegated', plan: plan({ id: 'n', title: 'Nested', delegated: true }, { id: 'r', title: 'Runner task', status: 'running', attempted: true }) }) });
};

describe('opening a child plan', () => {
  it('Enter on a delegated task opens its subplanner, following the child under its root', () => {
    const state = tree(atRoot(), entry({ sessionId: 'c1' }));

    const { state: opened, effects } = reduce(state, key('enter'));

    expect(opened.sessionId).toBe('c1');
    expect(opened.focus).toBe('chat');
    expect(opened.taskView).toBeNull();
    expect(effects).toEqual([{ type: 'followChild', rootId: 'root', childId: 'c1' }]);
  });

  it('Esc goes back to the plan it came from, the cursor where it was, and closes the socket', () => {
    const state = tree(atRoot(), entry({ sessionId: 'c1' }));
    const opened = step(state, key('enter'));

    const { state: back, effects } = reduce(opened, key('escape'));

    expect(back.sessionId).toBe('root');
    expect(back.child).toBeNull();
    expect(back.selectedTask).toBe(0);
    expect(back.focus).toBe('plan');
    expect(effects).toEqual([{ type: 'closeChild', childId: 'c1' }]);
  });

  it('nested Enter goes one deeper and Esc comes back one plan at a time', () => {
    const grandchild = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', title: 'Nested', depth: 2 });
    const middle = step(inChild(grandchild), key('tab'));
    expect(middle.focus).toBe('plan');

    const { state: deep, effects } = reduce(middle, key('enter'));
    expect(deep.sessionId).toBe('c2');
    expect(effects).toEqual([{ type: 'followChild', rootId: 'root', childId: 'c2' }]);

    const up = step(deep, key('escape'));
    expect(up.sessionId).toBe('c1');
    expect(up.tasks.map((t) => t.id)).toEqual(['n', 'r']);

    expect(step(step(up, key('tab')), key('escape')).sessionId).toBe('root');
  });

  it('a task can hold two children after a fresh retry: the live one opens, keyed on its own id', () => {
    const state = tree(atRoot(), entry({ sessionId: 'old', state: 'ended' }), entry({ sessionId: 'new', state: 'parked' }));

    expect(step(state, key('enter')).sessionId).toBe('new');
  });

  it('with every attempt ended, the latest one opens', () => {
    const state = tree(atRoot(), entry({ sessionId: 'first', state: 'ended' }), entry({ sessionId: 'second', state: 'ended' }));

    expect(step(state, key('enter')).sessionId).toBe('second');
  });

  it('a delegated task the tree does not know yet is asked after, not guessed at', () => {
    const { state, effects } = reduce(atRoot(), key('enter'));

    expect(state.sessionId).toBe('root');
    expect(effects).toEqual([{ type: 'listChildren', rootId: 'root', open: { parent: 'root', taskId: 'd' } }]);
  });

  it('the answer opens the child, or says the task has not started', () => {
    const asked = { type: 'childrenListed', sessionId: 'root', open: { parent: 'root', taskId: 'd' } } as const;

    expect(step(atRoot(), { ...asked, children: [entry({ sessionId: 'c1' })] }).sessionId).toBe('c1');

    const empty = step(atRoot(), { ...asked, children: [] });
    expect(empty.sessionId).toBe('root');
    expect(messagesOf(empty).map((m) => m.text).join('\n')).toMatch(/hasn.t started/);
  });

  it('a task that is not delegated keeps its Enter', () => {
    const state = step(tree(atRoot(), entry({ sessionId: 'c1' })), key('down'));

    expect(effectsOf(state, key('enter'))).toEqual([]);
    expect(step(state, key('enter')).sessionId).toBe('root');
  });
});

/** The viewed child, with a question on it: `status_update` is what carries one, a read does not (ChildDirectory.view). */
const statuses = (sessionId: string, ...tasks: Array<{ id: string; status: 'pending' | 'running' | 'failed' | 'awaiting_user'; continuable?: boolean; awaitingReason?: 'checkpoint'; checkpoint?: string }>): Action =>
  ({ type: 'statusUpdate', sessionId, tasks: tasks.map((task) => ({ verdict: null, attempted: true, ...task })) }) as Action;

const asked = (state: TuiState, sessionId: string, taskId: string, checkpoint: string): TuiState =>
  step(state, statuses(sessionId, { id: taskId, status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint }));

const typed = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });

const said = (state: TuiState): string => messagesOf(state).map((m) => m.text).join('\n');

describe('speaking to the viewed subplanner', () => {
  it('a message goes to the child\'s own route, and shows as said', () => {
    const { state, effects } = reduce(typed(inChild(), 'how far along?'), key('enter'));

    expect(effects).toEqual([{ type: 'messageChild', rootId: 'root', childId: 'c1', text: 'how far along?' }]);
    expect(said(state)).toContain('how far along?');
    expect(state.editor.text).toBe('');
  });

  it('a nested child is reached through the root it hangs from', () => {
    const grandchild = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', depth: 2 });
    const deep = step(step(inChild(grandchild), key('tab')), key('enter'));

    expect(effectsOf(typed(deep, 'hello'), key('enter'))).toEqual([{ type: 'messageChild', rootId: 'root', childId: 'c2', text: 'hello' }]);
  });

  it('a busy subplanner says it read nothing yet, a woken one says nothing', () => {
    const state = inChild();

    expect(said(step(state, { type: 'childMessaged', sessionId: 'c1', status: 'queued' }))).toMatch(/busy/);
    expect(said(step(state, { type: 'childMessaged', sessionId: 'c1', status: 'woken' }))).toBe(said(state));
  });
});

describe('a child\'s task view', () => {
  const inTask = (): TuiState => step(step(step(inChild(), key('tab')), key('down')), key('enter'));

  it('reads the task\'s log on the child\'s routes', () => {
    expect(effectsOf(step(step(inChild(), key('tab')), key('down')), key('enter'))).toEqual([
      { type: 'openTaskLog', sessionId: 'c1', taskId: 'r', rootId: 'root' },
    ]);
  });

  it('a message goes to the child\'s runner, not a root route', () => {
    expect(effectsOf(typed(inTask(), 'use the old table'), key('enter'))).toEqual([
      { type: 'messageChildTask', rootId: 'root', childId: 'c1', taskId: 'r', text: 'use the old table' },
    ]);
  });

  it('a force key has no child route and says so', () => {
    const { state, effects } = reduce(inTask(), key('ctrl-s'));

    expect(effects).toEqual([]);
    expect(state.taskView?.notice).toMatch(/no route/);
  });
});

describe('no root route takes a child\'s id', () => {
  it('nothing a key can press sends the child\'s id to a session-level effect', () => {
    const child = inChild();
    const keys: Action[] = [
      ...(['ctrl-s', 'ctrl-x', 'ctrl-r', 'ctrl-t', 'ctrl-e', 'ctrl-p', 'ctrl-n', 'delete', 'backspace'] as const).map((name) => key(name)),
      ...'axdprkecmuoSi'.split('').map((char) => key('char', char)),
    ];
    const allowed = new Set(['messageChild', 'messageChildTask', 'answerChildCheckpoint', 'openTaskLog', 'loadTaskAttempt', 'readChild', 'followChild', 'closeChild', 'listChildren', 'stopExecution']);

    for (const state of [child, step(child, key('tab')), step(step(child, key('tab')), key('down'))]) {
      for (const action of keys) {
        for (const effect of effectsOf(state, action)) {
          if ('sessionId' in effect && effect.sessionId === 'c1') expect(allowed, `${JSON.stringify(action)} → ${effect.type}`).toContain(effect.type);
        }
      }
    }
  });

  it('a session-wide command is refused with the way to run it', () => {
    const { state, effects } = reduce(typed(inChild(), '/new'), key('enter'));

    expect(effects).toEqual([]);
    expect(said(state)).toMatch(/\/new acts on a whole session/);
  });

  it('a plan edit is refused: the subplanner owns it', () => {
    const { state, effects } = reduce(step(inChild(), key('tab')), key('char', 'x'));

    expect(effects).toEqual([]);
    expect(said(state)).toMatch(/subplanner owns its plan/);
  });
});

describe('stopping from below the root', () => {
  it('/stop stops the whole run, and says that is what it did', () => {
    const { state, effects } = reduce(typed(inChild(), '/stop'), key('enter'));

    expect(effects).toEqual([{ type: 'stopExecution', sessionId: 'root' }]);
    expect(said(state)).toMatch(/whole run/);
  });

  it('/stop leaves the composer as the root\'s does, so a second Enter stops nothing', () => {
    const { state } = reduce(typed(inChild(), '/stop'), key('enter'));

    expect(state.editor.text).toBe('');
    expect(effectsOf(state, key('enter'))).toEqual([]);
  });
});

const QUESTION = 'Drop the users table?\nIt holds 40k rows.';

describe('a subplanner\'s question', () => {
  // The question of a subplanner is its delegated task's, and that task is on the plan above.
  const asking = (): TuiState => asked(inChild(), 'root', 'd', QUESTION);

  it('reaches the viewed subplanner while the plan above holds it', () => {
    expect(asking().sessionId).toBe('c1');
    expect(asking().child?.parent.tasks[0]?.checkpoint).toBeDefined();
  });

  it('enter replies on the root\'s route at depth one: the words are the answer', () => {
    const { state, effects } = reduce(typed(asking(), 'yes, go on'), key('enter'));

    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 'root', taskId: 'd', answer: 'approve', reason: 'yes, go on', below: true }]);
    expect(state.editor.text).toBe('');
  });

  it('ctrl-y approves and ctrl-g rejects with the draft', () => {
    expect(effectsOf(asking(), key('ctrl-y'))).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 'root', taskId: 'd', answer: 'approve', below: true }]);
    expect(effectsOf(typed(asking(), 'not that table'), key('ctrl-g'))).toEqual([
      { type: 'answerTaskCheckpoint', sessionId: 'root', taskId: 'd', answer: 'reject', reason: 'not that table', below: true },
    ]);
  });

  it('ctrl-y with a count raises the budget at depth one, where the root holds it', () => {
    const { state, effects } = reduce(typed(asking(), '5000'), key('ctrl-y'));

    expect(effects).toEqual([{ type: 'answerTaskCheckpoint', sessionId: 'root', taskId: 'd', answer: 'approve', raiseTokens: 5000, below: true }]);
    expect(state.editor.text).toBe('');
  });

  describe('refused on the root\'s route', () => {
    const refusal = { type: 'childFailed', sessionId: 'root', code: 'checkpoint_not_waiting', message: 'No longer waiting.', text: 'yes, go on' } as const;

    it('gives the words back to the composer they left, and says so there', () => {
      const answered = step(typed(asking(), 'yes, go on'), key('enter'));

      const { state, effects } = reduce(answered, refusal);

      expect(state.sessionId).toBe('c1');
      expect(state.editor.text).toBe('yes, go on');
      expect(said(state)).toMatch(/No longer waiting/);
      expect(effects).toEqual([]);
    });

    it('finds a person who has gone back to the root, whose stream already says what moved', () => {
      const answered = step(typed(asking(), 'yes, go on'), key('enter'));

      const { state, effects } = reduce(step(answered, key('escape')), refusal);

      expect(state.sessionId).toBe('root');
      expect(state.editor.text).toBe('yes, go on');
      expect(said(state)).toMatch(/No longer waiting/);
      expect(effects).toEqual([]);
    });
  });

  describe('two plans down', () => {
    const deep = (): TuiState => {
      const grandchild = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', title: 'Nested', depth: 2 });
      const opened = step(step(inChild(grandchild), key('tab')), key('enter'));
      return asked(step(opened, { type: 'childOpened', sessionId: 'c2', view: view(grandchild, { plan: plan({ id: 'x', title: 'Leaf' }) }) }), 'c1', 'n', QUESTION);
    };

    it('is answered on the child that holds it, with the run\'s exact words', () => {
      expect(effectsOf(typed(deep(), 'carry on'), key('enter'))).toEqual([
        { type: 'answerChildCheckpoint', rootId: 'root', childId: 'c1', taskId: 'n', answer: 'approve', question: QUESTION, reason: 'carry on' },
      ]);
    });

    it('takes no raise: ctrl-y approves plainly, the count stays a draft', () => {
      const { state, effects } = reduce(typed(deep(), '5000'), key('ctrl-y'));

      expect(effects).toEqual([{ type: 'answerChildCheckpoint', rootId: 'root', childId: 'c1', taskId: 'n', answer: 'approve', question: QUESTION }]);
      expect(state.editor.text).toBe('5000');
    });

    it('a refused answer comes back to the composer it was typed in, and the plan that held the question is read again', () => {
      const answered = step(typed(deep(), 'carry on'), key('enter'));
      expect(answered.editor.text).toBe('');

      const { state, effects } = reduce(answered, { type: 'childFailed', sessionId: 'c1', code: 'checkpoint_not_waiting', message: 'No longer waiting.', text: 'carry on' });

      expect(state.sessionId).toBe('c2');
      expect(state.editor.text).toBe('carry on');
      expect(said(state)).toMatch(/No longer waiting/);
      expect(effects).toEqual([{ type: 'readChild', rootId: 'root', childId: 'c1' }]);
    });

    const movedOn = (): TuiState => {
      const held = deep();
      const parent = held.child!.parent;
      return { ...held, child: { ...held.child!, parent: { ...parent, run: { ...parent.run, tasks: parent.run.tasks.map((t) => ({ ...t, checkpoint: undefined })) } } } };
    };

    it.each(['enter', 'ctrl-g'] as const)('keeps the words of an answer %s sent to a question that moved on', (name) => {
      const { state, effects } = reduce(typed(movedOn(), 'carry on'), key(name));

      expect(state.editor.text).toBe('carry on');
      expect(said(state)).toMatch(/moved on/);
      expect(effects).toEqual([{ type: 'readChild', rootId: 'root', childId: 'c1' }]);
    });

    it('says a question that moved on where the person is looking, not on the plan held above', () => {
      const { state, effects } = reduce(movedOn(), key('ctrl-y'));

      expect(said(state)).toMatch(/moved on/);
      expect(said(state.child!.parent)).not.toMatch(/moved on/);
      expect(effects).toEqual([{ type: 'readChild', rootId: 'root', childId: 'c1' }]);
    });
  });

  it('a child\'s runner\'s question is answered on the child\'s route with its raw words', () => {
    const inTask = step(step(step(inChild(), key('tab')), key('down')), key('enter'));
    const state = asked(inTask, 'c1', 'r', QUESTION);

    expect(effectsOf(typed(state, 'the old one'), key('enter'))).toEqual([
      { type: 'answerChildCheckpoint', rootId: 'root', childId: 'c1', taskId: 'r', answer: 'reject', question: QUESTION, reason: 'the old one' },
    ]);
  });

  it('a refused answer to a child\'s runner gives the words back, however the daemon refused it', () => {
    const inTask = step(step(step(inChild(), key('tab')), key('down')), key('enter'));
    const answered = step(typed(asked(inTask, 'c1', 'r', QUESTION), 'the old one'), key('enter'));
    expect(answered.editor.text).toBe('');

    const { state, effects } = reduce(answered, { type: 'childFailed', sessionId: 'c1', code: 'checkpoint_not_waiting', message: 'No longer waiting.', text: 'the old one' });

    expect(state.editor.text).toBe('the old one');
    expect(state.taskView?.notice).toMatch(/No longer waiting/);
    expect(effects).toEqual([{ type: 'readChild', rootId: 'root', childId: 'c1' }]);
  });

  it('a question the run no longer holds re-reads the plan instead of guessing', () => {
    const inTask = step(step(step(inChild(), key('tab')), key('down')), key('enter'));
    const state = asked(inTask, 'c1', 'r', QUESTION);
    const moved = { ...state, run: { ...state.run, tasks: state.run.tasks.map((t) => ({ ...t, checkpoint: undefined })) } } as TuiState;

    const { state: after, effects } = reduce(typed(moved, 'the old one'), key('enter'));

    expect(effects).toEqual([{ type: 'readChild', rootId: 'root', childId: 'c1' }]);
    expect(after.taskView?.notice).toMatch(/moved on/);
  });

  it('a question gone from a child\'s task view keeps the words the answer carried', () => {
    const inTask = step(step(step(inChild(), key('tab')), key('down')), key('enter'));
    const state = asked(inTask, 'c1', 'r', QUESTION);
    const moved = { ...state, run: { ...state.run, tasks: state.run.tasks.map((t) => ({ ...t, checkpoint: undefined })) } } as TuiState;

    expect(step(typed(moved, 'the old one'), key('enter')).editor.text).toBe('the old one');
  });

  it('a raise refused in a child\'s task view stays typed, for the plan above to give', () => {
    const state = step(step(asked(inChild(), 'c1', 'n', QUESTION), key('tab')), key('char', 'l'));

    const { state: after, effects } = reduce(typed(state, '5000'), key('ctrl-y'));

    expect(effects).toEqual([]);
    expect(after.editor.text).toBe('5000');
    expect(after.taskView?.notice).toMatch(/raise/);
  });

  it('a retried-away child does not offer its task\'s question', () => {
    const live = entry({ sessionId: 'new' });
    const old = step(tree(atRoot(), entry({ sessionId: 'old', state: 'ended' })), key('enter'));
    const state = asked(step(old, { type: 'childTree', sessionId: 'root', children: [entry({ sessionId: 'old', state: 'ended' }), live] }), 'root', 'd', QUESTION);

    expect(effectsOf(state, key('ctrl-y'))).toEqual([]);
  });
});

describe('an ended subplanner', () => {
  const ended = (): TuiState => {
    const child = entry({ sessionId: 'c1', state: 'ended' });
    const opened = step(tree(atRoot(), child), key('enter'));
    return step(opened, { type: 'childOpened', sessionId: 'c1', view: view(child, { goal: 'Do Delegated', plan: plan({ id: 'r', title: 'Runner task', status: 'done', attempted: true }) }) });
  };

  it('takes no message, and says so while keeping the draft', () => {
    const { state, effects } = reduce(typed(ended(), 'one more thing'), key('enter'));

    expect(effects).toEqual([]);
    expect(said(state)).toMatch(/can be read, not spoken to/);
    expect(state.editor.text).toBe('one more thing');
  });

  it('still scrolls and leaves', () => {
    const state = { ...ended(), scroll: 3 };

    expect(step(state, key('pagedown')).scroll).toBeLessThan(3);
    expect(step(state, key('escape')).sessionId).toBe('root');
  });

  it('still opens its tasks to read', () => {
    expect(effectsOf(step(ended(), key('tab')), key('enter'))).toEqual([{ type: 'openTaskLog', sessionId: 'c1', taskId: 'r', rootId: 'root' }]);
  });

  it('a tree that says it ended locks the composer of the one on screen', () => {
    const state = step(inChild(), { type: 'childTree', sessionId: 'root', children: [entry({ sessionId: 'c1', state: 'ended' })] });

    expect(effectsOf(typed(state, 'hello'), key('enter'))).toEqual([]);
  });

  it('the daemon\'s refusal ends it here too, and gives the words back', () => {
    const state = step(inChild(), { type: 'childFailed', sessionId: 'c1', code: 'child_view_only', message: 'This plan has ended.', text: 'hello' });

    expect(state.child?.entry.state).toBe('ended');
    expect(state.editor.text).toBe('hello');
    expect(said(state)).toMatch(/This plan has ended/);
  });

  describe('words left where no composer is drawn', () => {
    const refused = (): TuiState => step(inChild(), { type: 'childFailed', sessionId: 'c1', code: 'child_view_only', message: 'This plan has ended.', text: 'hello' });

    it('says where they wait, since the plan on screen cannot show them', () => {
      expect(composerView(refused())).toBeNull();
      expect(said(refused())).toMatch(/Esc takes them to the composer of the plan above/);
    });

    it('one Esc lands on the plan above with the words in its composer, ahead of its draft', () => {
      const above = typed(atRoot(), 'mine');
      const child = entry({ sessionId: 'c1' });
      const opened = step(tree(above, child), key('enter'));
      const held = step(opened, { type: 'childFailed', sessionId: 'c1', code: 'child_view_only', message: 'This plan has ended.', text: 'hello' });

      const { state, effects } = reduce(held, key('escape'));

      expect(state.sessionId).toBe('root');
      expect(state.editor.text).toBe('hello\nmine');
      expect(screen(state)).toContain('hello');
      expect(effects).toEqual([{ type: 'closeChild', childId: 'c1' }]);
    });

    it('ctrl-c leaves with them too, rather than clearing what cannot be seen', () => {
      const state = step(refused(), key('ctrl-c'));

      expect(state.sessionId).toBe('root');
      expect(state.editor.text).toBe('hello');
    });

    it('a task\'s log closes first and the words stay, then the plan above takes them', () => {
      const inTask = step(step(step(refused(), key('tab')), key('down')), key('enter'));
      expect(inTask.taskView?.taskId).toBe('r');

      const closed = step(inTask, key('escape'));
      expect(closed.taskView).toBeNull();
      expect(closed.editor.text).toBe('hello');

      const up = step(closed, key('escape'));
      expect(up.sessionId).toBe('root');
      expect(up.editor.text).toBe('hello');
    });

    it('a draft the tree ended under goes the same way', () => {
      const lived = typed(inChild(), 'half a thought');
      const state = step(lived, { type: 'childTree', sessionId: 'root', children: [entry({ sessionId: 'c1', state: 'ended' })] });

      const up = step(state, key('escape'));

      expect(up.sessionId).toBe('root');
      expect(up.editor.text).toBe('half a thought');
    });

    it('a live plan\'s Esc still clears its draft first: it is on screen to be cleared', () => {
      const state = step(typed(inChild(), 'half a thought'), key('escape'));

      expect(state.sessionId).toBe('c1');
      expect(state.editor.text).toBe('');
    });
  });

  it('Continue stays on the plan above, on the task\'s own log key', () => {
    const state = step(tree(atRoot(), entry({ sessionId: 'c1', state: 'ended' })), statuses('root', { id: 'd', status: 'failed' }));

    const { state: opened, effects } = reduce(state, key('char', 'l'));

    expect(opened.sessionId).toBe('root');
    expect(opened.taskView?.taskId).toBe('d');
    expect(effects).toEqual([{ type: 'openTaskLog', sessionId: 'root', taskId: 'd' }]);
  });
});

describe('what the daemon refuses', () => {
  it('a mandate\'s refusal shows and gives the words back, the composer live', () => {
    const state = step(inChild(), { type: 'childFailed', sessionId: 'c1', code: 'child_refused', message: 'Paused for a budget.', text: 'hello' });

    expect(state.child?.entry.state).toBe('working');
    expect(state.editor.text).toBe('hello');
    expect(said(state)).toMatch(/Paused for a budget/);
  });

  it('a question already answered re-reads the plan it was on', () => {
    expect(effectsOf(inChild(), { type: 'childFailed', sessionId: 'c1', code: 'checkpoint_not_waiting', message: 'No longer waiting.' })).toEqual([
      { type: 'readChild', rootId: 'root', childId: 'c1' },
    ]);
  });

  it('a child the tree no longer names sends the person back, saying why', () => {
    const { state, effects } = reduce(inChild(), { type: 'childFailed', sessionId: 'c1', code: 'child_not_found', message: 'No such plan.' });

    expect(state.sessionId).toBe('root');
    expect(said(state)).toMatch(/No such plan/);
    expect(effects).toEqual([{ type: 'closeChild', childId: 'c1' }]);
  });

  it('a child that is gone hands the words to the plan the person lands on', () => {
    const state = step(inChild(), { type: 'childFailed', sessionId: 'c1', code: 'child_not_found', message: 'No such plan.', text: 'hello' });

    expect(state.sessionId).toBe('root');
    expect(state.editor.text).toBe('hello');
  });

  it('a gone child\'s unsent draft goes to the plan the person lands on', () => {
    const { state, effects } = reduce(typed(inChild(), 'half a thought'), { type: 'childGone', sessionId: 'c1', message: 'That plan is gone.' });

    expect(state.sessionId).toBe('root');
    expect(state.editor.text).toBe('half a thought');
    expect(said(state)).toMatch(/That plan is gone/);
    expect(effects).toEqual([{ type: 'closeChild', childId: 'c1' }]);
  });

  it('that draft goes ahead of the one waiting there, and behind any refused words', () => {
    const child = entry({ sessionId: 'c1' });
    const opened = step(typed(tree(atRoot(), child), 'root draft'), key('enter'));

    const state = step(typed(opened, 'child draft'), { type: 'childFailed', sessionId: 'c1', code: 'child_not_found', message: 'No such plan.', text: 'refused words' });

    expect(state.editor.text).toBe('refused words\nchild draft\nroot draft');
  });

  it('an ended child\'s draft goes up once, not twice', () => {
    const ended = step(typed(inChild(), 'half a thought'), { type: 'childFailed', sessionId: 'c1', code: 'child_view_only', message: 'This plan has ended.' });

    expect(step(ended, { type: 'childGone', sessionId: 'c1', message: 'That plan is gone.' }).editor.text).toBe('half a thought');
  });

  describe('when the plan above the viewed one goes', () => {
    const grandchild = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', title: 'Nested', depth: 2 });
    const deep = (): TuiState => {
      const opened = step(step(inChild(grandchild), key('tab')), key('enter'));
      return typed(step(opened, { type: 'childOpened', sessionId: 'c2', view: view(grandchild, { plan: plan({ id: 'x', title: 'Leaf' }) }) }), 'half a thought');
    };

    it('the viewed plan\'s draft goes with the person', () => {
      const state = step(deep(), { type: 'childGone', sessionId: 'c1', message: 'That plan is gone.' });

      expect(state.sessionId).toBe('root');
      expect(state.editor.text).toBe('half a thought');
    });

    describe('onto a plan that has ended', () => {
      const third = entry({ sessionId: 'c3', parent: 'c2', taskId: 'x', title: 'Third', depth: 3 });
      const belowEnded = (): TuiState => {
        const ended = step(step(tree(inChild(grandchild), entry({ sessionId: 'c1', state: 'ended' }), grandchild, third), key('tab')), key('enter'));
        return step(ended, { type: 'childOpened', sessionId: 'c2', view: view(grandchild, { plan: plan({ id: 'x', title: 'Leaf', delegated: true }) }) });
      };

      it('says where the words wait, since no composer shows them', () => {
        const state = step(typed(belowEnded(), 'half a thought'), { type: 'childGone', sessionId: 'c2', message: 'That plan is gone.' });

        expect(state.sessionId).toBe('c1');
        expect(state.editor.text).toBe('half a thought');
        expect(said(state)).toMatch(/That plan is gone.*Your words are kept/);
      });

      it('says so too when the plan that went was above the viewed one', () => {
        const opened = step(step(belowEnded(), key('tab')), key('enter'));

        const state = step(typed(opened, 'half a thought'), { type: 'childGone', sessionId: 'c2', message: 'That plan is gone.' });

        expect(state.sessionId).toBe('c1');
        expect(state.editor.text).toBe('half a thought');
        expect(said(state)).toMatch(/Your words are kept/);
      });
    });

    it('another session is another conversation: the draft does not follow', () => {
      const state = step(deep(), { type: 'sessionLoaded', sessionId: 'elsewhere', goal: 'Another' });

      expect(state.sessionId).toBe('elsewhere');
      expect(state.editor.text).toBe('');
    });
  });

  it('a person who has left the plan gets the words back where they are now', () => {
    const left = step(step(inChild(), key('escape')), { type: 'childFailed', sessionId: 'c1', code: 'child_refused', message: 'Paused for a budget.', text: 'hello' });

    expect(left.sessionId).toBe('root');
    expect(left.editor.text).toBe('hello');
    expect(said(left)).toMatch(/Paused for a budget/);
  });
});

describe('the connection', () => {
  it('a lost socket says so once, and the next read says it is back', () => {
    const lost = step(step(inChild(), { type: 'followLost', sessionId: 'c1' }), { type: 'followLost', sessionId: 'c1' });
    expect(said(lost).match(/Lost the connection/g)).toHaveLength(1);
    expect(lost.child?.lost).toBe(true);

    const child = entry({ sessionId: 'c1' });
    const back = step(lost, { type: 'childOpened', sessionId: 'c1', view: view(child, { plan: plan({ id: 'r', title: 'Runner task' }) }) });

    expect(back.child?.lost).toBe(false);
    expect(said(back)).toMatch(/Reconnected/);
  });

  it('a first read that failed stops claiming to read, and says it is coming back', () => {
    const opened = step(tree(atRoot(), entry({ sessionId: 'c1' })), key('enter'));

    const state = step(opened, { type: 'followLost', sessionId: 'c1' });

    expect(state.child?.reading).toBe(false);
    expect(screen(state)).not.toContain('Reading this plan');
    expect(screen(state)).toContain('Reconnecting to this plan');
  });

  it('a question survives a re-read, which does not carry one', () => {
    const inTask = asked(inChild(), 'c1', 'r', QUESTION);
    const child = entry({ sessionId: 'c1' });

    const reread = step(inTask, { type: 'childOpened', sessionId: 'c1', view: view(child, { plan: plan({ id: 'n', title: 'Nested', delegated: true }, { id: 'r', title: 'Runner task', status: 'awaiting_user', awaitingReason: 'checkpoint', attempted: true }) }) });

    expect(reread.run.tasks.find((t) => t.id === 'r')?.checkpoint).toBe(QUESTION);
  });

  it('a stream of the plan above lands on that plan and leaves the view alone', () => {
    const state = step(inChild(), { type: 'planUpdated', sessionId: 'root', plan: plan({ id: 'd', title: 'Renamed', delegated: true }) });

    expect(state.sessionId).toBe('c1');
    expect(state.tasks.map((t) => t.title)).toEqual(['Nested', 'Runner task']);
    expect(step(step(state, key('tab')), key('escape')).tasks.map((t) => t.title)).toEqual(['Renamed']);
  });

  it('a frame for a plan not on the stack is dropped', () => {
    const state = inChild();

    expect(step(state, { type: 'planUpdated', sessionId: 'other', plan: plan({ id: 'z', title: 'Elsewhere' }) }).tasks).toEqual(state.tasks);
  });

  it('a plan that goes away from under the viewed one leaves with it', () => {
    const grandchild = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', depth: 2 });
    const deep = step(step(inChild(grandchild), key('tab')), key('enter'));

    const { state, effects } = reduce(deep, { type: 'childGone', sessionId: 'c1', message: 'That plan is gone.' });

    expect(state.sessionId).toBe('root');
    expect(said(state)).toMatch(/That plan is gone/);
    expect(effects).toEqual(expect.arrayContaining([{ type: 'closeChild', childId: 'c2' }, { type: 'closeChild', childId: 'c1' }]));
  });

  it('another session closes every plan on the stack', () => {
    const grandchild = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', depth: 2 });
    const deep = step(step(inChild(grandchild), key('tab')), key('enter'));

    const { state, effects } = reduce(deep, { type: 'sessionLoaded', sessionId: 'elsewhere', goal: 'Another' });

    expect(state.sessionId).toBe('elsewhere');
    expect(state.child).toBeNull();
    expect(effects).toEqual(expect.arrayContaining([{ type: 'closeChild', childId: 'c2' }, { type: 'closeChild', childId: 'c1' }]));
  });

  it('a resize made in a child is the terminal\'s, not the plan\'s', () => {
    const resized = step(inChild(), { type: 'resize', rows: 24, cols: 60 });

    const back = step(step(resized, key('tab')), key('escape'));

    expect([back.rows, back.cols]).toEqual([24, 60]);
  });

  it('ctrl-c leaves the child, and only the root quits', () => {
    const { state } = reduce(inChild(), key('ctrl-c'));

    expect(state.sessionId).toBe('root');
    expect(state.exiting).toBeFalsy();
  });
});

const screen = (state: TuiState): string => render(state, { tip: false }).join('\n');
const pane = (state: TuiState) => chatLayout(state, state.rows, state.cols);
const nested = (): TuiState => {
  const below = entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', title: 'Nested', depth: 2 });
  const opened = step(tree(step(inChild(below), key('tab')), entry({ sessionId: 'c1' }), below), key('enter'));
  return step(opened, { type: 'childOpened', sessionId: 'c2', view: view(below, { plan: plan({ id: 'x', title: 'Deep task' }) }) });
};
const ended = (): TuiState => tree(inChild(), entry({ sessionId: 'c1', state: 'ended' }));
const openedRunner = (state: TuiState): TuiState => {
  const list = step(state, key('tab'));
  return step(step(list, key('down')), key('enter'));
};
const asFinished = (state: TuiState): TuiState => step(state, statuses('c1', { id: 'r', status: 'pending', continuable: true }));

describe('where a child plan says it is', () => {
  it('names the plans down from the root, and the state of the viewed one, on a row no scrolling moves', () => {
    expect(pane(inChild()).header[0]).toBe('↳ The goal › Delegated · working');
    expect(pane(nested()).header[0]).toBe('↳ The goal › Delegated › Nested · working');
  });

  it('keeps the path over a child task\'s own header', () => {
    const { header } = pane(openedRunner(inChild()));

    expect(header[0]).toBe('↳ The goal › Delegated · working');
    expect(header[1]).toContain('Runner task');
  });

  it('keeps the state in view however long the titles are, on one row', () => {
    const long = 'A very long title that says a great deal about what it wants done';
    const state = step(inChild(), { type: 'childTree', sessionId: 'root', children: [entry({ sessionId: 'c1', title: long, state: 'parked' })] });
    const narrow = { ...state, goal: long, cols: 40 };

    const [path] = chatLayout(narrow, 20, 40).header;

    expect(path?.endsWith('· parked')).toBe(true);
    expect((path ?? '').length).toBeLessThanOrEqual(40);
  });

  it('strips what a subplanner\'s title carries before it reaches the terminal', () => {
    const state = tree(inChild(), entry({ sessionId: 'c1', title: 'Bad\u001b[2Jtitle\nsplit' }));

    expect(pane(state).header[0]).not.toContain('\u001b');
    expect(pane(state).header[0]).not.toContain('\n');
  });

  it('adds no such row at the root', () => {
    expect(pane(atRoot()).header).toEqual([]);
  });

  it('never greets from an empty child plan as if a session had just begun', () => {
    const opened = step(tree(atRoot(), entry({ sessionId: 'c1' })), key('enter'));

    expect(screen(opened)).toContain('Reading this plan');
    expect(screen(opened)).not.toContain('Setup');
  });

  it('says so while the connection is lost, and stops saying so once it is back', () => {
    const lost = step(inChild(), { type: 'followLost', sessionId: 'c1' });
    expect(pane(lost).header.join('\n')).toContain('Reconnecting');

    const back = step(lost, { type: 'childOpened', sessionId: 'c1', view: view(entry({ sessionId: 'c1' })) });
    expect(pane(back).header.join('\n')).not.toContain('Reconnecting');
  });

  it('says what would refuse a message, without locking the composer: the daemon decides that', () => {
    const state = tree(inChild(), entry({ sessionId: 'c1', refused: 'This task waits at a checkpoint.' }));

    expect(pane(state).header.join('\n')).toContain('This task waits at a checkpoint.');
    expect(composerView(state)).not.toBeNull();
  });
});

describe('the keys a child plan offers', () => {
  it('names going back, and none of the planner\'s stop or send keys, though a turn runs', () => {
    const state = step(inChild(), { type: 'sessionMessage', sessionId: 'c1', message: { type: 'planner_turn_started', turnId: 't1' } });

    const hints = footerHints(state);

    expect(hints).toContain('esc back');
    expect(hints).toContain('tab plan');
    expect(hints.join(' ')).not.toMatch(/stop planning|esc take back|esc drop|ctrl-s/);
  });

  it('does not offer a child runner\'s stop or force keys: they have no route', () => {
    const state = openedRunner(inChild());

    const offered = [...pane(state).header, ...footerHints(state), screen(state)].join(' ');

    expect(offered).not.toMatch(/ctrl-x|ctrl-r|ctrl-s/);
    expect(pane(state).header.join(' ')).toContain('esc back');
  });

  it('offers a runner\'s question without a stop key either', () => {
    const state = asked(openedRunner(inChild()), 'c1', 'r', QUESTION);

    expect(footerHints(state)).toEqual(expect.arrayContaining(['enter reply', 'ctrl-y approve', 'ctrl-g reject']));
    expect(pane(state).header.join(' ')).not.toContain('ctrl-x');
  });

  it('labels a child task\'s composer plainly: Continue is the root\'s to give', () => {
    const state = openedRunner(inChild());
    const finished = asFinished(state);

    expect(screen(finished)).toContain('→ Task 2');
    expect(screen(finished)).not.toContain('Continue task');
  });

  it('offers only what moves or reads in a child\'s plan pane', () => {
    const running = step(inChild(), key('tab'));
    const hints = footerHints(step(running, key('down')));

    expect(hints[0]).toBe('esc back');
    expect(hints).toEqual(expect.arrayContaining(['enter chat', '? keys', 'tab chat']));
    expect(hints.join(' ')).not.toMatch(/\bc cancel|m done|s skip|f start|E run|o model|e effort/);
  });

  it('offers the run\'s stop by what the root is doing', () => {
    const idle = step(inChild(), key('tab'));
    expect(footerHints(step(idle, key('down')))).not.toContain('S stop');

    const executing: TuiState = { ...idle, child: { ...idle.child!, parent: { ...idle.child!.parent, status: 'executing' } } };
    expect(footerHints(step(executing, key('down')))).toContain('S stop');
  });

  it('names a delegated task\'s subplanner and its log, and where a Continue is', () => {
    const open = tree(atRoot(), entry({ sessionId: 'c1' }));
    const started = step(open, statuses('root', { id: 'd', status: 'running' }));
    expect(footerHints(started)).toEqual(expect.arrayContaining(['enter subplanner', 'l log']));

    const continuable = step(started, statuses('root', { id: 'd', status: 'pending', continuable: true }));
    expect(footerHints(continuable)).toEqual(expect.arrayContaining(['enter subplanner', 'l continue']));
  });

  it('leaves a plain task\'s keys as they were', () => {
    const state = step(step(atRoot(), statuses('root', { id: 'a', status: 'running' })), key('down'));

    expect(footerHints(state)).toContain('enter chat');
    expect(footerHints(state).join(' ')).not.toContain('subplanner');
  });
});

describe('the question on a subplanner\'s screen', () => {
  it('shows it whole with its keys, and the raise a root route can carry', () => {
    const state = asked(inChild(), 'root', 'd', QUESTION);

    const lines = pane(state).lines.join('\n');

    expect(lines).toContain('Subplanner asks');
    expect(lines).toContain('Drop the users table?');
    expect(lines).toContain('It holds 40k rows.');
    expect(lines).toContain('raise');
    expect(footerHints(state)).toEqual(expect.arrayContaining(['enter reply', 'ctrl-y approve', 'ctrl-g reject']));
  });

  it('offers no raise on a child route, which refuses one', () => {
    const state = asked(nested(), 'c1', 'n', QUESTION);

    expect(pane(state).lines.join('\n')).toContain('Subplanner asks');
    expect(pane(state).lines.join('\n')).not.toContain('raise');
  });

  it('offers no raise on a delegated task read below the root either', () => {
    const state = step(step(asked(inChild(), 'c1', 'n', QUESTION), key('tab')), key('char', 'l'));

    expect(state.taskView?.taskId).toBe('n');
    expect(pane(state).lines.join('\n')).not.toContain('raise');
  });

  it('drops the card once the plan above stops waiting on it', () => {
    const state = asked(inChild(), 'root', 'd', QUESTION);

    const answered = step(state, statuses('root', { id: 'd', status: 'running' }));

    expect(pane(answered).lines.join('\n')).not.toContain('Subplanner asks');
    expect(footerHints(answered)).not.toContain('ctrl-y approve');
  });
});

describe('an ended plan on screen', () => {
  it('reads as read-only: no caret, and the composer says why', () => {
    const state = ended();

    expect(composerView(state)).toBeNull();
    expect(screen(state)).toContain('this plan has ended, so it takes no messages');
    expect(footerHints(state)).toEqual(expect.arrayContaining(['read-only', 'tab plan', 'esc back']));
    expect(footerHints(state)).not.toContain('/help');
  });

  it('says the same in a child task\'s log, and keeps the attempt keys', () => {
    const state = ended();
    const log = openedRunner(state);

    expect(composerView(log)).toBeNull();
    expect(screen(log)).toContain('this plan has ended, so it takes no messages');
    expect(pane(log).header.join(' ')).toContain('read-only');
    expect(pane(log).header.join(' ')).not.toMatch(/ctrl-y|ctrl-g|enter reply/);
  });

  it('points at the Continue only where the plan above offers one', () => {
    const state = step(ended(), statuses('root', { id: 'd', status: 'pending', continuable: true }));
    expect(pane(state).header.join(' ')).toContain('esc, then l');

    expect(pane(ended()).header.join(' ')).not.toContain('esc, then l');
  });

  it('points at nothing below the first level, where no route continues a task', () => {
    const state = tree(nested(), entry({ sessionId: 'c1' }), entry({ sessionId: 'c2', parent: 'c1', taskId: 'n', title: 'Nested', depth: 2, state: 'ended' }));
    const continuable = step(state, statuses('c1', { id: 'n', status: 'pending', continuable: true }));

    expect(pane(continuable).header.join(' ')).toContain('read-only');
    expect(pane(continuable).header.join(' ')).not.toContain('esc, then l');
  });
});

describe('a question left in a plan that ended', () => {
  it('offers no way to answer it, since the daemon would refuse every one', () => {
    const waiting = asked(openedRunner(inChild()), 'c1', 'r', QUESTION);
    expect(pane(waiting).lines.join('\n')).toContain('Task 2 asks');

    const state = tree(waiting, entry({ sessionId: 'c1', state: 'ended' }));

    expect(pane(state).lines.join('\n')).not.toMatch(/asks|enter|ctrl-y|ctrl-g/);
  });
});

describe('what the plan above says of the plans below', () => {
  it('counts the questions waiting below a delegated task, which the inbox does not hold', () => {
    const state = tree(atRoot(), entry({ sessionId: 'c1', checkpoints: ['a', 'b'] }), entry({ sessionId: 'c2', parent: 'c1', taskId: 'x', depth: 2, checkpoints: ['z'] }));

    expect(screen(state)).toContain('3 questions below: enter');
  });

  it('says nothing where none wait', () => {
    expect(screen(tree(atRoot(), entry({ sessionId: 'c1' })))).not.toContain('below: enter');
  });
});

describe('the help sheets', () => {
  it('say how to go down the tree, come back, and what a plan below takes', () => {
    const sheet = helpLayout(80, 160).lines.join('\n');

    expect(sheet).toContain('In a subplanner (enter on a delegated task)');
    expect(sheet).toContain('esc goes back one plan');
    expect(sheet).toContain('ended');
    expect(sheet).toContain('/stop stops the whole run');
  });

  it('list the delegated log key beside the plan pane\'s others', () => {
    const sheet = helpLayout(80, 160, 'keys').lines.join('\n');

    expect(sheet).toMatch(/l\s+open a delegated task's own log/);
    expect(sheet).toContain('subplanner');
  });
});

describe('a branch and a block below the root', () => {
  const HANDOFF = {
    repos: [{ path: '/repo', integrationBranch: 'ordewell/child', baseRef: 'abc1234', baseBranch: 'main', landed: [{ taskId: 'a', order: 1, title: 'Write a' }] }],
    landed: [{ taskId: 'a', order: 1, title: 'Write a' }],
  } satisfies Extract<Action, { type: 'isolationHandoff' }>['handoff'];

  it('does not raise the root\'s merge over a child, whose branch lands through its task above', () => {
    const state = inChild();

    const next = step(state, { type: 'isolationHandoff', handoff: HANDOFF, sessionId: state.sessionId! });

    expect(next.overlay).toBeNull();
    expect(said(next)).not.toContain('/handoff');
  });

  it('keeps announcing a root\'s own run, which is the person\'s to land', () => {
    const state = atRoot();

    const next = step(state, { type: 'isolationHandoff', handoff: HANDOFF, sessionId: state.sessionId! });

    expect(next.overlay?.kind).toBe('handoff');
  });

  it('shows the root\'s branch on the root\'s overlay when the root\'s run lands beneath a child', () => {
    const state = step(inChild(), { type: 'isolationHandoff', handoff: HANDOFF, sessionId: 'root' });

    expect(state.overlay?.kind).toBe('handoff');
    expect(screen(state)).toContain('ordewell/child');
    expect(screen(state)).not.toContain('Nothing to hand off');
  });

  it('says what blocked a child rather than offering a stash the child has no route for', () => {
    const state = inChild();

    const next = step(state, { type: 'isolationBlocked', message: 'The working tree has changes.', sessionId: state.sessionId! });

    expect(next.overlay).toBeNull();
    expect(screen(next)).toContain('The working tree has changes.');
  });
});
