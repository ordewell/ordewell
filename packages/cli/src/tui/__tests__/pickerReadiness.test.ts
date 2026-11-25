import { describe, expect, it } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { StepperState } from '../reducers/stepper';
import type { PickerState, RunnerView, TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

/**
 * ADR-0052's choice rule in the terminal pickers: ready choices first, blocked
 * agents kept on the list with one short status and the usual command that
 * fixes them, and a new pick of a blocked one refused with its way in. A
 * choice made before the agent became blocked is never taken away.
 */

const press = (state: TuiState, name: string, char?: string): Step => reduce(state, { type: 'key', key: { name, char } });

const cursorSignIn = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };
const signedOut: RunnerView = {
  id: 'cursor-agent', name: 'Cursor', enabled: false,
  auth: { state: 'signed-out', signIn: cursorSignIn, loginCommand: ['cursor-agent', 'login'] },
  readiness: { kind: 'blocked', why: 'signed-out', signIn: cursorSignIn },
};
const noModel: RunnerView = { id: 'pi', name: 'Pi', enabled: true, auth: { state: 'unknown' }, readiness: { kind: 'no-usable-model' } };
const noKey: RunnerView = {
  id: 'cline', name: 'Cline', enabled: false,
  auth: { state: 'signed-out', signIn: { runner: 'cline', label: 'Cline', key: { provider: 'openrouter', label: 'OpenRouter' } } },
  readiness: { kind: 'blocked', why: 'no-credential', signIn: { runner: 'cline', label: 'Cline', key: { provider: 'openrouter', label: 'OpenRouter' } } },
};
const failed: RunnerView = { id: 'gemini-cli', name: 'Gemini CLI', enabled: true, auth: { state: 'unknown' }, readiness: { kind: 'discovery-failed' } };
const pending: RunnerView = { id: 'qwen-code', name: 'Qwen Code', enabled: true, auth: { state: 'unknown' }, readiness: { kind: 'pending' } };
const agentDefault: RunnerView = { id: 'copilot-cli', name: 'GitHub Copilot CLI', enabled: true, auth: { state: 'signed-in' }, readiness: { kind: 'agent-default' } };
const unknown: RunnerView = { id: 'opencode', name: 'OpenCode', enabled: true, auth: { state: 'unknown' }, readiness: { kind: 'sign-in-unknown' } };
const ready: RunnerView = { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-in' }, readiness: { kind: 'ready' } };

const models = [{ id: 'gpt', label: 'GPT', provider: 'openai', runners: ['codex'], variants: [] }];

function stepperOf(state: TuiState): StepperState {
  if (state.overlay?.kind !== 'stepper') throw new Error('expected a stepper overlay');
  return state.overlay.stepper;
}
function pickerOf(state: TuiState): PickerState {
  if (state.overlay?.kind !== 'picker') throw new Error('expected a picker overlay');
  return state.overlay.picker;
}
function run(text: string, overrides: Partial<TuiState>): Step {
  const base = initialState(overrides);
  return reduce({ ...base, editor: { ...base.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
}
const rowOf = (items: { id: string }[], id: string) => items.findIndex((i) => i.id === id);

describe('/planner', () => {
  const base: Partial<TuiState> = {
    runners: [signedOut, ready, noModel, failed, agentDefault, unknown, pending],
    models,
    plannerProvider: 'codex',
    orchestratorModel: 'gpt',
    configuredProviders: [],
  };

  it('lists every choosable agent first, in its own order, and keeps the blocked ones below with their status and command', () => {
    const items = stepperOf(run('/planner', base).state).items;
    const ids = items.map((i) => i.id);
    expect(ids.indexOf('cursor-agent')).toBeGreaterThan(ids.indexOf('opencode'));
    expect(ids.indexOf('pi')).toBeGreaterThan(ids.indexOf('opencode'));
    expect(items.find((i) => i.id === 'cursor-agent')).toMatchObject({ detail: 'Signed out · /login cursor-agent', warn: true, disabled: true });
    expect(items.find((i) => i.id === 'pi')).toMatchObject({ detail: 'No usable model · /refresh', warn: true, disabled: true });
  });

  it('tells apart the states that never block, each still choosable', () => {
    const items = stepperOf(run('/planner', base).state).items;
    expect(items.find((i) => i.id === 'gemini-cli')).toMatchObject({ detail: "Couldn't load models · /refresh" });
    expect(items.find((i) => i.id === 'copilot-cli')?.detail).toMatch(/^Uses agent default/);
    expect(items.find((i) => i.id === 'opencode')?.detail).toMatch(/^Sign-in not checked/);
    expect(items.find((i) => i.id === 'qwen-code')?.detail).toMatch(/^Checking models…/);
    for (const id of ['gemini-cli', 'copilot-cli', 'opencode', 'qwen-code', 'codex']) {
      expect(items.find((i) => i.id === id)?.disabled).toBeUndefined();
      expect(items.find((i) => i.id === id)?.warn).toBeUndefined();
    }
  });

  it('refuses a new pick of a signed-out agent with its way in, and saves nothing', () => {
    const opened = run('/planner', base).state;
    const stepper = stepperOf(opened);
    const out = press({ ...opened, overlay: { kind: 'stepper', stepper: { ...stepper, index: rowOf(stepper.items, 'cursor-agent') } } }, 'enter');
    expect(out.effects).toEqual([]);
    expect(lastMessage(out.state)).toMatchObject({
      role: 'error',
      text: 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login. Then pick it again.',
    });
    expect(out.state.plannerProvider).toBe('codex');
  });

  it('keeps a planner picked before it signed out: its row is choosable and marked current', () => {
    const opened = run('/planner', { ...base, plannerProvider: 'cursor-agent', orchestratorModel: '' }).state;
    const row = stepperOf(opened).items.find((i) => i.id === 'cursor-agent');
    expect(row).toMatchObject({ detail: '(current) Signed out · /login cursor-agent', warn: true, selected: true });
    expect(row?.disabled).toBeUndefined();
  });
});

describe('/runners', () => {
  const open = (runners: RunnerView[]) => run('/runners', { runners }).state;

  it('lists the choosable first and keeps blocked agents with their command', () => {
    const picker = pickerOf(open([signedOut, noKey, ready, noModel, failed]));
    expect(picker.items.map((i) => i.id)).toEqual(['codex', 'gemini-cli', 'cursor-agent', 'cline', 'pi']);
    expect(picker.items.find((i) => i.id === 'cline')).toMatchObject({ detail: 'API key needed · /key-set', warn: true });
    expect(picker.items.find((i) => i.id === 'gemini-cli')?.detail).toBe("Couldn't load models · /refresh");
  });

  it('refuses switching a blocked agent on, with its way in, and leaves the ticks alone', () => {
    const opened = open([ready, signedOut]);
    const picker = pickerOf(opened);
    const out = press({ ...opened, overlay: { kind: 'picker', picker: { ...picker, index: rowOf(picker.items, 'cursor-agent') } } }, 'char', ' ');
    expect(pickerOf(out.state).chosen).toEqual(['codex']);
    expect(lastMessage(out.state)).toMatchObject({ role: 'error', text: expect.stringMatching(/^Cursor is not signed in\. Sign in with \/login cursor-agent/) });
  });

  it('lets the user switch off an enabled agent that is blocked, and keeps one left on', () => {
    const opened = open([ready, noModel]);
    const picker = pickerOf(opened);
    expect(picker.chosen).toEqual(['codex', 'pi']);
    const off = press({ ...opened, overlay: { kind: 'picker', picker: { ...picker, index: rowOf(picker.items, 'pi') } } }, 'char', ' ');
    expect(pickerOf(off.state).chosen).toEqual(['codex']);
    const saved = press(off.state, 'enter');
    expect(saved.effects).toEqual([expect.objectContaining({ type: 'setRunners', changes: [{ runner: 'pi', enabled: false }] })]);
  });

  it('refuses `/runners <id> on` for a blocked agent, and still switches it off', () => {
    const refused = run('/runners cursor-agent on', { runners: [ready, signedOut] });
    expect(refused.effects).toEqual([]);
    expect(lastMessage(refused.state)?.text).toMatch(/^Cursor is not signed in\./);
    expect(run('/runners pi off', { runners: [ready, noModel] }).effects).toEqual([{ type: 'setRunnerEnabled', runner: 'pi', enabled: false }]);
  });
});

describe('a task\'s runner picker', () => {
  const task: TaskView = {
    id: 't1', order: 1, title: 'Refactor', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'codex', taskMode: 'agent',
  };
  const planPane = (over: Partial<TuiState> = {}) => initialState({
    sessionId: 's1', focus: 'plan', selectedTask: 0, tasks: [task], runners: [signedOut, ready, agentDefault], ...over,
  });

  it('lists the choosable first, keeps the blocked one with its status, and refuses moving the task onto it', () => {
    const opened = press(planPane(), 'char', 'R').state;
    const picker = pickerOf(opened);
    expect(picker.items.map((i) => i.id)).toEqual(['codex', 'copilot-cli', 'cursor-agent']);
    expect(picker.items.find((i) => i.id === 'cursor-agent')).toMatchObject({ detail: 'Signed out · /login cursor-agent', warn: true, disabled: true });
    expect(picker.items.find((i) => i.id === 'copilot-cli')?.detail).toMatch(/^Uses agent default/);

    const out = press({ ...opened, overlay: { kind: 'picker', picker: { ...picker, index: rowOf(picker.items, 'cursor-agent') } } }, 'enter');
    expect(out.effects).toEqual([]);
    expect(lastMessage(out.state)?.text).toMatch(/^Cursor is not signed in\..*Then pick it again\.$/);
  });

  it('keeps a task already on a blocked runner where it is, marked current', () => {
    const picker = pickerOf(press(planPane({ tasks: [{ ...task, assignedRunner: 'cursor-agent' }] }), 'char', 'R').state);
    const row = picker.items.find((i) => i.id === 'cursor-agent');
    expect(row).toMatchObject({ selected: true, warn: true });
    expect(row?.disabled).toBeUndefined();
  });

  it('refuses `/task-runner` onto a blocked runner before asking the daemon', () => {
    const base = planPane();
    const typed = '/task-runner 1 cursor-agent';
    const out = reduce({ ...base, focus: 'chat', editor: { ...base.editor, text: typed, cursor: typed.length } }, { type: 'key', key: { name: 'enter' } });
    expect(out.effects).toEqual([]);
    expect(lastMessage(out.state)?.text).toMatch(/^Cursor is not signed in\./);
  });
});
