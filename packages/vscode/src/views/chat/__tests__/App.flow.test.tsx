import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import App from '../App';

function send(msg: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const plan = {
  tasks: [{ id: 't1', order: 1, title: 'Only task', description: '', type: 'ai' as const, status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'build' }],
  generatedAt: new Date().toISOString(),
  status: 'draft' as const,
  runners: ['claude-code'],
  lastUpdated: new Date().toISOString(),
};

describe('chat plan flow', () => {
  beforeEach(() => render(<App />));

  it('renders task cards inline in planner message after plan generation', () => {
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'read_file', toolArgs: '{}' } });
    send({ type: 'streamToken', token: '{"tasks":[{"title":"Only task"' });
    send({ type: 'planUpdated', plan });

    expect(screen.getByText('Only task')).toBeTruthy();
    expect(document.querySelector('.plan-card-group')).toBeTruthy();
  });

  it('shows thinking activities inline during research instead of spinner when activities exist', () => {
    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Analyzing...' } });
    // Activities are shown inline in the researcher chat message, not a bare spinner
    expect(document.querySelector('.activity-think')).toBeTruthy();
  });

  it('shows stop button during research and send button normally', () => {
    expect(document.querySelector('.send-btn')).toBeTruthy();
    expect(document.querySelector('.send-btn.processing')).toBeNull();

    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Analyzing...' } });
    expect(document.querySelector('.send-btn.processing')).toBeTruthy();

    send({ type: 'planUpdated', plan });
    expect(document.querySelector('.send-btn.processing')).toBeNull();
  });

  it('nests a spawned research subagent (issue #34) as its own expandable block with its inner tool call inside', () => {
    const subagentId = 'sub-1';
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'spawn_research_agent', toolArgs: JSON.stringify({ prompt: 'explore auth' }), subagentId } });
    // The subagent block appears immediately, collapsed and running.
    expect(document.querySelector('.activity-subagent')).toBeTruthy();
    expect(document.querySelector('.activity-subagent-badge')).toBeTruthy();
    expect(document.querySelector('.activity-subagent-label')!.textContent).toContain('explore auth');

    // An inner tool call from within the subagent nests under it, not the top-level list.
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'read_file', toolArgs: JSON.stringify({ path: 'src/auth.ts' }), subagentId } });
    expect(document.querySelectorAll('.chat-msg-activities > .activity-subagent').length).toBe(1);
    fireEvent.click(document.querySelector('.activity-subagent-toggle')!);
    expect(document.querySelector('.activity-subagent-body .activity-tool-call')).toBeTruthy();

    // Its result folds into the nested tool_call, not a top-level activity.
    const step = { id: 's1', tool: 'read_file' as const, args: JSON.stringify({ path: 'src/auth.ts' }), result: 'contents', timestamp: '' };
    send({ type: 'researchProgress', progress: { type: 'tool_result', step, subagentId } });
    expect(document.querySelector('.activity-subagent-body .activity-tool-icon')!.textContent).toBe('✓');

    // The subagent's own completion marks it done and attaches its digest.
    const spawnStep = { id: 'sp1', tool: 'spawn_research_agent' as const, args: JSON.stringify({ prompt: 'explore auth' }), result: 'Digest: uses JWT.', timestamp: '' };
    send({ type: 'researchProgress', progress: { type: 'tool_result', step: spawnStep, subagentId } });
    expect(document.querySelector('.activity-subagent-icon')!.textContent).toBe('✓');
    expect(document.querySelector('.activity-subagent-badge')).toBeNull();
    expect(document.querySelector('.activity-subagent-body .activity-think-toggle')).toBeTruthy();
  });

  it('lands each result on its own line across a parallel same-tool round', () => {
    const step = (id: string, path: string, toolCallId: string) => ({
      id, tool: 'read_file' as const, args: JSON.stringify({ path }), result: `${path} body`,
      timestamp: '', success: true, outcome: 'success' as const, toolCallId,
    });

    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'read_file', toolArgs: JSON.stringify({ path: 'src/a.ts' }), toolCallId: 'tc-1' } });
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'read_file', toolArgs: JSON.stringify({ path: 'src/b.ts' }), toolCallId: 'tc-2' } });
    // Out of order: the second call settles first.
    send({ type: 'researchProgress', progress: { type: 'tool_result', step: step('s2', 'src/b.ts', 'tc-2'), toolCallId: 'tc-2' } });

    const names = Array.from(document.querySelectorAll('.activity-tool-name')).map((n) => n.textContent);
    const icons = Array.from(document.querySelectorAll('.activity-tool-icon')).map((n) => n.textContent);
    expect(names).toEqual(['read_file', 'read_file b.ts']);
    expect(icons).toEqual(['⚙', '✓']);

    send({ type: 'researchProgress', progress: { type: 'tool_result', step: step('s1', 'src/a.ts', 'tc-1'), toolCallId: 'tc-1' } });
    expect(Array.from(document.querySelectorAll('.activity-tool-name')).map((n) => n.textContent))
      .toEqual(['read_file a.ts', 'read_file b.ts']);
  });

  it('shows a refused command as refused and keeps its output one click away', () => {
    const step = {
      id: 's1', tool: 'bash' as const, args: JSON.stringify({ command: 'rm -rf /' }),
      result: 'Command refused: writes belong to the runners.',
      timestamp: '', success: false, outcome: 'refused' as const, toolCallId: 'tc-1',
    };

    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'bash', toolArgs: step.args, toolCallId: 'tc-1' } });
    send({ type: 'researchProgress', progress: { type: 'tool_result', step, toolCallId: 'tc-1' } });

    expect(document.querySelector('.activity-tool-icon')!.textContent).toBe('⊘');
    fireEvent.click(document.querySelector('.activity-tool-toggle')!);
    expect(document.querySelector('.activity-tool-pre')!.textContent).toContain('Command refused');
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
    send({ type: 'setEnabledRunnerIds', enabledRunnerIds: ['claude-code', 'opencode'] });
    send({ type: 'setRunnerList', runnerList: [{ id: 'claude-code', displayName: 'Claude Code' }, { id: 'opencode', displayName: 'OpenCode' }] });
    expect(document.querySelector('.runner-choice')).toBeNull();
  });

  it('renders runner toggle pills', () => {
    send({ type: 'setEnabledRunnerIds', enabledRunnerIds: ['claude-code'] });
    send({ type: 'setRunnerList', runnerList: [{ id: 'claude-code', displayName: 'Claude Code' }] });

    const pill = document.querySelector('.runner-pill.on');
    expect(pill).toBeTruthy();
    expect(pill?.textContent?.includes('Claude Code')).toBeTruthy();
  });

  it('renders TDD skill pill and toggles it via postMessage', () => {
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();

    send({ type: 'setSkillToggles', toggles: { tdd: false, verify: false } });
    const tddButton = Array.from(document.querySelectorAll('.skill-toggle-pill')).find(
      (b) => b.textContent?.includes('TDD'),
    ) as HTMLButtonElement;
    expect(tddButton).toBeTruthy();
    expect(tddButton.classList.contains('off')).toBeTruthy();

    act(() => { fireEvent.click(tddButton); });
    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toggleSkill', skillId: 'tdd', enabled: true }),
    );
  });

  it('renders PRD markdown as a planner chat message', () => {
    send({ type: 'newMessage', message: { role: 'assistant', content: '## PRD\n\nAs a user, I want to log in', timestamp: new Date().toISOString() } });
    const contentEl = document.querySelector('.chat-msg-content');
    expect(contentEl?.textContent).toContain('As a user, I want to log in');
    expect(screen.queryByText('Proceed with this PRD')).toBeNull();
    expect(screen.queryByText('Revise PRD')).toBeNull();
  });

  it('renders Execute Plan button on plan draft', () => {
    send({ type: 'planUpdated', plan });
    const executeBtn = screen.queryByText('Execute Plan');
    expect(executeBtn).toBeTruthy();
  });

  it('Run Task requests single-task execution and the plan control becomes Stop while it runs', () => {
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();
    send({ type: 'planUpdated', plan });

    fireEvent.click(screen.getByText('Only task'));
    fireEvent.click(screen.getByText('Run Task'));

    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sendSystemCommand', command: 'runTask', taskId: 't1' }),
    );

    send({
      type: 'planUpdated',
      plan: { ...plan, status: 'running', tasks: [{ ...plan.tasks[0], status: 'in_progress' }] },
    });
    expect(screen.queryByText('Execute Plan')).toBeNull();
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('sends "proceed" text as plain sendMessage without actionContext (pure chat)', () => {
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();

    send({ type: 'planUpdated', plan });

    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: 'proceed' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sendMessage', text: 'proceed' })
    );
    const call = vscodeApi.postMessage.mock.calls.find(
      (c: [{ type: string, text: string, actionContext?: unknown }]) => c[0].type === 'sendMessage' && c[0].text === 'proceed'
    );
    expect(call).toBeTruthy();
    expect(call[0].actionContext).toBeUndefined();
  });

  it('renders planner questions as chat messages, not system messages', () => {
    send({ type: 'newMessage', message: { role: 'assistant', content: 'What language should be used?', timestamp: new Date().toISOString() } });
    expect(screen.getByText('What language should be used?')).toBeTruthy();
    expect(document.querySelector('.prd-answer-input')).toBeNull();
  });

  it('renders a grilling interview question in the planner bubble, not the user bubble', () => {
    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'build a login page' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    send({ type: 'newMessage', message: { role: 'assistant', content: 'Should sessions use JWT or cookies?', timestamp: new Date().toISOString() } });

    const questionEl = screen.getByText('Should sessions use JWT or cookies?').closest('.chat-msg');
    expect(questionEl?.classList.contains('chat-msg-planner')).toBe(true);
    expect(questionEl?.classList.contains('chat-msg-user')).toBe(false);
  });

  it('interleaves streamed prose and commands in execution order (prose folds into thinking dropdowns)', () => {
    send({ type: 'streamToken', token: 'Let me look at the config first.' });
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'read_file', toolArgs: '{}' } });
    send({ type: 'streamToken', token: 'Now I need to find the tests.' });
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'grep', toolArgs: '{}' } });

    const kinds = Array.from(document.querySelectorAll('.chat-msg-activities > *')).map((el) =>
      el.classList.contains('activity-think') ? 'think' : 'tool',
    );
    expect(kinds).toEqual(['think', 'tool', 'think', 'tool']);
    // The folded prose no longer pools below the activity list.
    const bubbleText = document.querySelector('.chat-msg-planner .chat-msg-content');
    expect(bubbleText?.textContent ?? '').toBe('');
  });

  it('keeps reasoning-channel thinking and commands interleaved in arrival order', () => {
    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Scanning the repo…' } });
    send({ type: 'researchProgress', progress: { type: 'tool_call', tool: 'list_directory', toolArgs: '{}' } });
    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Checking entry points…' } });

    const kinds = Array.from(document.querySelectorAll('.chat-msg-activities > *')).map((el) =>
      el.classList.contains('activity-think') ? 'think' : 'tool',
    );
    expect(kinds).toEqual(['think', 'tool', 'think']);
  });

  it('thinking dropdown streams collapsed, opens on click, and collapses again from title or text', () => {
    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Deep in thought…' } });

    // Collapsed by default, even while streaming — the title is the live signal.
    expect(document.querySelector('.activity-think.expanded')).toBeNull();
    const toggle = document.querySelector('.activity-think-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Thinking…');

    act(() => { fireEvent.click(toggle); });
    expect(document.querySelector('.activity-think.expanded')).toBeTruthy();
    expect(document.querySelector('.activity-think-pre')?.textContent).toContain('Deep in thought…');

    // Clicking the opened text collapses it.
    act(() => { fireEvent.click(document.querySelector('.activity-think-body')!); });
    expect(document.querySelector('.activity-think.expanded')).toBeNull();

    // And the title toggles it back open.
    act(() => { fireEvent.click(toggle); });
    expect(document.querySelector('.activity-think.expanded')).toBeTruthy();
  });

  it('keeps the conversation visible when the goal label updates after a plan lands (regression: setGoal used to wipe the timeline)', () => {
    send({ type: 'newMessage', message: { role: 'assistant', content: 'Here is the outline. Confirm?', timestamp: new Date().toISOString() } });
    send({ type: 'planUpdated', plan });
    // finishPlannerTurn sends the goal right after the plan — with an empty
    // goal this used to translate into setState('empty') and erase everything.
    send({ type: 'setGoal', goal: '' });

    expect(screen.getByText('Here is the outline. Confirm?')).toBeTruthy();
    expect(document.querySelector('.plan-card-group')).toBeTruthy();
  });

  it('clears the stuck "processing" send button once the planner asks a follow-up question', () => {
    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'build a login page' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Analyzing...' } });
    expect(document.querySelector('.send-btn.processing')).toBeTruthy();

    send({ type: 'newMessage', message: { role: 'assistant', content: 'Should sessions use JWT or cookies?', timestamp: new Date().toISOString() } });
    expect(document.querySelector('.send-btn.processing')).toBeNull();
  });

  it('drops late newMessage from old session after new session is started', () => {
    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'build a login page' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    send({ type: 'streamToken', token: 'Generating plan...' });
    expect(document.querySelector('.send-btn.processing')).toBeTruthy();

    // Start a new session via /new — during processing this shows a confirm dialog
    fireEvent.change(textarea, { target: { value: '/new' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    const confirmBtn = screen.getByText('New Session');
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();
    fireEvent.click(confirmBtn);
    expect(vscodeApi.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'newSession' }));

    // The processing state should be cleared immediately
    expect(document.querySelector('.send-btn.processing')).toBeNull();

    // A late newMessage from the old session's dying LLM stream must not appear
    send({ type: 'newMessage', message: { role: 'assistant', content: 'Stale message from old session', timestamp: new Date().toISOString() } });
    expect(screen.queryByText('Stale message from old session')).toBeNull();
  });

  it('drops late plannerInterrupted from old session after new session is started', () => {
    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'build a login page' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    send({ type: 'streamToken', token: 'Generating plan...' });

    // Start a new session via /new — confirm the dialog
    fireEvent.change(textarea, { target: { value: '/new' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.click(screen.getByText('New Session'));

    // A late plannerInterrupted from the old session must not un-gate streams
    send({ type: 'plannerInterrupted', message: { role: 'planner', content: 'Stale interrupt', timestamp: new Date().toISOString() } });
    expect(screen.queryByText('Stale interrupt')).toBeNull();

    // A late streamToken from the old session must also be dropped
    send({ type: 'streamToken', token: 'stale token' });
    expect(screen.queryByText('stale token')).toBeNull();
  });

  it('shows stop button in plan cards and input bar during execution (isExecuting derived from plan status)', () => {
    const runningPlan = { ...plan, status: 'running' as const };
    send({ type: 'planUpdated', plan: runningPlan });

    // The plan card Stop button should be visible
    expect(screen.queryByText('Stop')).toBeTruthy();

    // The input bar send/stop button should be in processing (stop) mode
    expect(document.querySelector('.send-btn.processing')).toBeTruthy();
  });

  it('sends stopExecution when stop button is clicked during execution', () => {
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();

    const runningPlan = { ...plan, status: 'running' as const };
    send({ type: 'planUpdated', plan: runningPlan });

    // Click the stop button in the input bar
    const stopBtn = document.querySelector('.send-btn.processing') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    act(() => { fireEvent.click(stopBtn); });

    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sendSystemCommand', command: 'stopExecution' }),
    );
  });

  it('sends stopResearch when stop button is clicked during planner research', () => {
    const vscodeApi = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;
    vscodeApi.postMessage.mockClear();

    send({ type: 'researchProgress', progress: { type: 'thinking', text: 'Analyzing...' } });

    const stopBtn = document.querySelector('.send-btn.processing') as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    act(() => { fireEvent.click(stopBtn); });

    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stopResearch' }),
    );
  });

  it('does not duplicate the planner message when stop is followed by plannerInterrupted', () => {
    // Start a planner turn with streaming content
    send({ type: 'streamToken', token: 'Partial response...' });
    expect(document.querySelector('.send-btn.processing')).toBeTruthy();

    // Click stop
    const stopBtn = document.querySelector('.send-btn.processing') as HTMLButtonElement;
    act(() => { fireEvent.click(stopBtn); });

    // Host responds with plannerInterrupted containing the full content
    send({ type: 'plannerInterrupted', message: { role: 'planner', content: 'Partial response...', timestamp: new Date().toISOString() } });

    // There should be exactly ONE planner message with the content, not two
    const plannerMessages = document.querySelectorAll('.chat-msg-planner .chat-msg-content');
    let count = 0;
    plannerMessages.forEach((el) => {
      if (el.textContent?.includes('Partial response...')) count++;
    });
    expect(count).toBe(1);
  });

  it('asks for confirmation on /new when there is content even if not processing', () => {
    // Send a plan to populate content
    send({ type: 'planUpdated', plan });

    const textarea = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/new' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Confirmation dialog should appear
    expect(screen.getByText('New Session')).toBeTruthy();
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
    send({ type: 'setEnabledRunnerIds', enabledRunnerIds: [] });
    send({ type: 'setRunnerList', runnerList: [] });
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
