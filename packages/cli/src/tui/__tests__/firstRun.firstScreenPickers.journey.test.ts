import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render } from '../render';
import { style } from '../ansi';
import { pickerItemsFor } from '../reducers/pickers';
import type { StepperState } from '../reducers/stepper';
import type { ModelView, PickerItem, TaskView, TuiState } from '../state';
import { machineA, type MachineAgents } from '../../../../core/src/services/__tests__/firstRunAMachine';
import { firstRunADaemon, type FirstRunADaemon, type FirstRunTui } from './firstRunADaemon';

/**
 * Machine A's first screen and pickers, drawn from what its daemon found on
 * the machine (Claude Code signed out, Codex signed in, Copilot CLI too old):
 * every sign-in state is said in words, so it reads with colour off, and every
 * count of effort levels matches the list it describes.
 */

let colour: { enabled: boolean; attributes: boolean };
beforeAll(() => {
  colour = { enabled: style.enabled, attributes: style.attributes };
  style.enabled = false;
  style.attributes = false;
});
afterAll(() => {
  style.enabled = colour.enabled;
  style.attributes = colour.attributes;
});

const screen = (state: TuiState): string[] => render(state).map((line) => line.trimEnd());

function stepperOf(state: TuiState): StepperState {
  if (state.overlay?.kind !== 'stepper') throw new Error('expected a stepper overlay');
  return state.overlay.stepper;
}

/** The picker row of `label`, as drawn: its number, label, mark and detail. */
function rowOf(lines: string[], label: string): string {
  const row = lines.find((line) => new RegExp(`^\\s*(?:❯\\s*)?\\d+\\.\\s+${label}(?:\\s|$)`).test(line));
  if (row === undefined) throw new Error(`no row for ${label} in:\n${lines.join('\n')}`);
  return row;
}

describe('first run, machine A: the first screen and its pickers', () => {
  let daemon: FirstRunADaemon | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  async function firstScreen(agents: MachineAgents = machineA()): Promise<FirstRunTui> {
    daemon = await firstRunADaemon(agents);
    const tui = daemon.tui();
    // What the TUI's own start fires.
    await tui.run({ type: 'refresh' });
    return tui;
  }

  async function openPlanner(tui: FirstRunTui): Promise<string[]> {
    await tui.type('/planner');
    await tui.press('enter');
    stepperOf(tui.state());
    return screen(tui.state());
  }

  /** Move the open stepper's cursor onto `id`, then press enter. */
  async function choose(tui: FirstRunTui, id: string): Promise<void> {
    const stepper = stepperOf(tui.state());
    const index = stepper.items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`no row for "${id}"`);
    tui.patch({ overlay: { kind: 'stepper', stepper: { ...stepper, index } } });
    await tui.press('enter');
  }

  describe('the first screen', () => {
    it('marks signed-out Claude Code on the Runners line in words, with its login, with colour off', async () => {
      const lines = screen((await firstScreen()).state());

      const start = lines.findIndex((line) => /^\s*Runners\b/.test(line));
      const end = lines.findIndex((line, i) => i > start && /^\s*Autonomy\b/.test(line));
      expect(start).toBeGreaterThanOrEqual(0);
      const runners = lines.slice(start, end < 0 ? start + 1 : end).join(' ');
      expect(runners).toContain('Claude Code');
      expect(runners).toContain('signed out');
      expect(runners).toContain('/login claude-code');
    });

    it('names the installed Copilot CLI it cannot use, with the reason', async () => {
      const lines = screen((await firstScreen()).state());

      const copilot = lines.filter((line) => line.includes('GitHub Copilot CLI'));
      expect(copilot.some((line) => line.includes('too old'))).toBe(true);
      expect(lines.join('\n')).toContain('1.0.105');
    });
  });

  describe('the /planner picker', () => {
    it('never gives signed-out Claude Code the check mark, chosen by nobody or by the user', async () => {
      const tui = await firstScreen();
      expect(rowOf(await openPlanner(tui), 'Claude Code')).not.toContain('✔');
      await tui.press('escape');

      // The user picks it anyway, as /planner saves the pick.
      await tui.run({ type: 'setPlannerChoice', provider: 'claude-code', modelId: '', effort: '', notice: 'Planner: Claude Code' });
      expect(tui.state().plannerProvider).toBe('claude-code');
      expect(rowOf(await openPlanner(tui), 'Claude Code')).not.toContain('✔');
    });

    it('says signed-in Codex is signed in', async () => {
      const codex = rowOf(await openPlanner(await firstScreen()), 'Codex');
      expect(codex).toContain('signed in');
      expect(codex).not.toContain('not signed in');
    });

    it('says an agent whose sign-in cannot be checked was not checked', async () => {
      const lines = await openPlanner(await firstScreen({ ...machineA(), opencode: { version: '1.2.0' } }));
      expect(rowOf(lines, 'OpenCode')).toContain('not checked');
    });

    it('lists the Copilot CLI it cannot use with the reason', async () => {
      const copilot = rowOf(await openPlanner(await firstScreen()), 'GitHub Copilot CLI');
      expect(copilot).toContain('too old');
    });
  });

  describe('effort levels', () => {
    // Codex's own six levels, as its discovery lists them.
    const codexModel: ModelView = {
      id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', runners: ['codex'],
      variants: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id })),
    };

    /** The count a detail shows, and whether the same phrase names the default row on its own. */
    function countIn(detail: string | undefined): { levels: number; plusDefault: boolean } {
      const match = /(\d+)\s+(?:effort\s+)?levels?(\s*\+\s*(?:runner\s+|agent\s+)?default)?/i.exec(detail ?? '');
      if (!match) throw new Error(`no count of effort levels in "${detail}"`);
      return { levels: Number(match[1]), plusDefault: Boolean(match[2]) };
    }

    /** What the effort list offers: every row that can be picked. */
    const offered = (items: PickerItem[]): number => items.filter((item) => !item.disabled).length;

    function expectCountMatches(detail: string | undefined, rows: number): void {
      const { levels, plusDefault } = countIn(detail);
      expect(plusDefault ? levels + 1 : levels).toBe(rows);
    }

    it('the planner\'s model step counts what its effort step offers', async () => {
      const tui = await firstScreen();
      await openPlanner(tui);
      // After the picker's own catalog read, which the inert discovery answers empty.
      tui.patch({ models: [codexModel] });
      await choose(tui, 'codex');

      const detail = stepperOf(tui.state()).items.find((item) => item.id === codexModel.id)?.detail;
      await choose(tui, codexModel.id);
      expectCountMatches(detail, offered(stepperOf(tui.state()).items));
    });

    it('a task\'s model picker counts what its effort picker offers', async () => {
      const tui = await firstScreen();
      const task: TaskView = {
        id: 't1', order: 1, title: 'Add a --name flag', type: 'ai', status: 'pending', dependencies: [],
        assignedRunner: 'codex', assignedModel: { modelId: codexModel.id, modelLabel: codexModel.label },
      };
      tui.patch({ models: [codexModel], tasks: [task] });

      const models = pickerItemsFor(tui.state(), { kind: 'set-task-model', taskId: 't1' });
      const efforts = pickerItemsFor(tui.state(), { kind: 'set-task-effort', taskId: 't1' });
      expectCountMatches(models.find((item) => item.id === codexModel.id)?.detail, offered(efforts));
    });
  });
});
