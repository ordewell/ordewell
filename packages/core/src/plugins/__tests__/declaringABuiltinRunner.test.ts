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
import { PROVIDER_PRIORITY, VENDORS } from '../../services/apiProviders';
import { PROVIDER_RUNNER_IDS } from '../../services/providerRunners';
import { setEnv } from '../../testEnv';

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

// One with no command at all: its agent runs in Ordewell's own process on one
// provider's key, as each of the built-in runner's does (ADR-0070).
const INHOUSE = vi.hoisted((): RunnerManifest => ({
  name: 'inhouse',
  displayName: 'In House',
  runner: { inProcess: true, provider: 'google' },
  features: {},
  modelDiscovery: { method: 'providers' },
  modes: [{ id: 'full', label: 'Full', description: 'Edits files', autonomous: true }],
}));

vi.mock('../builtin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../builtin')>();
  return { ...actual, BUILTIN_MANIFESTS: [...actual.BUILTIN_MANIFESTS, ACME, TASKER, INHOUSE] };
});

vi.mock('../../services/harness/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/harness/connectors')>();
  const borrowed = actual.CONNECTORS['claude-code'];
  const acme: RunnerConnector = {
    ...borrowed,
    usageLimitReset: (tail) => (tail.includes('acme quota, back at noon') ? new Date('2026-10-14T12:00:00Z') : null),
  };
  const tasker: RunnerConnector = { ...borrowed, plans: false };
  const inhouse: RunnerConnector = { ...actual.CONNECTORS.google };
  Object.assign(actual.CONNECTORS, { acme, tasker, inhouse });
  return actual;
});

describe('a built-in runner declared by manifest and connector only', () => {
  it('is in the runner list core exposes, after the shipped runners', () => {
    const ids = new RunnerRegistry().list().map((entry) => entry.manifest.name);
    expect(ids).toEqual(['claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent', ...PROVIDER_RUNNER_IDS, 'acme', 'tasker', 'inhouse']);
  });

  it('can plan: it is a harness planner, labelled from its manifest', () => {
    expect(CLI_PROVIDERS).toEqual(['claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent', 'acme']);
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

describe('a built-in runner with no command, declared by manifest and connector only', () => {
  const noKeys = (): (() => void) => setEnv(Object.fromEntries(PROVIDER_PRIORITY.flatMap((p) => [VENDORS[p].apiKeyEnvVar, ...VENDORS[p].detectEnvVars]).map((name) => [name, undefined])));

  it('is in the runner list, runs tasks and does not plan', () => {
    expect(new RunnerRegistry().list().map((entry) => entry.manifest.name)).toContain('inhouse');
    expect(supportsTaskMode('inhouse')).toBe(true);
    expect(isCliProvider('inhouse')).toBe(false);
    expect(plannerBackendEntries({ inhouse: { usable: true } }, []).some((e) => e.id === 'inhouse')).toBe(false);
  });

  it('is installed exactly while its provider has a key, asked afresh and of no binary', async () => {
    const restore = noKeys();
    try {
      const exec = vi.fn(async () => ({ stdout: 'ok' }));
      const installation = new RunnerInstallation(new RunnerRegistry(), exec);
      expect(await installation.isInstalled('inhouse')).toBe(false);
      // Another provider's key is not its provider's.
      const other = setEnv({ [VENDORS.openrouter.apiKeyEnvVar]: 'test-key' });
      expect(await installation.isInstalled('inhouse')).toBe(false);
      other();
      const own = setEnv({ [VENDORS.google.apiKeyEnvVar]: 'test-key' });
      expect(await installation.isInstalled('inhouse')).toBe(true);
      own();
      expect(await installation.isInstalled('inhouse')).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('never reads as signed out: with no key it is unusable and says how to set one, with no way in to offer', async () => {
    const restore = noKeys();
    try {
      const usability = await new RunnerInstallation(new RunnerRegistry(), vi.fn(async () => ({ stdout: '' }))).runnerUsability('inhouse');
      expect(usability).toEqual({ usable: false, reason: 'No In House key is set: add one with /key-set.' });
    } finally {
      restore();
    }
  });

  it('reads as signed in once its provider has a key, with no login or key route attached', async () => {
    const restore = noKeys();
    const restoreKey = setEnv({ [VENDORS.google.apiKeyEnvVar]: 'test-key' });
    try {
      const usability = await new RunnerInstallation(new RunnerRegistry(), vi.fn(async () => ({ stdout: '' }))).runnerUsability('inhouse');
      expect(usability).toEqual({ usable: true, auth: { state: 'signed-in' } });
    } finally {
      restoreKey();
      restore();
    }
  });

  it('offers no models without a key, and asks no binary for them', async () => {
    const restore = noKeys();
    try {
      const execImpl = vi.fn(async () => ({ stdout: '' }));
      const resolver = new ModelResolver(new RunnerRegistry(), {} as IConfig, { execImpl });
      const { inhouse } = await resolver.modelsForRunners(['inhouse']);
      expect(inhouse ?? []).toEqual([]);
      expect(execImpl).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
