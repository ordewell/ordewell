import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../../AgentAdapter';
import { SessionNotResumable } from '../../ordewellBinding';
import { PROVIDER_PRIORITY, VENDORS } from '../../../apiProviders';
import { PROVIDER_RUNNER_IDS } from '../../../providerRunners';
import { HeldSecrets } from '../../../HeldSecrets';
import { removeDir, setEnv } from '../../../../testEnv';
import { ModelError } from '../../../model';
import type { ModelClient, ModelEvent } from '../../../model';
import { CONNECTORS } from '../../connectors';
import { TASK_TOOLS, taskCompletionContract } from '../../../mcp';
import { DEFAULT_ORDEWELL_STEP_LIMIT, OrdewellAdapter, type OrdewellAdapterOptions } from '../OrdewellAdapter';
import { call, deferred, eventsOf, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';
import type { McpClientConfig } from '../../../mcp/clientConfig';
import type { AiProvider } from '../../../../interfaces/IConfig';

const KEY = 'sk-or-v1-adapter-test-key-0123456789';

const made: string[] = [];
let restoreEnv: () => void = () => {};

beforeEach(() => {
  // No key from the machine running the tests reaches a case that did not hand it one.
  const cleared: Record<string, undefined> = {};
  for (const provider of PROVIDER_PRIORITY) {
    for (const name of [VENDORS[provider].apiKeyEnvVar, ...VENDORS[provider].detectEnvVars]) cleared[name] = undefined;
  }
  restoreEnv = setEnv(cleared);
});

afterEach(async () => {
  restoreEnv();
  await Promise.all(made.splice(0).map((dir) => removeDir(dir)));
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ordewell-adapter-')));
  made.push(dir);
  return dir;
}

function deps(env: Record<string, string> = { OPENROUTER_API_KEY: KEY }, held?: HeldSecrets): AgentProcessDeps {
  return {
    spawn: () => {
      throw new Error('The in-process runner spawned a process.');
    },
    fetch: async () => {
      throw new Error('offline');
    },
    workspaceEnv: async () => env,
    ...(held ? { held } : {}),
  };
}

function taskOptions(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: tempDir(),
    model: 'openrouter:mock/test',
    mode: 'full',
    flags: { permissionMode: 'full', modeSettings: {} },
    ...overrides,
  };
}

function adapterWith(steps: readonly ScriptedStep[], options: OrdewellAdapterOptions = {}, processDeps: AgentProcessDeps = deps(), provider: AiProvider = 'openrouter') {
  const store = new MemoryTranscriptStore('the-session', tempDir());
  const client = scriptedClient(steps);
  const clients: { provider: string; apiKey: string; baseUrl: string | undefined }[] = [];
  const adapter = new OrdewellAdapter(provider, processDeps, {
    modelInfoTimeoutMs: 50,
    openStore: () => store,
    createClient: (provider, apiKey, baseUrl): ModelClient => {
      clients.push({ provider, apiKey, baseUrl });
      return client;
    },
    ...options,
  });
  return { adapter, store, client, clients };
}

describe('OrdewellAdapter', () => {
  it('is every provider runner\'s connector, under the provider\'s id, with no planner and no sign-in route', () => {
    for (const provider of PROVIDER_RUNNER_IDS) {
      const connector = CONNECTORS[provider];
      expect(connector?.plans, provider).toBe(false);
      expect(connector?.signInRoute, provider).toBeUndefined();
      expect(connector?.create(deps()).agentId, provider).toBe(provider);
    }
    expect(CONNECTORS.ordewell).toBeUndefined();
    // A provider whose models cannot be listed has no runner, so no connector (ADR-0070).
    expect(CONNECTORS.perplexity).toBeUndefined();
  });

  describe('as an in-process connector', () => {
    const tools = CONNECTORS.openrouter!.ordewellTools;

    it('names every Ordewell tool by its own name, with no MCP prefix, less what a token hides', () => {
      expect(tools.toolName('task_complete')).toBe('task_complete');
      expect(tools.toolNames('task')).toEqual(TASK_TOOLS.map((tool) => tool.name));
      expect(tools.toolNames('task', ['task_complete'])).not.toContain('task_complete');
    });

    it('hides no planner tool, since it carries no native one instead of Ordewell\'s', () => {
      expect(tools.plannerHidden({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan' })).toEqual([]);
      expect(tools.plannerHidden({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan', nativeSearch: true })).toEqual([]);
    });

    it('treats no request as an Ordewell tool\'s, even one under an Ordewell tool\'s name', () => {
      // Its tools are direct calls, so a request for one never arrives as an MCP ask to wave through.
      // The connector registry types a request as `never`, since each runner's own request type differs.
      const isAsk = tools.isOrdewellAsk as (ask: unknown) => boolean;
      expect(isAsk('task_complete')).toBe(false);
      expect(isAsk('mcp__ordewell__task_complete')).toBe(false);
    });

    it('reads the attach state from the start alone: connected once started, failed otherwise', () => {
      expect(tools.attachState('connected')).toBe('connected');
      for (const status of ['failed', 'pending', 'needs-auth', '', null, undefined]) {
        expect(tools.attachState(status)).toBe('failed');
      }
    });
  });

  it('refuses to plan', async () => {
    const { adapter } = adapterWith([]);
    await expect(adapter.start({ kind: 'planner', cwd: tempDir(), systemPrompt: 'plan' })).rejects.toThrow(/does not plan/);
  });

  it('refuses a mode it does not have, and a change task in its read-only mode, rather than running either as Full', async () => {
    const { adapter } = adapterWith([]);
    await expect(adapter.start(taskOptions({ mode: 'plan' }))).rejects.toThrow(/has no mode "plan"/);
    await expect(adapter.start(taskOptions({ mode: 'read-only' }))).rejects.toThrow(/is for a read-only task/);
  });

  it('needs a <provider>:<model> id of its own provider, and that provider\'s key, naming /key-set', async () => {
    const { adapter } = adapterWith([]);
    await expect(adapter.start(taskOptions({ model: 'mock/test' }))).rejects.toThrow(/needs a model as openrouter:<model>, not "mock\/test"/);
    const keyless = adapterWith([], {}, deps({}), 'openai');
    await expect(keyless.adapter.start(taskOptions({ model: 'openai:gpt-test' }))).rejects.toThrow(/No OpenAI key is set for the built-in runner: add one with \/key-set/);
  });

  it('refuses another provider\'s model rather than run it on its own provider, whatever keys are set', async () => {
    const { adapter, clients } = adapterWith([], {}, deps({ OPENROUTER_API_KEY: KEY, OPENAI_API_KEY: 'sk-openai-test-key' }));
    await expect(adapter.start(taskOptions({ model: 'openai:gpt-test' })))
      .rejects.toThrow('The OpenRouter runner runs only openrouter:<model> models, not "openai:gpt-test": assign the task to the OpenAI runner instead.');
    // Nothing reached a provider: the refusal is before any client is made.
    expect(clients).toEqual([]);
  });

  it('runs a custom endpoint set by its URL alone, keyless, as the planner reaches it', async () => {
    const { adapter, clients } = adapterWith([[STOP]], {}, deps({ OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:1/v1' }), 'openai_compatible');
    await adapter.start(taskOptions({ model: 'openai_compatible:qwen3:8b' }));
    expect(clients).toEqual([{ provider: 'openai_compatible', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1' }]);

    // A key with no endpoint named is no endpoint: its default is a guess at a local server.
    const unnamed = adapterWith([], {}, deps({ OPENAI_COMPATIBLE_API_KEY: 'local-key' }), 'openai_compatible');
    await expect(unnamed.adapter.start(taskOptions({ model: 'openai_compatible:qwen3:8b' }))).rejects.toThrow(/No Custom endpoint is set for the built-in runner: set OPENAI_COMPATIBLE_BASE_URL/);
  });

  it('says once, at the attempt\'s start, that it assumed the model\'s window and how to set it', async () => {
    const { adapter } = adapterWith([[{ type: 'text-delta', text: 'One.' }, STOP], [{ type: 'text-delta', text: 'Two.' }, STOP]]);
    await adapter.start(taskOptions({ model: 'openrouter:acme/unknown' }));
    const first: AgentEvent[] = [];
    await adapter.send('Go.', (event) => first.push(event));
    expect(first[0]).toEqual({
      type: 'command_output',
      text: 'No catalog or provider listing states openrouter:acme/unknown\'s context window: assuming 128,000 tokens. '
        + 'Set it in the settings file as "ordewellContextWindows": { "openrouter:acme/unknown": <tokens> }.',
    });
    const second: AgentEvent[] = [];
    await adapter.send('Again.', (event) => second.push(event));
    expect(eventsOf(second, 'command_output')).toEqual([]);
  });

  it('reads taskCompactAt at the start: off and a number it cannot honour are each said once in the task log', async () => {
    const said = async (setting: string): Promise<string[]> => {
      const restore = setEnv({ ORDEWELL_TASK_COMPACT_AT: setting });
      try {
        const { adapter } = adapterWith([[{ type: 'text-delta', text: 'One.' }, STOP]]);
        await adapter.start(taskOptions({ model: 'openrouter:acme/unknown' }));
        const events: AgentEvent[] = [];
        await adapter.send('Go.', (event) => events.push(event));
        return eventsOf(events, 'command_output').slice(1).map((e) => e.text);
      } finally {
        restore();
      }
    };
    // The assumed 128,000-token window guards from 108,800.
    expect(await said('off')).toEqual([
      'OpenRouter runner: taskCompactAt off is not honoured: without compaction this runner would run into the provider\'s context limit, so it compacts as auto does, from 108800 tokens.',
    ]);
    expect(await said('5000')).toEqual(['OpenRouter runner: taskCompactAt 5000 is outside the 32000 to 108800 tokens it can compact at; using 32000.']);
    expect(await said('60000')).toEqual([]);
    expect(await said('auto')).toEqual([]);
    await expect(said('soon')).rejects.toThrow(/must be auto, off or a whole number of tokens/);

    // Where a number has it compact is the window running long measures a compaction against, as Claude Code's is.
    const windowFor = async (setting: string): Promise<number | undefined> => {
      const restore = setEnv({ ORDEWELL_TASK_COMPACT_AT: setting });
      try {
        const { adapter } = adapterWith([]);
        await adapter.start(taskOptions({ model: 'openrouter:acme/unknown' }));
        return adapter.compactWindowTokens;
      } finally {
        restore();
      }
    };
    expect(await windowFor('60000')).toBe(60_000);
    expect(await windowFor('500000')).toBe(108_800);
    expect(await windowFor('auto')).toBeUndefined();
    expect(await windowFor('off')).toBeUndefined();
  });

  it('reads taskReasoningKept at the start, the variable over the file, and hints the boundary on each request (ADR-0070)', async () => {
    const settingsFile = path.join(tempDir(), 'settings.json');
    await writeFile(settingsFile, JSON.stringify({ taskReasoningKept: 1 }));
    const hints = async (env: Record<string, string>): Promise<unknown[]> => {
      const restore = setEnv({ ORDEWELL_SETTINGS_PATH: settingsFile, ...env });
      try {
        const reads = ['a', 'b', 'c'].map((name, i) => [call(`r${i}`, 'read', { path: `${name}.txt` }), STOP]);
        const { adapter, client } = adapterWith([...reads, [{ type: 'text-delta', text: 'Done.' }, STOP]]);
        await adapter.start(taskOptions({ model: 'openrouter:acme/unknown' }));
        await adapter.send('Go.', () => undefined);
        return client.requests.map((request) => request.reasoning);
      } finally {
        restore();
      }
    };
    // [task, a1, t1, a2, t2, a3, t3]: the fourth call keeps a3's reasoning and may leave out the two before.
    expect(await hints({})).toEqual([undefined, undefined, undefined, { keepFrom: 5 }]);
    expect(await hints({ ORDEWELL_TASK_REASONING_KEPT: 'all' })).toEqual([undefined, undefined, undefined, undefined]);
    await expect(hints({ ORDEWELL_TASK_REASONING_KEPT: 'none' })).rejects.toThrow(/ORDEWELL_TASK_REASONING_KEPT.*all or a whole number of calls/);
  });

  it('takes a model\'s window from the settings file\'s ordewellContextWindows, and says nothing of an assumed one', async () => {
    const settingsFile = path.join(tempDir(), 'settings.json');
    await writeFile(settingsFile, JSON.stringify({ ordewellContextWindows: { 'openrouter:acme/unknown': 64_000 } }));
    const restore = setEnv({ ORDEWELL_SETTINGS_PATH: settingsFile });
    try {
      const { adapter } = adapterWith([[{ type: 'text-delta', text: 'One.' }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }, STOP]]);
      await adapter.start(taskOptions({ model: 'openrouter:acme/unknown' }));
      const events: AgentEvent[] = [];
      await adapter.send('Go.', (event) => events.push(event));
      expect(eventsOf(events, 'command_output')).toEqual([]);
      const record = eventsOf(events, 'usage').at(-1)?.record;
      expect(record?.contextWindow).toBe(64_000);
      expect(record?.contextWindowAssumed).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('runs a turn in-process: no process, attached at once, the provider\'s key and base URL, and a session id', async () => {
    const { adapter, clients } = adapterWith(
      [[{ type: 'text-delta', text: 'Hi.' }, STOP]],
      {},
      deps({ OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: 'http://127.0.0.1:1/v1' }),
    );
    expect(await adapter.mcpAttached()).toBe('failed');
    await adapter.start(taskOptions({ mcp: { name: 'ordewell', url: 'in-process', headers: {}, inProcess: { list: () => [], call: async () => ({ text: '' }) } } }));
    expect(await adapter.mcpAttached()).toBe('connected');
    expect(clients).toEqual([{ provider: 'openrouter', apiKey: KEY, baseUrl: 'http://127.0.0.1:1/v1' }]);
    expect(adapter.nativeSessionId()).toBe('the-session');

    const events: AgentEvent[] = [];
    await adapter.send('Hello.', (event) => events.push(event));
    expect(eventsOf(events, 'assistant_text')[0]?.text).toBe('Hi.');
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('offers the task tools the attempt\'s token serves, as native tools', async () => {
    const calls: string[] = [];
    const { adapter, client } = adapterWith([[call('t', 'task_complete', { status: 'done', summary: 'ok' }), STOP], [STOP]]);
    await adapter.start(taskOptions({
      mcp: {
        name: 'ordewell', url: 'in-process', headers: {},
        inProcess: {
          list: () => [
            { name: 'task_complete', description: 'end the task', inputSchema: { type: 'object', properties: {} } },
            { name: 'read', description: 'read a task', inputSchema: { type: 'object', properties: {} } },
            { name: 'checkpoint', description: 'ask the user', inputSchema: { type: 'object', properties: {} } },
            { name: 'something_new', description: 'not one the runner offers', inputSchema: { type: 'object', properties: {} } },
          ],
          call: async (name) => {
            calls.push(name);
            return { text: 'Task complete.' };
          },
        },
      },
    }));
    await adapter.send('Finish.', () => {});
    expect(client.requests[0]?.tools.map((t) => t.name).slice(-3)).toEqual(['task_complete', 'read_task', 'checkpoint']);
    expect(calls).toEqual(['task_complete']);
  });

  it('a resume reads the saved session, and one with nothing saved is not resumable', async () => {
    const fresh = adapterWith([]);
    await expect(fresh.adapter.start(taskOptions({ resumeSessionId: 'gone' }))).rejects.toBeInstanceOf(SessionNotResumable);

    const { adapter, store, client } = adapterWith([[STOP]]);
    const system = [{ text: 'the saved prompt' }];
    await store.append({ v: 1, kind: 'session', at: 'then', model: 'openrouter:mock/test', system });
    await store.append({ v: 1, kind: 'message', at: 'then', step: 1, message: { role: 'user', text: 'Earlier.' } });
    await adapter.start(taskOptions({ resumeSessionId: 'the-session' }));
    await adapter.send('Go on.', () => {});
    // The saved text is sent as it was; the assembler only adds the cache breakpoint the prompt did not mark.
    expect(client.requests[0]?.system).toEqual([{ text: 'the saved prompt', cacheBreakpoint: true }]);
    expect(client.requests[0]?.messages).toEqual([{ role: 'user', text: 'Earlier.' }, { role: 'user', text: 'Go on.' }]);
  });

  it('holds every key in reach and hides it from what the turn says (ADR-0061)', async () => {
    const held = new HeldSecrets();
    const other = 'sk-ant-another-provider-key-987654321';
    const { adapter } = adapterWith(
      [[{ type: 'text-delta', text: `${KEY} and ${other}` }, STOP]],
      {},
      deps({ OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: other }, held),
    );
    await adapter.start(taskOptions());
    const events: AgentEvent[] = [];
    await adapter.send('Leak.', (event) => events.push(event));
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(other);
    expect(held.hide(KEY)).not.toContain(KEY);
  });

  it('reports a failed step as the session\'s error event, a usage limit as a pause', async () => {
    const failing: ScriptedStep = async function* () {
      yield* [];
      throw new ModelError({ kind: 'usage-limit', message: 'quota reached' });
    };
    const { adapter } = adapterWith([failing], { createClient: () => scriptedClient([failing]) });
    await adapter.start(taskOptions());
    const events: AgentEvent[] = [];
    await adapter.send('Go.', (event) => events.push(event));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'quota reached', usageLimit: {} });
  });

  it('ends a turn the output limit cut off three times in a row as failed, not completed', async () => {
    const cut: ScriptedStep = [{ type: 'thinking-delta', text: 'Thinking at length' }, { type: 'finish', reason: 'length' }];
    const { adapter } = adapterWith([cut, cut, cut]);
    const { reports, mcp } = inProcessTools();
    await adapter.start(taskOptions({ mcp }));
    const events: AgentEvent[] = [];
    await adapter.send('Go.', (event) => events.push(event));
    const reason = 'The model\'s reply was cut off at the output limit of 4096 tokens 3 times in a row without a tool call, so the built-in runner ended the attempt.';
    expect(reports).toEqual([{ status: 'failed', summary: reason, reason }]);
    expect(events.at(-1)).toEqual({ type: 'error', message: reason, usageLimit: false });
  });

  it('interrupt stops cooperatively, then hard-aborts inside the grace', async () => {
    const streaming = deferred();
    const hanging: ScriptedStep = async function* (_request, signal) {
      yield { type: 'text-delta', text: 'Working' };
      streaming.resolve();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const { adapter } = adapterWith([hanging]);
    await adapter.start(taskOptions());
    const events: AgentEvent[] = [];
    const turn = adapter.send('Go.', (event) => events.push(event));
    await streaming.promise;
    expect(await adapter.interrupt(100)).toBe(true);
    await turn;
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(await adapter.interrupt(100)).toBe(false);
  });

  it('marks its own spill files readable and nothing else, and exits once on dispose', async () => {
    const { adapter, store } = adapterWith([]);
    await adapter.start(taskOptions());
    expect(adapter.savedOutput(path.join(store.dir, 'tool-output', 'x.txt'))).toBe(true);
    expect(adapter.savedOutput(path.join(store.dir, '..', 'other'))).toBe(false);
    const exits: number[] = [];
    adapter.onProcessExit((code) => exits.push(code));
    adapter.dispose();
    adapter.dispose();
    expect(exits).toEqual([0]);
    expect(adapter.exited).toBe(true);
    await expect(adapter.send('Go.', () => {})).rejects.toThrow(/not started/);
  });
});

/** The attempt's token's tools, served in this process: `task_complete` and the task record's `read`. */
function inProcessTools(read: () => Promise<{ text: string }> = async () => ({ text: 'the task' })): { reports: unknown[]; mcp: McpClientConfig } {
  const reports: unknown[] = [];
  return {
    reports,
    mcp: {
      name: 'ordewell', url: 'in-process', headers: {},
      inProcess: {
        list: () => [
          { name: 'task_complete', description: 'end the task', inputSchema: { type: 'object', properties: {} } },
          { name: 'read', description: 'read a task', inputSchema: { type: 'object', properties: {} } },
        ],
        call: async (name: string, args: unknown) => {
          if (name === 'read') return read();
          reports.push(args);
          return { text: 'Recorded.' };
        },
      },
    },
  };
}

/** A step that streams `events`, says so, and ends only once released. */
function heldStep(events: readonly ModelEvent[]) {
  const streaming = deferred();
  const release = deferred();
  const step: ScriptedStep = async function* () {
    yield* events;
    streaming.resolve();
    await release.promise;
  };
  return { step, streaming: streaming.promise, release: () => release.resolve() };
}

describe('OrdewellAdapter lifecycle', () => {
  it('resumes a saved session from disk in a new process, the conversation and its prompt as they were (ADR-0018 K1)', async () => {
    const root = tempDir();
    const before = new OrdewellAdapter('openrouter', deps(), { sessionsRoot: root, modelInfoTimeoutMs: 50, createClient: () => scriptedClient([[{ type: 'text-delta', text: 'Half way.' }, STOP]]) });
    await before.start(taskOptions());
    await before.send('Start.', () => {});
    const sessionId = before.nativeSessionId();
    before.dispose();

    // A daemon restarted since: nothing of the first adapter is left but its files.
    const client = scriptedClient([[STOP]]);
    const after = new OrdewellAdapter('openrouter', deps(), { sessionsRoot: root, modelInfoTimeoutMs: 50, createClient: () => client });
    await after.start(taskOptions({ resumeSessionId: sessionId ?? undefined }));
    expect(after.nativeSessionId()).toBe(sessionId);
    await after.send('Go on.', () => {});
    expect(client.requests[0]?.messages).toEqual([
      { role: 'user', text: 'Start.' },
      { role: 'assistant', text: 'Half way.' },
      { role: 'user', text: 'Go on.' },
    ]);
  });

  it('never resumes a transcript with no start as a fresh session, and keeps a crash\'s torn line from swallowing the next', async () => {
    const root = tempDir();
    await mkdir(path.join(root, 'no-start'), { recursive: true });
    await writeFile(path.join(root, 'no-start', 'transcript.jsonl'), 'not json\n');
    const noStart = new OrdewellAdapter('openrouter', deps(), { sessionsRoot: root, modelInfoTimeoutMs: 50, createClient: () => scriptedClient([]) });
    await expect(noStart.start(taskOptions({ resumeSessionId: 'no-start' }))).rejects.toThrow(SessionNotResumable);

    const session = JSON.stringify({ v: 1, kind: 'session', at: 'then', model: 'openrouter:mock/test', system: [{ text: 'saved' }] });
    await mkdir(path.join(root, 'torn'), { recursive: true });
    await writeFile(path.join(root, 'torn', 'transcript.jsonl'), `${session}\n{"v":1,"kind":"mess`);
    const client = scriptedClient([[STOP], [STOP]]);
    const torn = new OrdewellAdapter('openrouter', deps(), { sessionsRoot: root, modelInfoTimeoutMs: 50, createClient: () => client });
    await torn.start(taskOptions({ resumeSessionId: 'torn' }));
    await torn.send('First.', () => {});
    await torn.send('Second.', () => {});
    expect(client.requests[1]?.messages).toEqual([{ role: 'user', text: 'First.' }, { role: 'user', text: 'Second.' }]);
  });

  it('fails a start whose saved session cannot be read now, without calling it unresumable', async () => {
    const store = new MemoryTranscriptStore('the-session', tempDir());
    store.exists = async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const { adapter } = adapterWith([], { openStore: () => store });
    const started = adapter.start(taskOptions({ resumeSessionId: 'the-session' }));
    await expect(started).rejects.toThrow(/could not read saved session the-session: EACCES/);
    await expect(started).rejects.not.toBeInstanceOf(SessionNotResumable);
  });

  it('delivers a steered message at the next step boundary, not at the turn\'s end (ADR-0023)', async () => {
    const first = heldStep([call('g', 'glob', { pattern: '*' }), STOP]);
    const { adapter, client } = adapterWith([first.step, [STOP]]);
    expect(await adapter.steer('early', 'No turn yet.')).toBe(false);
    await adapter.start(taskOptions());
    const events: AgentEvent[] = [];
    const turn = adapter.send('Go.', (event) => events.push(event));
    await first.streaming;
    expect(await adapter.steer('m1', 'Also look at the docs.')).toBe(true);
    first.release();
    await turn;
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.messages.at(-1)).toEqual({ role: 'user', text: 'Also look at the docs.' });
    expect(events.filter((e) => e.type === 'message_delivered' || e.type === 'turn_end')).toEqual([
      { type: 'message_delivered', id: 'm1' },
      { type: 'turn_end' },
    ]);
  });

  it('drops a message the turn ended before showing, ahead of the turn\'s end, and takes none while stopping', async () => {
    const only = heldStep([{ type: 'text-delta', text: 'Done.' }, STOP]);
    const { adapter } = adapterWith([only.step]);
    await adapter.start(taskOptions());
    const events: AgentEvent[] = [];
    const turn = adapter.send('Go.', (event) => events.push(event));
    await only.streaming;
    expect(await adapter.steer('late', 'One more thing.')).toBe(true);
    expect(await adapter.interrupt(10_000)).toBe(true);
    expect(await adapter.steer('stopping', 'Too late.')).toBe(false);
    only.release();
    await turn;
    expect(events.slice(-2)).toEqual([{ type: 'message_dropped', id: 'late' }, { type: 'turn_end', interrupted: true }]);
  });

  it('a soft interrupt lets the running tool finish, then makes no further model call', async () => {
    const tool = deferred<{ text: string }>();
    const tools = inProcessTools(() => tool.promise);
    const { adapter, client } = adapterWith([[call('r', 'read_task', {}), STOP], [STOP]]);
    await adapter.start(taskOptions({ mcp: tools.mcp }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Go.', (event) => events.push(event));
    await vi.waitFor(() => expect(eventsOf(events, 'tool_call')).toHaveLength(1));
    expect(await adapter.interrupt(10_000)).toBe(true);
    tool.resolve({ text: 'the task, read' });
    await turn;
    expect(eventsOf(events, 'tool_result')).toMatchObject([{ name: 'read_task', output: 'the task, read', success: true }]);
    expect(client.requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
  });

  it('says when the request in flight has ended, and ends itself once told no more is coming', async () => {
    const only = heldStep([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }, STOP]);
    const { adapter, store } = adapterWith([only.step]);
    expect(await adapter.stepEnded(10)).toBe(true);
    await adapter.start(taskOptions());
    const turn = adapter.send('Go.', () => {});
    await only.streaming;
    expect(await adapter.stepEnded(20)).toBe(false);
    only.release();
    expect(await adapter.stepEnded(5_000)).toBe(true);
    await turn;
    // Its bill is on record before the step's end is reported.
    expect(store.entries.some((entry) => entry.kind === 'usage')).toBe(true);

    const exits: number[] = [];
    adapter.onProcessExit((code) => exits.push(code));
    adapter.endInput();
    expect(exits).toEqual([0]);
    expect(await adapter.stepEnded(10)).toBe(false);
  });

  it('fails a bad key\'s step naming /key-set, as not the usage limit', async () => {
    const refused: ScriptedStep = async function* () {
      yield* [];
      throw new ModelError({ kind: 'auth', message: 'invalid api key', status: 401 });
    };
    const { adapter } = adapterWith([refused]);
    await adapter.start(taskOptions());
    const events: AgentEvent[] = [];
    await adapter.send('Go.', (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'error', usageLimit: false, message: expect.stringMatching(/invalid api key.*\/key-set/) });
  });

  it('sends every runner\'s completion contract and its own step budget in the system prompt', async () => {
    const { adapter, client } = adapterWith([[STOP]], { stepLimit: 137 });
    await adapter.start(taskOptions({ mcp: inProcessTools().mcp, commits: true }));
    await adapter.send('Go.', () => {});
    const system = client.requests[0]?.system.map((part) => part.text).join('\n') ?? '';
    expect(system).toContain(taskCompletionContract({ commits: true }));
    expect(system).toContain('a budget of 137 model calls for this attempt');
  });

  it('takes its step limit from the settings file, the default where it names none', async () => {
    const settingsFile = path.join(tempDir(), 'settings.json');
    const restore = setEnv({ ORDEWELL_SETTINGS_PATH: settingsFile });
    try {
      const unset = adapterWith([[STOP]]);
      await unset.adapter.start(taskOptions({ mcp: inProcessTools().mcp }));
      await unset.adapter.send('Go.', () => {});
      expect(unset.client.requests[0]?.toolChoice).toBeUndefined();
      expect(DEFAULT_ORDEWELL_STEP_LIMIT).toBe(200);

      await writeFile(settingsFile, JSON.stringify({ ordewellStepLimit: 1 }));
      const tools = inProcessTools();
      const limited = adapterWith([[call('c', 'task_complete', { status: 'blocked', summary: 'halfway' }), STOP]]);
      await limited.adapter.start(taskOptions({ mcp: tools.mcp }));
      await limited.adapter.send('Go.', () => {});
      expect(limited.client.requests).toHaveLength(1);
      expect(limited.client.requests[0]?.toolChoice).toEqual({ name: 'task_complete' });
      expect(tools.reports).toEqual([{ status: 'blocked', summary: 'halfway' }]);
    } finally {
      restore();
    }
  });

  it('abandons a stream quiet past the settings file\'s timeout and sends the step again, noting it in the task log', async () => {
    const settingsFile = path.join(tempDir(), 'settings.json');
    await writeFile(settingsFile, JSON.stringify({ ordewellStreamTimeouts: { firstEventSeconds: 1, idleSeconds: 1 }, ordewellContextWindows: { 'openrouter:mock/test': 128_000 } }));
    const restore = setEnv({ ORDEWELL_SETTINGS_PATH: settingsFile });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'mock/test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const requests: string[] = [];
    const fetch: AgentProcessDeps['fetch'] = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('chat/completions')) throw new Error('offline');
      requests.push(url);
      const quiet = requests.length === 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (quiet) {
            // The request is taken and then nothing comes back, as the qwen3-coder smoke's step 6.
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
            return;
          }
          controller.enqueue(new TextEncoder().encode(`${chunk({ role: 'assistant', content: 'Done.' })}${chunk({}, 'stop')}data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const store = new MemoryTranscriptStore('the-session', tempDir());
      const adapter = new OrdewellAdapter('openrouter', { ...deps(), fetch }, {
        modelInfoTimeoutMs: 50,
        openStore: () => store,
        retry: { policy: { initialDelayMs: 1, maxDelayMs: 1, jitter: 0 } },
      });
      await adapter.start(taskOptions());
      const events: AgentEvent[] = [];
      await adapter.send('Go.', (event) => events.push(event));
      expect(requests).toHaveLength(2);
      expect(eventsOf(events, 'command_output').map((e) => e.text)).toEqual([
        expect.stringMatching(/no first event within 1 s.*The step is sent again in 0\.0 s \(retry 1\)/),
      ]);
      expect(eventsOf(events, 'assistant_text').at(-1)?.text).toBe('Done.');
    } finally {
      restore();
    }
  });
});
