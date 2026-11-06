import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAttemptUsage, type RunTask } from '@ordewell/core';
import type { TaskSummaryDensity } from '@ordewell/ui';
import { aiForms } from '../CardAssignment';
import { buildGraph, type GraphContext, type GraphNode } from '../graphModel';
import { CardActionsContext, TaskCard, type CardActions } from '../TaskCard';
import { runTask } from './fixtures';

const CTX: GraphContext = {
  expanded: new Set(),
  executing: true,
  handoffPending: false,
  now: new Date('2026-11-03T12:00:00Z'),
  modesByRunner: { 'claude-code': [{ id: 'build' }, { id: 'plan', readOnly: true }] },
};

function actions(): CardActions {
  return {
    select: vi.fn(), open: vi.fn(), openChat: vi.fn(), toggleFold: vi.fn(), togglePeek: vi.fn(),
    hover: vi.fn(), move: vi.fn(), menu: vi.fn(), closePeek: vi.fn(),
  };
}

function nodeOf(task: RunTask, others: RunTask[] = []): GraphNode {
  const model = buildGraph([task, ...others], CTX);
  if (!model.ok) throw new Error(model.reason);
  return model.nodes.find((n) => n.id === task.id)!;
}

function card(node: GraphNode, density: TaskSummaryDensity, stub = actions()) {
  const view = render(
    <CardActionsContext.Provider value={stub}>
      <TaskCard node={node} density={density} selected={false} tabbable related={false} peek={null} />
    </CardActionsContext.Provider>,
  );
  const root = view.container.querySelector<HTMLElement>('.graph-card')!;
  const q = (selector: string) => root.querySelector<HTMLElement>(selector);
  return { root, q, stub };
}

const KINDS: Record<string, () => GraphNode> = {
  'an AI task with an effort': () => nodeOf(runTask({
    id: 'a', order: 1, title: 'Port the parser', type: 'ai', assignedRunner: 'opencode',
    assignedModel: { modelId: 'opencode-go/deepseek-v4.1-flash', modelLabel: 'opencode-go/deepseek-v4.1-flash', thinkingEffort: 'high' },
  })),
  'an AI task with no effort': () => nodeOf(runTask({
    id: 'a', order: 1, title: 'Port the parser', type: 'ai', assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5' },
  })),
  'a script task': () => nodeOf(runTask({ id: 'a', order: 1, title: 'Run the suite', type: 'script', commands: [['npm', 'test']] })),
  'a user task': () => nodeOf(runTask({ id: 'a', order: 1, title: 'Sign the release', type: 'user' })),
  'an ops task': () => nodeOf(runTask({ id: 'a', order: 1, title: 'Open the PR', type: 'ai', assignedRunner: 'claude-code', ops: true })),
  'a research task': () => nodeOf(runTask({
    id: 'a', order: 1, title: 'Survey the parsers', type: 'ai', assignedRunner: 'claude-code', taskMode: 'plan', research: true,
    assignedModel: { modelId: 'opus', modelLabel: 'opus', thinkingEffort: 'xhigh' },
  })),
  'a loop\'s check': () => nodeOf(
    runTask({ id: 'a', order: 1, title: 'Check the parser', type: 'ai', assignedRunner: 'claude-code', status: 'in_progress', loop: { body: ['b'], maxRounds: 3 }, loopRound: 2 }),
    [runTask({ id: 'b', order: 2, dependencies: ['a'] })],
  ),
};

afterEach(cleanup);

