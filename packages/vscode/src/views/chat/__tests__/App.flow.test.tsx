import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { ResearchStep, SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, post, rowKinds } from './hostBridge';
import type { HostToWebview } from '../../../shared/protocol';

function send(msg: HostToWebview) {
  post(msg);
}

const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'build' }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

const TURN = 'turn-1';
const turnStarted = (prompt?: string): SessionMessage => ({ type: 'planner_turn_started', turnId: TURN, ...(prompt ? { prompt } : {}) });
const turnEnded = (outcome: 'message' | 'plan' | 'stopped' = 'message'): SessionMessage => ({ type: 'planner_turn_ended', turnId: TURN, outcome });
const delta = (text: string, segmentId = 's1'): SessionMessage => ({ type: 'planner_text_delta', turnId: TURN, segmentId, text });
const thought = (text: string): SessionMessage => ({ type: 'planner_thinking_delta', turnId: TURN, text });
const reply = (content: string, turnId: string | undefined = TURN): SessionMessage => ({ type: 'planner_message', content, timestamp: '', ...(turnId ? { turnId } : {}) });
const call = (tool: string, args: object, toolCallId?: string, subagentId?: string): SessionMessage => ({
  type: 'research_step', tool, args: JSON.stringify(args), turnId: TURN, ...(toolCallId ? { toolCallId } : {}), ...(subagentId ? { subagentId } : {}),
});
const done = (step: Partial<ResearchStep> & Pick<ResearchStep, 'tool' | 'args' | 'result'>): SessionMessage => ({
  type: 'research_step_done', turnId: TURN, step: { id: 's', timestamp: '', success: true, outcome: 'success', ...step },
});

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter' });
}
const processing = () => document.querySelector('.send-btn.processing') !== null;

