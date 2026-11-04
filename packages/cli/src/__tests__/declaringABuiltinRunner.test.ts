import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RunnerManifest } from '@ordewell/core';

// A built-in runner is declared by its manifest and its entry in CONNECTORS and
// nowhere else. This file adds a fake one at exactly those two places, in core's
// source (the CLI otherwise reads core's built bundle, whose modules cannot be
// replaced), and checks that every CLI surface lists it with no edit of its own.
const ACME = vi.hoisted((): RunnerManifest => ({
  name: 'acme',
  displayName: 'Acme Agent',
  runner: { command: 'acme' },
  features: {},
  modelDiscovery: { method: 'command', discoveryCommands: [{ command: 'acme', args: ['models'], parser: 'line-by-line' }] },
  modes: [{ id: 'build', label: 'Build', description: 'Edits files', safe: true, autonomous: true }],
}));

vi.mock('@ordewell/core', () => import('../../../core/src/index'));

vi.mock('../../../core/src/plugins/builtin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/src/plugins/builtin')>();
  return { ...actual, BUILTIN_MANIFESTS: [...actual.BUILTIN_MANIFESTS, ACME] };
});

vi.mock('../../../core/src/services/harness/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/src/services/harness/connectors')>();
  const acme = { ...actual.CONNECTORS['claude-code'] };
  Object.assign(actual.CONNECTORS, { acme });
  return actual;
});

import { RunnerRegistry } from '@ordewell/core';
import type { ApiClient } from '../apiClient';
import { printHelp } from '../help';
import { SLASH_COMMANDS } from '../tui/slash';
import { initialState } from '../tui/state';
import { plannerItems, pickerItemsFor } from '../tui/reducers/pickers';
import { render } from '../tui/render';
import { handleRunners } from '../commands/runners';
import { handlePlannerEffort } from '../commands/planner';

const daemonRunners = () =>
  new RunnerRegistry().list().map((entry) => ({ id: entry.manifest.name, name: entry.manifest.displayName, enabled: true }));

async function printed(run: () => void | Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try { await run(); } finally { log.mockRestore(); }
  return lines.join('\n');
}

describe('a built-in runner declared by manifest and connector only, on the CLI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is listed by `ordewell runners`', async () => {
    const api = { getRunners: async () => ({ runners: daemonRunners() }), getModels: async () => { throw new Error('no catalog'); } } as unknown as ApiClient;
    const out = await printed(() => handleRunners([], api));
    expect(out).toMatch(/acme\s+Acme Agent/);
  });

  it('is named in help and in the /runners command', async () => {
    const help = await printed(() => printHelp());
    expect(help).toContain('Enable or disable runners (claude-code, codex, opencode, copilot-cli, qwen-code, cline, acme)');
    expect(help).toContain('claude-code, codex, opencode, copilot-cli, acme: plan with that CLI');
    expect(SLASH_COMMANDS.find((c) => c.name === 'runners')?.description).toContain('claude-code, codex, opencode, copilot-cli, qwen-code, cline, acme');
  });

  it('is in the runner picker and the planner picker', () => {
    const state = initialState({ runners: daemonRunners() });
    const runnerPicker = pickerItemsFor(state, { kind: 'set-runners' });
    expect(runnerPicker.map((i) => [i.id, i.label])).toContainEqual(['acme', 'Acme Agent']);
    const planner = plannerItems(state).find((i) => i.id === 'acme');
    expect(planner).toMatchObject({ label: 'Acme Agent' });
  });

  it('is named by the first-run notice and the planner switch hint', async () => {
    const welcome = render(initialState({ rows: 40, cols: 200, plannerKnown: true, runnersKnown: true, providersKnown: true })).join('\n');
    expect(welcome).toContain('Claude Code, Codex, OpenCode, GitHub Copilot CLI or Acme Agent');

    const api = {
      getSettings: async () => ({ aiProvider: 'openrouter', orchestratorModel: '', plannerThinkingEffort: '' }),
      getModels: async () => ({ models: [], runners: [] }),
    } as unknown as ApiClient;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handlePlannerEffort([], api)).rejects.toThrow('exit 1');
    expect(err.mock.calls.flat().join('\n')).toContain('ordewell planner claude-code|codex|opencode|copilot-cli|acme');
    exit.mockRestore();
  });
});
