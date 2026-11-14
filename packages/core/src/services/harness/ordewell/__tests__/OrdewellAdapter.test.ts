import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../../AgentAdapter';
import { SessionNotResumable } from '../../ordewellBinding';
import { PROVIDER_PRIORITY, VENDORS } from '../../../apiProviders';
import { HeldSecrets } from '../../../HeldSecrets';
import { removeDir, setEnv } from '../../../../testEnv';
import { ModelError } from '../../../model';
import type { ModelClient } from '../../../model';
import { CONNECTORS } from '../../connectors';
import { OrdewellAdapter, type OrdewellAdapterOptions } from '../OrdewellAdapter';
import { call, deferred, eventsOf, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

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

function adapterWith(steps: readonly ScriptedStep[], options: OrdewellAdapterOptions = {}, processDeps: AgentProcessDeps = deps()) {
  const store = new MemoryTranscriptStore('the-session', tempDir());
  const client = scriptedClient(steps);
  const clients: { provider: string; apiKey: string; baseUrl: string | undefined }[] = [];
  const adapter = new OrdewellAdapter(processDeps, {
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
  it('is the ordewell connector, with no planner', () => {
    expect(CONNECTORS.ordewell?.plans).toBe(false);
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

  it('needs a <provider>:<model> id and that provider\'s key, naming /key', async () => {
    const { adapter } = adapterWith([]);
    await expect(adapter.start(taskOptions({ model: 'mock/test' }))).rejects.toThrow(/needs a model as <provider>:<model>, not "mock\/test"/);
    await expect(adapter.start(taskOptions({ model: 'openai:gpt-test' }))).rejects.toThrow(/No OpenAI key is set for the Ordewell runner: add one with \/key/);
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
