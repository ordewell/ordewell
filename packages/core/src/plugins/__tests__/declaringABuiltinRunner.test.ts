import { describe, it, expect, vi } from 'vitest';
import type { RunnerManifest } from '../types';
import type { IConfig } from '../../interfaces/IConfig';
import { RunnerRegistry } from '../RunnerRegistry';
import {
  ALL_PROVIDERS, CLI_PROVIDERS, PROVIDER_LABEL, PROVIDER_SHORT_LABEL, isCliProvider, plannerBackendEntries, providerForRunner, runnerForProvider,
} from '../../services/ProviderRegistry';
import { ModelResolver } from '../../services/ModelResolver';
import { supportsTaskMode, type RunnerConnector } from '../../services/harness/connectors';
import { readUsageLimitReset } from '../../services/runnerExit';
import { RunnerInstallation } from '../../services/RunnerInstallation';

// A built-in runner is declared in exactly two places: its manifest in the
// built-in list and its entry in CONNECTORS. This file adds a fake one there and
// nowhere else; every surface core exposes has to pick it up from those two.
const ACME = vi.hoisted((): RunnerManifest => ({
  name: 'acme',
  displayName: 'Acme Agent',
  runner: { command: 'acme' },
  features: {},
  modelDiscovery: {
    method: 'command',
    discoveryCommands: [{ command: 'acme', args: ['models'], parser: 'line-by-line' }],
  },
  modes: [{ id: 'build', label: 'Build', description: 'Edits files', safe: true, autonomous: true }],
}));

// One whose connector runs tasks but cannot plan yet, as an ACP agent's first slice.
const TASKER = vi.hoisted((): RunnerManifest => ({
  name: 'tasker',
  displayName: 'Tasker',
  runner: { command: 'tasker' },
  features: {},
  modelDiscovery: { method: 'command', discoveryCommands: [] },
  modes: [{ id: 'build', label: 'Build', description: 'Edits files', safe: true, autonomous: true }],
}));

vi.mock('../builtin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../builtin')>();
  return { ...actual, BUILTIN_MANIFESTS: [...actual.BUILTIN_MANIFESTS, ACME, TASKER] };
});

vi.mock('../../services/harness/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/harness/connectors')>();
  const borrowed = actual.CONNECTORS['claude-code'];
  const acme: RunnerConnector = {
    ...borrowed,
    usageLimitReset: (tail) => (tail.includes('acme quota, back at noon') ? new Date('2026-10-14T12:00:00Z') : null),
  };
  const tasker: RunnerConnector = { ...borrowed, plans: false };
  Object.assign(actual.CONNECTORS, { acme, tasker });
  return actual;
});

describe('a built-in runner declared by manifest and connector only', () => {
  it('is in the runner list core exposes, after the shipped runners', () => {
    const ids = new RunnerRegistry().list().map((entry) => entry.manifest.name);
    expect(ids).toEqual(['claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'acme', 'tasker']);
  });

  it('can plan: it is a harness planner, labelled from its manifest', () => {
    expect(CLI_PROVIDERS).toEqual(['claude-code', 'codex', 'opencode', 'copilot-cli', 'acme']);
    expect(isCliProvider('acme')).toBe(true);
    expect(runnerForProvider('acme')).toBe('acme');
    expect(providerForRunner('acme')).toBe('acme');
    expect(ALL_PROVIDERS.acme?.label).toBe('Acme Agent');
    expect(PROVIDER_LABEL.acme).toBe('Acme Agent');
    expect(PROVIDER_SHORT_LABEL.acme).toBe('Acme Agent');
  });

  it('is offered in the planner backend list', () => {
    const acme = plannerBackendEntries({ acme: { usable: true } }, []).find((e) => e.id === 'acme');
    expect(acme).toEqual({ id: 'acme', label: 'Acme Agent', kind: 'harness', runner: 'acme', usable: true, reason: 'coding agent · no API key needed' });
  });

  it('runs tasks', () => {
    expect(supportsTaskMode('acme')).toBe(true);
  });

  it('has its models discovered through its manifest', async () => {
    const execImpl = vi.fn(async (command: string) => ({ stdout: command === 'acme models' ? 'acme-large Acme Large\nacme-small\n' : '' }));
    const resolver = new ModelResolver(new RunnerRegistry(), {} as IConfig, { execImpl });
    const { acme } = await resolver.modelsForRunners(['acme']);
    expect(acme?.map((m) => [m.modelId, m.modelLabel, m.runnerLabel])).toEqual([
      ['acme-large', 'Acme Large', 'Acme Agent'],
      ['acme-small', 'acme-small', 'Acme Agent'],
    ]);
  });

  it('reads its own usage-limit reset through its connector', () => {
    const now = new Date('2026-10-14T09:00:00Z');
    expect(readUsageLimitReset('acme', 'usage limit: acme quota, back at noon', now)?.toISOString()).toBe('2026-10-14T12:00:00.000Z');
  });

  it('runs tasks without planning when its connector does not plan', () => {
    expect(supportsTaskMode('tasker')).toBe(true);
    expect(isCliProvider('tasker')).toBe(false);
    expect(CLI_PROVIDERS).not.toContain('tasker');
    expect(plannerBackendEntries({ tasker: { usable: true } }, []).some((e) => e.id === 'tasker')).toBe(false);
  });

  it('is refused as a planner, in words that say it runs tasks, without starting it', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok' }));
    const installation = new RunnerInstallation(new RunnerRegistry(), exec);

    expect(await installation.plannerUsability('tasker')).toEqual({ usable: false, reason: 'Tasker can run tasks but cannot plan in Ordewell yet.' });
    expect(exec).not.toHaveBeenCalled();
  });
});