describe('TaskCard: every kind of task, in both densities', () => {
  for (const [kind, make] of Object.entries(KINDS)) {
    for (const density of ['comfortable', 'compact'] as const) {
      it(`draws ${kind} in ${density}: its title, who does it, and the third row only in Comfortable`, () => {
        const node = make();
        const { root, q } = card(node, density);
        expect(root.dataset.density).toBe(density);
        expect(q('.graph-card-order')?.textContent).toBe(`#${node.orderLabel}`);
        expect(q('.graph-card-heading')?.title).toBe(node.title);
        expect(q('.graph-card-heading')?.textContent).toContain(node.title);
        expect(q('.graph-card-lane')?.dataset.lane).toBe(node.lane.kind);
        expect(q('.graph-card-foot') !== null).toBe(density === 'comfortable');
      });
    }
  }

  it('names the runner by its badge, then the model and the effort, each with the whole in its tooltip', () => {
    const { q } = card(KINDS['an AI task with an effort']!(), 'comfortable');
    expect(q('.graph-card-runner')?.textContent).toBe('OpenCode');
    expect(q('.graph-card-runner')?.className).toContain('ow-runner-opencode');
    expect(q('.graph-card-model')?.textContent).toBe('opencode-go/deepseek-v4.1-flash');
    expect(q('.graph-card-model')?.title).toBe('Model: opencode-go/deepseek-v4.1-flash');
    expect(q('.graph-card-effort')?.textContent).toBe('high');
    expect(q('.graph-card-effort')?.title).toBe('Thinking effort: high');
  });

  it('draws no effort for a task with none, and still names its model', () => {
    const { q } = card(KINDS['an AI task with no effort']!(), 'compact');
    expect(q('.graph-card-runner')?.textContent).toBe('Codex');
    expect(q('.graph-card-model')?.textContent).toBe('gpt-5');
    expect(q('.graph-card-effort')).toBeNull();
  });

  it('says "Script" with its first command for a script task, and "You" for a user task, with no model', () => {
    const script = card(KINDS['a script task']!(), 'comfortable');
    expect(script.q('.graph-card-who')?.textContent).toBe('Script');
    expect(script.q('.graph-card-command')?.textContent).toBe('npm test');
    expect(script.q('.graph-card-model')).toBeNull();
    cleanup();
    const user = card(KINDS['a user task']!(), 'comfortable');
    expect(user.q('.graph-card-who')?.textContent).toBe('You');
    expect(user.q('.graph-card-model')).toBeNull();
  });

  it('badges an ops task, a research task and a loop\'s round in Comfortable', () => {
    expect(card(KINDS['an ops task']!(), 'comfortable').q('[data-trait="ops"]')?.textContent).toBe('Ops');
    cleanup();
    const research = card(KINDS['a research task']!(), 'comfortable');
    expect(research.q('[data-trait="research"]')?.textContent).toBe('Research');
    expect(research.q('[data-trait="read-only"]')).toBeNull();
    expect(research.q('.graph-card-effort')?.title).toBe('Thinking effort: extra high');
    cleanup();
    const loop = card(KINDS['a loop\'s check']!(), 'comfortable');
    expect(loop.q('[data-loop="check"]')?.textContent).toBe('2/3');
  });

  it('keeps the badges out of Compact, where the face\'s description says them', () => {
    const node = KINDS['an ops task']!();
    const { q } = card(node, 'compact');
    expect(q('[data-trait]')).toBeNull();
    expect(q('.graph-card-face')?.getAttribute('aria-description')).toContain('ops');
  });

  it('counts a running attempt\'s time and shows a finished one\'s', () => {
    const since = new Date(Date.now() - 65_000).toISOString();
    const running = card(nodeOf(runTask({
      id: 'a', order: 1, type: 'ai', assignedRunner: 'claude-code', status: 'in_progress', attempted: true,
      attemptUsage: [startAttemptUsage(1, 'claude-code', since)],
    })), 'comfortable');
    expect(running.q('.graph-card-elapsed')?.textContent).toMatch(/^1m/);
    cleanup();
    const done = card(nodeOf(runTask({
      id: 'a', order: 1, type: 'ai', assignedRunner: 'claude-code', status: 'completed',
      attemptUsage: [{ ...startAttemptUsage(1, 'claude-code', since), endedAt: since, wallTimeMs: 130_000 }],
    })), 'comfortable');
    expect(done.q('.graph-card-elapsed')?.textContent).toBe('2m 10s');
  });
});

