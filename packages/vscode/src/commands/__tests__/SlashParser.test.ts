import { describe, it, expect, vi } from 'vitest';
import { window, commands, __quickPicks, __resetQuickPicks } from '../../test/vscode.mock';
import { handleSlashCommand, isKnownSlashCommand, type SlashDeps } from '../SlashParser';
import type { DiscoveredModel } from '@ordewell/core';

function harnessModel(modelId: string, variantIds: string[] = []): DiscoveredModel {
  return { modelId, modelLabel: modelId, variants: variantIds.map((id) => ({ id, label: id })) };
}

/** Every SlashDeps field the parser can reach, defaulted to a no-op so each test only overrides what it exercises. */
function makeDeps(overrides: Partial<SlashDeps> = {}): SlashDeps {
  return {
    config: {
      orchestratorModel: '', aiProvider: 'claude-code', plannerThinkingEffort: '',
    },
    modelResolver: {
      pickerOptions: async () => [],
      refresh: async () => undefined,
      invalidate: () => {},
      refreshRunnerModels: () => {},
      modelsForRunners: async () => ({}),
    },
    plannerBackends: async () => [],
    refreshPlannerState: async () => {},
    loginPlanner: async () => {},
    runnerRegistry: { list: () => [] },
    chatProvider: {} as SlashDeps['chatProvider'],
    settingsService: { getModelAllowlist: () => undefined, setModelAllowlist: () => {} },
    sendRunnerAndModels: async () => {},
    runApiKeyWizard: async () => {},
    recallPlannerModel: () => ({ model: '', effort: '', source: 'none' }),
    applyPlannerChoice: async () => {},
    log: () => {},
    ...overrides,
  };
}