describe('chat plan flow', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('shows the plan\'s task cards once it is generated', () => {
    host.session(turnStarted('plan it'), { type: 'plan_token', turnId: TURN, token: '{"tasks":[{"title":"Only task"' });
    send({ type: 'planUpdated', plan });

    expect(screen.getByText('Only task')).toBeTruthy();
    expect(document.querySelector('.plan-card-group')).toBeTruthy();
  });

  it('says a plan is being built while its envelope streams', () => {
    host.session(turnStarted('plan it'), { type: 'plan_token', turnId: TURN, token: '{"tasks":' });

    expect(screen.getByText('Building plan…')).toBeTruthy();
  });

  it('draws the planner\'s thinking as it streams, as one collapsed line', () => {
    host.session(turnStarted(), thought('Analyzing the repo.'));

    expect(document.querySelector('.activity-think-head')!.textContent).toContain('Thinking…');
    expect(document.querySelector('.activity-think-pre')).toBeNull();
  });

  it('locks the input for the length of a planner turn', () => {
    expect(document.querySelector('.send-btn')).toBeTruthy();
    expect(processing()).toBe(false);

    host.session(turnStarted());
    expect(processing()).toBe(true);

    host.session(turnEnded());
    expect(processing()).toBe(false);
  });

  it('streams the reply as it arrives and settles it in place', () => {
    host.session(turnStarted('hi'), delta('Reading **the'));
    expect(document.querySelector('.chat-msg-planner.streaming .chat-msg-content')!.textContent).toBe('Reading **the');

    host.session(delta(' code**.'), reply('Reading **the code**.'), turnEnded());
    const settled = document.querySelectorAll('.chat-msg-planner');
    expect(settled).toHaveLength(1);
    expect(settled[0].classList.contains('streaming')).toBe(false);
    expect(settled[0].querySelector('strong')!.textContent).toBe('the code');
  });

  it('turns the spawn call into one subagent card with its brief, status and digest — its own calls stay inside it', () => {
    host.session(turnStarted(), call('spawn_research_agent', { prompt: 'explore auth' }, 'c-spawn', 'sub-1'));
    expect(rowKinds()).toEqual(['cmd-row']);

    host.session(
      { type: 'subagent_started', turnId: TURN, subagentId: 'sub-1', brief: 'explore auth' },
      call('read_file', { path: 'src/auth.ts' }, 'c-read', 'sub-1'),
    );
    expect(document.querySelector('.subagent-card-status')!.textContent).toBe('running…');
    expect(rowKinds()).toEqual(['subagent-card']);

    host.session(
      done({ tool: 'read_file', args: '{"path":"src/auth.ts"}', result: 'contents', toolCallId: 'c-read', subagentId: 'sub-1' }),
      { type: 'subagent_finished', turnId: TURN, subagentId: 'sub-1', outcome: 'done', digest: 'Digest: uses JWT.' },
    );
    expect(document.querySelector('.subagent-card-brief')!.textContent).toBe('explore auth');
    expect(document.querySelector('.subagent-card-status')!.textContent).toBe('done');
    expect(document.querySelector('.subagent-card-digest')!.textContent).toBe('Digest: uses JWT.');
    expect(document.querySelector('.subagent-card-steps')).toBeNull();
  });

  it('lands each result on its own row across a parallel same-tool round', () => {
    host.session(turnStarted(), call('read_file', { path: 'src/a.ts' }, 'tc-1'), call('read_file', { path: 'src/b.ts' }, 'tc-2'));
    // Out of order: the second call settles first.
    host.session(done({ tool: 'read_file', args: '{"path":"src/b.ts"}', result: 'b body', toolCallId: 'tc-2' }));

    const rows = () => [...document.querySelectorAll('.cmd-row')].map((r) => [r.querySelector('.cmd-row-head')!.textContent, r.getAttribute('data-status')]);
    expect(rows()).toEqual([['Read(src/a.ts)', 'pending'], ['Read(src/b.ts)', 'ok']]);

    host.session(done({ tool: 'read_file', args: '{"path":"src/a.ts"}', result: 'a body', toolCallId: 'tc-1' }));
    expect(rows()).toEqual([['Read(src/a.ts)', 'ok'], ['Read(src/b.ts)', 'ok']]);
  });

  it('shows a refused command as refused, with the reason in its preview', () => {
    const args = { command: 'rm -rf /' };
    host.session(
      turnStarted(), call('bash', args, 'tc-1'),
      done({ tool: 'bash', args: JSON.stringify(args), result: 'Command refused: writes belong to the runners.', success: false, outcome: 'refused', toolCallId: 'tc-1' }),
    );

    const row = document.querySelector('.cmd-row')!;
    expect(row.getAttribute('data-status')).toBe('denied');
    expect(row.querySelector('.cmd-row-outcome')!.textContent).toBe('refused');
    expect(row.querySelector('.cmd-row-preview')!.textContent).toContain('Command refused');
  });

  it('keeps streamed prose and commands in the order they happened', () => {
    host.session(
      turnStarted(), delta('Let me look at the config first.', 's1'), call('read_file', { path: 'a' }),
      delta('Now I need to find the tests.', 's2'), call('grep', { pattern: 'x' }),
    );

    expect(rowKinds()).toEqual(['chat-msg', 'cmd-row', 'chat-msg', 'cmd-row']);
  });

  it('keeps reasoning and commands interleaved in arrival order', () => {
    host.session(turnStarted(), thought('Scanning the repo…'), call('list_dir', { path: '.' }), { type: 'planner_thinking_delta', turnId: TURN, segmentId: 'k2', text: 'Checking entry points…' });

    expect(rowKinds()).toEqual(['activity-think', 'cmd-row', 'activity-think']);
  });

  it('shows runner output inside the task card once execution starts', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'taskOutput', taskId: 't1', text: 'compiling…\n' });
    send({ type: 'taskOutput', taskId: 't1', text: 'Error: boom\n' });

    fireEvent.click(document.querySelector('.task-card-header')!);
    const output = document.querySelector('.task-output-pre')!;
    expect(output.textContent).toBe('compiling…\nError: boom\n');
  });

  it('drops one session\'s runner output when a new session starts', () => {
    send({ type: 'planUpdated', plan });
    send({ type: 'taskOutput', taskId: 't1', text: 'from the old session' });
    send({ type: 'setState', state: 'empty' });
    send({ type: 'planUpdated', plan });

    fireEvent.click(document.querySelector('.task-card-header')!);
    expect(document.querySelector('.task-output')).toBeNull();
  });

  it('does not render radio tile runner-choice UI', () => {
    send({ type: 'setRunners', runners: [{ id: 'claude-code', displayName: 'Claude Code', enabled: true }, { id: 'opencode', displayName: 'OpenCode', enabled: true }] });
    expect(document.querySelector('.runner-choice')).toBeNull();
  });

  it('renders runner toggle pills', () => {
    send({ type: 'setRunners', runners: [{ id: 'claude-code', displayName: 'Claude Code', enabled: true }] });

    const pill = document.querySelector('.runner-pill.on');
    expect(pill).toBeTruthy();
    expect(pill?.textContent?.includes('Claude Code')).toBeTruthy();
  });

  it('has no TDD pill: tdd is a skill attached to tasks, not a toggle', () => {
    send({ type: 'setSkillToggles', toggles: { verify: false } });
    const labels = Array.from(document.querySelectorAll('.skill-toggle-pill')).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('TDD'))).toBe(false);
  });

  it('renders the structured transport pill and sets it via postMessage', () => {
    api.postMessage.mockClear();

    send({ type: 'runnerTransport', transport: 'terminal' });
    const pill = () => Array.from(document.querySelectorAll('.skill-toggle-pill')).find(
      (b) => b.textContent?.includes('Structured'),
    ) as HTMLButtonElement;
    expect(pill().textContent).not.toContain('experimental');
    expect(pill().classList.contains('off')).toBeTruthy();

    act(() => { fireEvent.click(pill()); });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setRunnerTransport', transport: 'structured' });
    expect(pill().classList.contains('on')).toBeTruthy();

    send({ type: 'runnerTransport', transport: 'terminal' });
    expect(pill().classList.contains('off')).toBeTruthy();
  });

  it('renders a reply sent outside a turn (a PRD) as a planner chat message', () => {
    host.session(reply('## PRD\n\nAs a user, I want to log in', undefined));
    const contentEl = document.querySelector('.chat-msg-planner .chat-msg-content');
    expect(contentEl?.textContent).toContain('As a user, I want to log in');
  });

  it('renders Execute Plan button on plan draft', () => {
    send({ type: 'planUpdated', plan });
    expect(screen.queryByText('Execute Plan')).toBeTruthy();
  });

  it('Run Task requests single-task execution and the plan control becomes Stop while it runs', () => {
    api.postMessage.mockClear();
    send({ type: 'planUpdated', plan });

    fireEvent.click(screen.getByText('Only task'));
    fireEvent.click(screen.getByText('Run Task'));

    expect(api.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sendSystemCommand', command: 'runTask', taskId: 't1' }),
    );

    send({
      type: 'planUpdated',
      plan: { ...plan, status: 'running', tasks: [{ ...plan.tasks[0], status: 'in_progress' }] },
    });
    expect(screen.queryByText('Execute Plan')).toBeNull();
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('sends "proceed" text as a plain chat message (pure chat)', () => {
    api.postMessage.mockClear();
    send({ type: 'planUpdated', plan });

    type('proceed');

    const sent = api.postMessage.mock.calls.map((c) => c[0]).find((m) => m.type === 'sendMessage' && m.text === 'proceed');
    expect(sent).toEqual({ type: 'sendMessage', text: 'proceed', runners: ['claude-code'], typed: true });
  });

  it('sends a message that starts with "retry " to the planner, not as a task retry', () => {
    api.postMessage.mockClear();
    send({ type: 'planUpdated', plan });

    type('retry the parser with a stricter grammar');

    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'sendMessage', text: 'retry the parser with a stricter grammar', runners: ['claude-code'], typed: true,
    });
  });

  it('asks the host to show what the user typed — the conversation is the host\'s', () => {
    api.postMessage.mockClear();
    type('build a login page');

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendMessage', text: 'build a login page', typed: true }));
    // Nothing is drawn until the host says so.
    expect(document.querySelector('.chat-msg-user')).toBeNull();
  });

  it('renders a grilling interview question in the planner bubble, not the user bubble', () => {
    host.session(turnStarted('build a login page'), reply('Should sessions use JWT or cookies?'), turnEnded());

    const questionEl = screen.getByText('Should sessions use JWT or cookies?').closest('.chat-msg');
    expect(questionEl?.classList.contains('chat-msg-planner')).toBe(true);
    expect(screen.getByText('build a login page').closest('.chat-msg')?.classList.contains('chat-msg-user')).toBe(true);
  });

  it('keeps the conversation when the host clears the plan — only the host resets the conversation', () => {
    host.session(reply('Still here.', undefined));
    send({ type: 'setState', state: 'empty' });

    expect(screen.getByText('Still here.')).toBeTruthy();
  });

  it('clears the "processing" send button once the planner\'s turn ends on a follow-up question', () => {
    type('build a login page');
    host.session(turnStarted('build a login page'), thought('Analyzing...'));
    expect(processing()).toBe(true);

    host.session(reply('Should sessions use JWT or cookies?'), turnEnded());
    expect(processing()).toBe(false);
  });

  it('frees the input at once on /new, and the old session\'s late output never lands', () => {
    type('build a login page');
    host.session(turnStarted('build a login page'), delta('Generating plan...'));
    expect(processing()).toBe(true);

    type('/new');
    api.postMessage.mockClear();
    fireEvent.click(screen.getByText('New Session'));
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'newSession' }));
    expect(processing()).toBe(false);

    // What the host does for newSession, then the dying stream's last words.
    host.provider.conversation.reset();
    host.session(delta(' stale token'), reply('Stale message from old session'));

    expect(screen.queryByText(/Generating plan|stale token|Stale message/)).toBeNull();
  });

  it('shows stop button in plan cards and input bar during execution (isExecuting derived from plan status)', () => {
    send({ type: 'planUpdated', plan: { ...plan, status: 'running' as const } });

    expect(screen.queryByText('Stop')).toBeTruthy();
    expect(processing()).toBe(true);
  });

  it('sends stopExecution when stop button is clicked during execution', () => {
    api.postMessage.mockClear();
    send({ type: 'planUpdated', plan: { ...plan, status: 'running' as const } });

    act(() => { fireEvent.click(document.querySelector('.send-btn.processing')!); });

    expect(api.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sendSystemCommand', command: 'stopExecution' }),
    );
  });

  it('a run\'s status tick does not end a planner turn still answering', () => {
    send({ type: 'planUpdated', plan: { ...plan, status: 'running' as const } });
    host.session(turnStarted('while it runs, why is task 2 slow?'));
    expect(document.querySelector('.chat-msg-working')).toBeTruthy();

    send({ type: 'planUpdated', plan: { ...plan, status: 'running' as const } });

    expect(document.querySelector('.chat-msg-working')).toBeTruthy();
  });

  it('keeps following the plan after the run is stopped from the input', () => {
    send({ type: 'planUpdated', plan: { ...plan, status: 'running' as const } });
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing')!); });

    send({ type: 'planUpdated', plan: { ...plan, status: 'draft' as const, tasks: [{ ...plan.tasks[0], title: 'Renamed after the stop' }] } });

    expect(screen.getByText('Renamed after the stop')).toBeTruthy();
  });

  it('stops the planner turn: stopResearch goes to the host and the input frees at once', () => {
    api.postMessage.mockClear();
    host.session(turnStarted(), thought('Analyzing...'));

    act(() => { fireEvent.click(document.querySelector('.send-btn.processing')!); });

    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'stopResearch' }));
    expect(processing()).toBe(false);
  });

  it('keeps what streamed before a stop, once, and drops what arrives after it', () => {
    host.session(turnStarted('explain'), delta('Partial response...'));
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing')!); });

    // What the host does for stopResearch, then the backend noticing late.
    host.provider.conversation.stop();
    host.session(delta(' and more'), reply('Partial response... and more'), turnEnded('stopped'));

    const planner = [...document.querySelectorAll('.chat-msg-planner .chat-msg-content')].map((el) => el.textContent);
    expect(planner).toEqual(['Partial response...']);
    expect(document.querySelector('.chat-msg-planner.streaming')).toBeNull();
  });

  it('ignores a plan that lands between the stop click and the host closing the turn', () => {
    host.session(turnStarted('plan it'));
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing')!); });
    send({ type: 'planUpdated', plan });
    expect(document.querySelector('.plan-card-group')).toBeNull();

    host.provider.conversation.stop();
    send({ type: 'planUpdated', plan });
    expect(document.querySelector('.plan-card-group')).toBeTruthy();
  });

  it('asks for confirmation on /new when there is content even if not processing', () => {
    send({ type: 'planUpdated', plan });
    type('/new');
    expect(screen.getByText('New Session')).toBeTruthy();
  });
});