describe('TaskCard: what a click does', () => {
  it('selects on a click, opens on a double click, and opens the chat from its own button', () => {
    const node = nodeOf(runTask({ id: 'a', order: 1, title: 'Port', type: 'ai', assignedRunner: 'claude-code', status: 'in_progress', attempted: true }));
    const { q, stub } = card(node, 'comfortable');
    fireEvent.click(q('.graph-card-face')!);
    expect(stub.select).toHaveBeenCalledWith('a');
    fireEvent.doubleClick(q('.graph-card-face')!);
    expect(stub.open).toHaveBeenCalledWith('a');
    const chat = q('.graph-card-chat')!;
    expect(chat.getAttribute('aria-label')).toBe('Open chat for #1 Port');
    expect(q('.graph-card-face')?.contains(chat)).toBe(false);
    fireEvent.click(chat);
    expect(stub.openChat).toHaveBeenCalledWith('a');
  });
});

describe('TaskCard: a line too narrow for the assignment', () => {
  const lane = { kind: 'ai' as const, runner: 'claude-code', model: 'opencode-go/deepseek-v4.1-flash', effort: 'xhigh' };

  it('shortens the effort first, then the model at its words, then the runner\'s name, and keeps the effort\'s icon alone last', () => {
    expect(aiForms(lane)).toEqual([
      { shortRunner: false, model: 'opencode-go/deepseek-v4.1-flash', effort: 'extra high' },
      { shortRunner: false, model: 'opencode-go/deepseek-v4.1-flash', effort: 'xhigh' },
      { shortRunner: false, model: 'deepseek-v4.1-flash', effort: 'xhigh' },
      { shortRunner: false, model: 'deepseek-v4.1…', effort: 'xhigh' },
      { shortRunner: false, model: 'deepseek…', effort: 'xhigh' },
      { shortRunner: true, model: 'deepseek…', effort: 'xhigh' },
      { shortRunner: true, model: 'deepseek…', effort: '' },
    ]);
  });

  it('takes no step that changes nothing', () => {
    expect(aiForms({ kind: 'ai', runner: 'codex', model: 'gpt', effort: null })).toEqual([{ shortRunner: false, model: 'gpt', effort: null }]);
  });

  it('steps through the forms while the line overflows, and keeps the first that fits', () => {
    const node = KINDS['a research task']!();
    // jsdom lays nothing out: a line overflows exactly while its text is longer than the room this stub gives it,
    // which holds the whole runner and model beside "xhigh" but not beside "extra high".
    const room = 'Claude Codeopusxhigh'.length;
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-card-lane') ? (this.textContent ?? '').length : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-card-lane') ? room : 0;
    });
    try {
      const { q } = card(node, 'comfortable');
      expect(q('.graph-card-runner')?.textContent).toBe('Claude Code');
      expect(q('.graph-card-model')?.textContent).toBe('opus');
      expect(q('.graph-card-effort')?.textContent).toBe('xhigh');
    } finally {
      width.mockRestore();
      client.mockRestore();
    }
  });

  it('keeps the effort\'s icon and tooltip when no form of its words fits', () => {
    const node = KINDS['a research task']!();
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-card-lane') ? (this.textContent ?? '').length : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('graph-card-lane') ? 1 : 0;
    });
    try {
      const { q } = card(node, 'compact');
      expect(q('.graph-card-effort')?.textContent).toBe('');
      expect(q('.graph-card-effort svg')).not.toBeNull();
      expect(q('.graph-card-effort')?.title).toBe('Thinking effort: extra high');
      expect(q('.graph-card-model')?.textContent).toBe('opus');
    } finally {
      width.mockRestore();
      client.mockRestore();
    }
  });
});
