import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { harnessResearchChat } from '../AiService';
import { fakeConfig } from '../../testing';

interface Seen { path: string; authorization: string; model: string; tools: string[] }

let server: http.Server | undefined;
afterEach(() => new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); }));

/** A provider endpoint that answers one chat completion and records what reached it. */
async function provider(): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model: string; tools?: { function: { name: string } }[] };
      seen.push({ path: req.url ?? '', authorization: String(req.headers.authorization), model: parsed.model, tools: (parsed.tools ?? []).map((t) => t.function.name).sort() });
      // The chat streams, as a provider's server-sent events.
      const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: parsed.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk([{ index: 0, delta: { role: 'assistant', content: 'digest' }, finish_reason: 'stop' }]) + chunk([], { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, seen };
}

describe('harnessResearchChat (ADR-0066)', () => {
  it('talks to the offered provider with its key and model, whatever the planner config names', async () => {
    const { baseUrl, seen } = await provider();
    const config = fakeConfig({ aiProvider: 'opencode', orchestratorModel: 'planner-model' });
    const agent = harnessResearchChat(config, { kind: 'offered', vendor: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', apiKey: 'sk-agent', baseUrl });
    expect(agent.model).toBe('deepseek/deepseek-v4.1-flash');
    const chat = agent.createChat(() => {}, () => {}, new Set(['read_file', 'grep']));
    const reply = await chat!.sendMessage('map src');
    expect(reply.text).toBe('digest');
    expect(seen).toEqual([{ path: '/v1/chat/completions', authorization: 'Bearer sk-agent', model: 'deepseek/deepseek-v4.1-flash', tools: ['grep', 'read_file'] }]);
  });
});
