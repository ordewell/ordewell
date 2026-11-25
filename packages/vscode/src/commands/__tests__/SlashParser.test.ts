import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { window, commands, __quickPicks, __resetQuickPicks, __setWorkspaceFolders } from '../../test/vscode.mock';
import { handleSlashCommand, isKnownSlashCommand, type SlashDeps } from '../SlashParser';
import { saveSession, type DiscoveredModel, type LegacyPlanState } from '@ordewell/core';

const reads = vi.hoisted(() => ({ byFile: new Map<string, number>() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === 'string') reads.byFile.set(args[0], (reads.byFile.get(args[0]) ?? 0) + 1);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

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
    runnerInstallation: { filterInstalled: async (runners: string[]) => runners },
    chatProvider: {} as SlashDeps['chatProvider'],
    settingsService: { getModelAllowlist: () => undefined, setModelAllowlist: () => {} },
    sendRunnerAndModels: async () => {},
    runApiKeyWizard: async () => undefined,
    recallPlannerModel: () => ({ model: '', effort: '', source: 'none' }),
    applyPlannerChoice: async () => {},
    log: () => {},
    ...overrides,
  };
}

// The pick is only checked here before `ordewell.loadSessionById` loads it to
// adopt: the check must not also ask whose a pre-upgrade run is, which reads
// every session file (ADR-0013).
describe('/sessions', () => {
  it('reads no other session\'s file beyond listing it before handing the pick to the load', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-slash-'));
    try {
      for (const id of ['session-aaaa0001', 'session-bbbb0002']) {
        const run = { id: `run-${id}`, workspaceRoot: ws, repos: [], shared: [], sharedRepos: [], tasks: {} };
        saveSession({ tasks: [], runners: ['claude-code'], status: 'draft', generatedAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z', isolation: { run, resolvers: {} } } as unknown as LegacyPlanState, id, ws, id);
      }
      const dir = path.join(ws, '.ordewell', 'sessions');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
      // A file saved before runs named their session holds none.
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { plan: { isolation: { run: { session?: string } } } };
        delete data.plan.isolation.run.session;
        fs.writeFileSync(file, JSON.stringify(data));
      }
      const other = files.find((f) => f.endsWith('_bbbb0002.json'))!;
      __setWorkspaceFolders([ws]);
      (window.showQuickPick as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (items: Array<{ sessionId: string }>) => items.find((i) => i.sessionId === 'session-aaaa0001'));
      (commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockClear();
      reads.byFile.clear();

      await handleSlashCommand('/sessions', makeDeps());

      expect(commands.executeCommand).toHaveBeenCalledWith('ordewell.loadSessionById', 'session-aaaa0001');
      expect(reads.byFile.get(other)).toBe(1);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // Task #47: the list was read from the extension host's cwd, `/` for a
  // VS Code started from the Dock.
  it('with no folder open lists nothing and asks for a folder, whatever the cwd holds', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-slash-cwd-'));
    try {
      saveSession({ tasks: [], runners: ['claude-code'], status: 'draft', generatedAt: '2026-01-01T00:00:00Z', lastUpdated: '2026-01-01T00:00:00Z' } as unknown as LegacyPlanState, 'g', ws, 'session-cwd00001');
      vi.spyOn(process, 'cwd').mockReturnValue(ws);
      __setWorkspaceFolders(undefined);
      const showQuickPick = window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
      const showWarningMessage = window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
      showQuickPick.mockClear();
      showWarningMessage.mockClear();

      await handleSlashCommand('/sessions', makeDeps());

      expect(showQuickPick).not.toHaveBeenCalled();
      expect(showWarningMessage.mock.calls.filter(([text]) => String(text).startsWith('Ordewell needs an open folder'))).toHaveLength(1);
    } finally {
      vi.mocked(process.cwd).mockRestore();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

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
    // Claude Code, then Claude Opus 5.5 past the agent's own default, then High.
    for (const index of [0, 1, 1]) {
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

  // Other coding agents change their model with /model; here it is the planner's.
  it('is what /model runs, with or without a backend id', async () => {
    __resetQuickPicks();
    const executeCommand = commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    executeCommand.mockClear();
    expect(isKnownSlashCommand('/model')).toBe(true);

    await handleSlashCommand('/model claude-code', makeDeps({ plannerBackends: async () => [backend] }));

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
    const runApiKeyWizard = vi.fn(async (_provider?: string) => undefined);
    await handleSlashCommand('/key-set anthropic', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith('anthropic');
    await handleSlashCommand('/key-set', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith(undefined);
  });

  // The table resolves the old name to this one, so its `set` arrives with it.
  it('still answers the old /key and /key set <provider>', async () => {
    const runApiKeyWizard = vi.fn(async (_provider?: string) => undefined);
    expect(isKnownSlashCommand('/key')).toBe(true);
    await handleSlashCommand('/key set openrouter', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith('openrouter');
    await handleSlashCommand('/key google', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith('google');
    await handleSlashCommand('/key', makeDeps({ runApiKeyWizard }));
    expect(runApiKeyWizard).toHaveBeenLastCalledWith(undefined);
  });

  it('refuses a provider it does not know, rather than asking for a key nothing reads', async () => {
    const runApiKeyWizard = vi.fn(async (_provider?: string) => undefined);
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
  it.each(['/planner-effort', '/auto full', '/supervisor act', '/automerge on', '/autorun on', '/research parallel 2', '/parallel 8'])(
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
    for (const command of ['/refresh', '/planner', '/login', '/key-set', '/sessions', '/allowlist', '/help', '/new', '/fork', '/rewind', '/compact', '/settings', '/model']) {
      expect(isKnownSlashCommand(command)).toBe(true);
      expect(lines.some((line) => line.startsWith(command))).toBe(true);
    }
    for (const retired of ['/planner-effort', '/auto', '/supervisor', '/automerge', '/autorun', '/parallel']) {
      expect(isKnownSlashCommand(retired)).toBe(false);
      expect(lines.some((line) => line.startsWith(retired))).toBe(false);
    }
  });
});

/**
 * First-run audit F2: a key added where no coding agent plans makes its
 * vendor the planner, which has no default model, so the next goal would be
 * refused. The key route goes on into picking that model.
 */
describe('/key-set ends ready to plan', () => {
  const OPENROUTER = { id: 'openrouter', label: 'OpenRouter', kind: 'vendor' as const, usable: true };
  const MODELS = [
    { id: 'z-ai/glm-4.6', label: 'GLM 4.6', provider: 'z-ai', apiProvider: 'openrouter' as const },
    { id: 'deepseek/v4', label: 'DeepSeek V4', provider: 'deepseek', apiProvider: 'openrouter' as const },
  ];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  function keyed(after: { aiProvider: SlashDeps['config']['aiProvider']; orchestratorModel: string }, saved: 'openrouter' | null = 'openrouter') {
    const deps = makeDeps({
      plannerBackends: async () => [OPENROUTER],
      applyPlannerChoice: vi.fn(async () => {}),
    });
    deps.modelResolver.pickerOptions = async () => MODELS;
    deps.runApiKeyWizard = vi.fn(async () => {
      Object.assign(deps.config, after);
      return saved ?? undefined;
    });
    return deps;
  }

  it('opens the planner\'s model step for the vendor that now plans, and saves the pick', async () => {
    __resetQuickPicks();
    const deps = keyed({ aiProvider: 'openrouter', orchestratorModel: '' });
    const done = handleSlashCommand('/key-set openrouter', deps);

    await flush();
    const qp = __quickPicks[__quickPicks.length - 1];
    expect(qp?.step).toBe(2);
    expect(qp.placeholder).toBe('Pick the planner model for OpenRouter');
    qp.__accept(0);
    await done;

    expect(deps.applyPlannerChoice).toHaveBeenCalledWith('openrouter', 'z-ai/glm-4.6', '');
  });

  it('stops at the key when a coding agent still plans, the vendor has its model, or no key was saved', async () => {
    for (const [after, saved] of [
      [{ aiProvider: 'claude-code', orchestratorModel: '' }, 'openrouter'],
      [{ aiProvider: 'openrouter', orchestratorModel: 'z-ai/glm-4.6' }, 'openrouter'],
      [{ aiProvider: 'openrouter', orchestratorModel: '' }, null],
    ] as const) {
      __resetQuickPicks();
      await handleSlashCommand('/key-set openrouter', keyed(after, saved));
      expect(__quickPicks).toHaveLength(0);
    }
  });
});