describe('/planner', () => {
  const backend = { id: 'claude-code', label: 'Claude Code', kind: 'harness' as const, runner: 'claude-code', usable: true };

  it('with no argument walks the stepped picker and applies the choice once', async () => {
    __resetQuickPicks();
    const applyPlannerChoice = vi.fn(async () => {});
    const deps = makeDeps({
      plannerBackends: async () => [backend],
      modelResolver: { ...makeDeps().modelResolver, modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-opus-5-5', ['high'])] }) },
      applyPlannerChoice,
    });

    const done = handleSlashCommand('/planner', deps);
    for (const index of [0, 0, 1]) {
      await new Promise((resolve) => setImmediate(resolve));
      __quickPicks[0].__accept(index);
    }
    await done;

    expect(applyPlannerChoice).toHaveBeenCalledOnce();
    expect(applyPlannerChoice).toHaveBeenCalledWith('claude-code', 'claude-opus-5-5', 'high');
  });

  it('with a backend id switches straight to it, without opening the picker', async () => {
    __resetQuickPicks();
    const executeCommand = commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    executeCommand.mockClear();

    await handleSlashCommand('/planner claude-code', makeDeps({ plannerBackends: async () => [backend] }));

    expect(executeCommand).toHaveBeenCalledWith('ordewell.setPlanner', 'claude-code');
    expect(__quickPicks).toHaveLength(0);
  });
});

describe('/login', () => {
  // The same logins the pill and the empty state offer: `/login` is the active
  // planner, `/login <runner>` a named agent, without switching to it.
  it('with no argument signs in the active planner', async () => {
    const loginPlanner = vi.fn(async () => {});

    await handleSlashCommand('/login', makeDeps({ loginPlanner }));

    expect(loginPlanner).toHaveBeenCalledWith(undefined);
  });

  it('signs in a runner named by id or display label', async () => {
    const loginPlanner = vi.fn(async () => {});
    const runnerRegistry = { list: () => [{ manifest: { name: 'codex', displayName: 'Codex' } }] };

    await handleSlashCommand('/login codex', makeDeps({ loginPlanner, runnerRegistry }));
    expect(loginPlanner).toHaveBeenLastCalledWith('codex');

    await handleSlashCommand('/login Codex', makeDeps({ loginPlanner, runnerRegistry }));
    expect(loginPlanner).toHaveBeenLastCalledWith('codex');
  });

  it('refuses an agent the registry does not hold instead of running nothing', async () => {
    const loginPlanner = vi.fn(async () => {});
    const warning = window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
    warning.mockClear();

    await handleSlashCommand('/login nope', makeDeps({ loginPlanner }));

    expect(loginPlanner).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });
});

describe('/key-set', () => {
  it('opens the key wizard on the provider named, or on the provider list', async () => {
    const runApiKeyWizard = vi.fn(async () => {});
    await handleSlashCommand('/key-set anthropic', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith('anthropic');
    await handleSlashCommand('/key-set', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith(undefined);
  });

  // The table resolves the old name to this one, so its `set` arrives with it.
  it('still answers the old /key and /key set <provider>', async () => {
    const runApiKeyWizard = vi.fn(async () => {});
    expect(isKnownSlashCommand('/key')).toBe(true);
    await handleSlashCommand('/key set openrouter', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith('openrouter');
    await handleSlashCommand('/key google', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith('google');
    await handleSlashCommand('/key', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith(undefined);
  });

  it('refuses a provider it does not know, rather than asking for a key nothing reads', async () => {
    const runApiKeyWizard = vi.fn(async () => {});
    const warning = window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
    warning.mockClear();
    await handleSlashCommand('/key-set nope', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith('Unknown provider: nope. Run /key-set with no argument to pick one.');
  });
});

describe('isKnownSlashCommand', () => {  it('recognizes every extension slash command regardless of case', () => {
    expect(isKnownSlashCommand('/PLANNER')).toBe(true);
    expect(isKnownSlashCommand('/refresh')).toBe(true);
    expect(isKnownSlashCommand('/settings')).toBe(true);
    expect(isKnownSlashCommand('/login')).toBe(true);
  });

  it('recognizes the conversation-editing commands', () => {
    expect(isKnownSlashCommand('/fork')).toBe(true);
    expect(isKnownSlashCommand('/rewind')).toBe(true);
    expect(isKnownSlashCommand('/rewind 3')).toBe(true);
    expect(isKnownSlashCommand('/COMPACT')).toBe(true);
  });

  // /settings and /planner own these values now; the one-value commands only
  // exist headless, where no panel can be opened.
  it.each(['/model', '/model set foo', '/planner-effort', '/auto full', '/supervisor act', '/automerge on', '/autorun on', '/research parallel 2', '/parallel 8'])(
    'does not claim the retired command %s',
    (line) => {
      expect(isKnownSlashCommand(line)).toBe(false);
    },
  );

  it('rejects a discovered-skill invocation so it falls through to the message path', () => {
    expect(isKnownSlashCommand('/grilling')).toBe(false);
    expect(isKnownSlashCommand('/to-spec')).toBe(false);
  });
});

describe('conversation-editing slash commands', () => {
  const executeCommand = commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

  it('/fork runs the fork command', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/fork', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.forkConversation');
  });

  it('/rewind with no argument leaves the choice to the picker', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/rewind', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.rewindConversation', undefined);
  });

  it('/rewind <n> hands the message number on', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/rewind 3', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.rewindConversation', '3');
  });

  it('/settings opens the Settings panel at its Run block, with no quick pick', async () => {
    __resetQuickPicks();
    const openSettings = vi.fn();
    await handleSlashCommand('/settings', makeDeps({ chatProvider: { openSettings } as unknown as SlashDeps['chatProvider'] }));
    expect(openSettings).toHaveBeenCalledOnce();
    expect(__quickPicks).toHaveLength(0);
  });

  it('/compact runs the compact command', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/compact', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.compactConversation');
  });

  it('/help lists every command it answers', async () => {
    const info = window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    info.mockClear();
    await handleSlashCommand('/help', makeDeps());
    const text = info.mock.calls[0][0] as string;
    const lines = text.split('\n');
    for (const command of ['/refresh', '/planner', '/login', '/key-set', '/sessions', '/allowlist', '/help', '/new', '/fork', '/rewind', '/compact', '/settings']) {
      expect(isKnownSlashCommand(command)).toBe(true);
      expect(lines.some((line) => line.startsWith(command))).toBe(true);
    }
    for (const retired of ['/model', '/planner-effort', '/auto', '/supervisor', '/automerge', '/autorun', '/parallel']) {
      expect(isKnownSlashCommand(retired)).toBe(false);
      expect(lines.some((line) => line.startsWith(retired))).toBe(false);
    }
  });
});
