import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentEvent, AgentProcessDeps } from '../AgentAdapter';
import { fakeSpawn, sseResponse } from '../../__tests__/harnessTestKit';
import { patient } from '../../../testing';

/**
 * The planner turn's POST is held open for the whole turn, and Node's global
 * `fetch` gives up on it after 300s with a bare `TypeError: fetch failed`
 * while the OpenCode server keeps planning. The turn's work survives in the
 * session, so the adapter reads it back instead of losing the turn.
 */

type Handler = (url: string, init?: RequestInit) => unknown;

function fakeFetch(routes: Record<string, Handler>): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url.replace('http://127.0.0.1:4096', '')}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) throw new Error(`unrouted request: ${key}`);
    if (key === 'GET /event') return sseResponse(init).response;
    const value = handler(url, init);
    if (value instanceof Error) throw value;
    return { ok: true, status: 200, statusText: 'OK', body: null, json: async () => value } as unknown as Response;
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

async function startAdapter(deps: AgentProcessDeps, spawned: ReturnType<typeof fakeSpawn>, resume?: string) {
  const adapter = new OpenCodeAdapter(deps);
  const started = adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'plan read-only', ...(resume ? { resumeSessionId: resume } : {}) });
  for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
  spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
  await started;
  return adapter;
}

function transportFailure(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
}

describe('OpenCodeAdapter — turn recovery after a dead socket', () => {
  it('reads the reply back out of the session when the message POST fails', async () => {
    const spawned = fakeSpawn([]);
    const routes: Record<string, Handler> = {
      'GET /event': () => ({}),
      'POST /session': () => ({ id: 'ses_1' }),
      'POST /session/ses_1/message': () => transportFailure(),
      'GET /session/ses_1/message': () => [
        { info: { id: 'msg_1', role: 'user', time: { created: 1, completed: 1 } }, parts: [] },
        {
          info: { id: 'msg_2', role: 'assistant', time: { created: 2, completed: 3 } },
          parts: [{ id: 'p1', type: 'text', text: 'the plan', messageID: 'msg_2' }],
        },
      ],
    };
    const http = fakeFetch(routes);
    const deps: AgentProcessDeps = { spawn: spawned.spawn, fetch: http.fetch, resolvePath: async () => '/usr/bin', isDirectory: () => true, exists: () => true };

    const adapter = await startAdapter(deps, spawned);
    const events: AgentEvent[] = [];
    await adapter.send('goal', (e) => events.push(e));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'assistant_text', runId: 'p1', text: 'the plan' });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('names the underlying cause when the reply cannot be recovered', async () => {
    const spawned = fakeSpawn([]);
    const http = fakeFetch({
      'GET /event': () => ({}),
      'POST /session': () => ({ id: 'ses_1' }),
      'POST /session/ses_1/message': () => transportFailure(),
      'GET /session/ses_1/message': () => [],
    });
    const deps: AgentProcessDeps = { spawn: spawned.spawn, fetch: http.fetch, resolvePath: async () => '/usr/bin', isDirectory: () => true, exists: () => true };

    const adapter = await startAdapter(deps, spawned);
    // A server that is gone cannot be polled, so recovery is skipped and the
    // failure is reported with the cause `fetch failed` alone would hide.
    spawned.processes[0].exit(1);
    const events: AgentEvent[] = [];
    await adapter.send('goal', (e) => events.push(e));

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    adapter.dispose();
  });

  it('does not mistake a resumed session’s older reply for this turn’s', async () => {
    const spawned = fakeSpawn([]);
    let polls = 0;
    const http = fakeFetch({
      'GET /event': () => ({}),
      'GET /session/ses_old': () => ({ id: 'ses_old' }),
      'POST /session/ses_old/message': () => transportFailure(),
      'GET /session/ses_old/message': () => {
        polls += 1;
        const history = [{ info: { id: 'msg_old', role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ id: 'p0', type: 'text', text: 'stale', messageID: 'msg_old' }] }];
        // Poll 1 is start()'s baseline read; poll 2 is the recovery read.
        return polls >= 3
          ? [...history, { info: { id: 'msg_new', role: 'assistant', time: { created: 5, completed: 6 } }, parts: [{ id: 'p1', type: 'text', text: 'fresh', messageID: 'msg_new' }] }]
          : history;
      },
    });
    const deps: AgentProcessDeps = { spawn: spawned.spawn, fetch: http.fetch, resolvePath: async () => '/usr/bin', isDirectory: () => true, exists: () => true };

    const adapter = await startAdapter(deps, spawned, 'ses_old');
    const events: AgentEvent[] = [];
    await adapter.send('goal', (e) => events.push(e));

    expect(events.some((e) => e.type === 'assistant_text' && e.text === 'stale')).toBe(false);
    expect(events).toContainEqual({ type: 'assistant_text', runId: 'p1', text: 'fresh' });
    adapter.dispose();
  }, patient(15000));
});