describe('input watchdog', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    vi.useFakeTimers();
    render(<App />);
    host = hostBridge();
  });
  afterEach(() => vi.useRealTimers());

  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('frees the input after a long silence mid-turn, and says so in the conversation', () => {
    host.session(turnStarted());
    api.postMessage.mockClear();

    wait(125_000);

    expect(processing()).toBe(false);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'addNote', text: expect.stringContaining('stopped responding') });
  });

  it('stays locked while a quiet planner keeps sending liveness', () => {
    host.session(turnStarted());
    for (let i = 0; i < 5; i++) {
      wait(30_000);
      host.session({ type: 'planner_liveness' });
    }

    expect(processing()).toBe(true);
  });
});

/**
 * The planner bar (ADR-0009): who plans, on which of that backend's models, at
 * which effort. Before this, a harness planner had no control at all in the
 * webview — the model row was gated on a configured API key, which is precisely
 * what a coding-agent planner does not have.
 */
describe('planner bar', () => {
  beforeEach(() => render(<App />));

  const backends = [
    { id: 'claude-code', label: 'Claude Code', kind: 'harness' as const, runner: 'claude-code', usable: true },
    { id: 'codex', label: 'Codex', kind: 'harness' as const, runner: 'codex', usable: false, reason: 'codex is not installed or is not on PATH.' },
  ];

  function sendHarnessPlanner() {
    send({ type: 'setPlannerBackends', backends, provider: 'claude-code', runner: 'claude-code' });
    send({
      type: 'setModelsByRunner',
      modelsByRunner: {
        'claude-code': [
          { modelId: 'sonnet', modelLabel: 'Sonnet', runnerProvider: 'anthropic', runnerId: 'claude-code', runnerLabel: 'Claude Code', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
        ],
      },
    });
  }

  it('does not demand an API key when a coding agent can plan', () => {
    send({ type: 'setConfiguredProviders', providers: [] });
    sendHarnessPlanner();
    expect(document.querySelector('.get-started')).toBeNull();
  });

  it('asks for a coding agent or a key when neither is present', () => {
    send({ type: 'setConfiguredProviders', providers: [] });
    send({ type: 'setPlannerBackends', backends: [backends[1]], provider: '' });
    const started = document.querySelector('.get-started');
    expect(started?.textContent).toContain('Claude Code');
    expect(started?.textContent).toContain('API key');
  });

  it('labels the two setup blocks, planner first', () => {
    sendHarnessPlanner();
    const titles = [...document.querySelectorAll('.setup-block-title')].map((t) => t.textContent);
    expect(titles).toEqual(['Planner', 'Runners']);
  });

  it('tells the user what to install when no runner is detected', () => {
    send({ type: 'setRunners', runners: [] });
    expect(document.querySelector('.setup-block-empty')?.textContent).toContain('Claude Code');
  });

  it('shows the planner picker with no API key configured', () => {
    sendHarnessPlanner();
    const pills = [...document.querySelectorAll('.planner-pill')];
    expect(pills.map((p) => p.textContent)).toEqual(['Claude Code', 'Codex']);
    expect(pills[0].className).toContain('active');
  });

  it('disables an agent whose CLI is missing and keeps its reason on screen', () => {
    sendHarnessPlanner();
    const codex = [...document.querySelectorAll('.planner-pill')].find((p) => p.textContent === 'Codex') as HTMLButtonElement;
    expect(codex.disabled).toBe(true);
    expect(codex.title).toContain('not installed');
  });

  it('switching planner posts setPlanner', () => {
    send({
      type: 'setPlannerBackends',
      backends: [...backends, { id: 'openrouter', label: 'OpenRouter', kind: 'vendor' as const, usable: true }],
      provider: 'claude-code',
      runner: 'claude-code',
    });
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();
    fireEvent.click([...document.querySelectorAll('.planner-pill')].find((p) => p.textContent === 'OpenRouter')!);
    expect(vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'setPlanner', provider: 'openrouter' });
  });

  it("offers the agent's own catalog, not the vendor one", () => {
    send({ type: 'setModelOptions', modelOptions: [{ id: 'deepseek/deepseek-v4-flash', label: 'V4 Flash', provider: 'openrouter', apiProvider: 'openrouter' }] });
    sendHarnessPlanner();
    fireEvent.click(document.querySelector('.model-picker-trigger')!);
    expect(screen.getByText('Sonnet')).toBeTruthy();
    expect(screen.queryByText('V4 Flash')).toBeNull();
  });

  it('renders the effort select from the chosen model variants and posts both together', () => {
    sendHarnessPlanner();
    send({ type: 'setModelConfig', modelConfig: { orchestrator: 'sonnet' } });
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();

    const effort = document.querySelector('.variant-select') as HTMLSelectElement;
    expect([...effort.options].map((o) => o.value)).toEqual(['', 'low', 'high']);

    fireEvent.change(effort, { target: { value: 'high' } });
    expect(vscodeApi.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlannerModel', modelId: 'sonnet', effort: 'high' }));
  });

  it('reflects the effort the extension reports', () => {
    send({ type: 'setPlannerBackends', backends, provider: 'claude-code', runner: 'claude-code', effort: 'high' });
    send({
      type: 'setModelsByRunner',
      modelsByRunner: {
        'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', runnerId: 'claude-code', runnerLabel: 'Claude Code', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] }],
      },
    });
    send({ type: 'setModelConfig', modelConfig: { orchestrator: 'sonnet' } });
    expect((document.querySelector('.variant-select') as HTMLSelectElement).value).toBe('high');
  });
});
