import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { ModelGateway, OPENAI_API } from '../modelGateway';

const KEY = 'sk-ant-api03-the-real-key';

interface Heard { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }

const open: { gateway?: ModelGateway; server?: Server }[] = [];
afterEach(async () => {
  for (const { gateway, server } of open.splice(0)) {
    await gateway?.close();
    server?.closeAllConnections();
    server?.close();
  }
});

/** A model API on this host's loopback, which writes down all it hears. */
async function upstream(answer: (res: ServerResponse, req: IncomingMessage) => void = (res) => res.end('{"ok":true}')) {
  const heard: Heard[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      heard.push({ method: req.method, url: req.url, headers: req.headers, body });
      answer(res, req);
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  open.push({ server });
  return { heard, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function gatewayTo(url: string) {
  const gateway = new ModelGateway({ key: KEY, upstream: url });
  const port = await gateway.listen();
  open.push({ gateway });
  return { gateway, port };
}

interface Reply { status: number; text: string; headers: IncomingHttpHeaders }

function ask(port: number, { path = '/v1/messages', method = 'POST', headers = {}, body = '{"model":"x"}' }: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    sent.on('error', reject);
    sent.end(method === 'POST' ? body : undefined);
  });
}

describe('the model gateway before the OpenAI API', () => {
  const OPENAI_KEY = 'sk-proj-the-real-key';

  async function gatewayToOpenAi(url: string) {
    const gateway = new ModelGateway({ key: OPENAI_KEY, upstream: url, api: OPENAI_API });
    const port = await gateway.listen();
    open.push({ gateway });
    return { gateway, port };
  }

  it('takes the token as a bearer, and sends the real key the same way', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayToOpenAi(`${api.url}/v1`);

    const reply = await ask(port, { path: '/v1/responses', headers: { authorization: `Bearer ${gateway.token}` } });

    expect(reply).toMatchObject({ status: 200 });
    expect(api.heard[0]).toMatchObject({ method: 'POST', url: '/v1/responses' });
    expect(api.heard[0].headers).toMatchObject({ authorization: `Bearer ${OPENAI_KEY}` });
    expect(api.heard[0].headers['x-api-key']).toBeUndefined();
  });

  it('turns away a bearer that is not its token, and asks nothing upstream', async () => {
    const api = await upstream();
    const { port } = await gatewayToOpenAi(`${api.url}/v1`);

    const reply = await ask(port, { path: '/v1/responses', headers: { authorization: `Bearer ${OPENAI_KEY}` } });

    expect(reply.status).toBe(401);
    expect(api.heard).toHaveLength(0);
  });

  it('carries the model routes and nothing else a key can do, such as listing files', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayToOpenAi(`${api.url}/v1`);
    const headers = { authorization: `Bearer ${gateway.token}` };

    expect((await ask(port, { path: '/v1/models', method: 'GET', headers })).status).toBe(200);
    expect((await ask(port, { path: '/v1/files', method: 'GET', headers })).status).toBe(404);
    expect((await ask(port, { path: '/v1/messages', headers })).status).toBe(404);
    expect(api.heard.map(({ url }) => url)).toEqual(['/v1/models']);
  });

  it('keeps a proxy path the base URL names, under the /v1 such a URL ends in', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayToOpenAi(`${api.url}/proxy/openai/v1`);

    await ask(port, { path: '/v1/responses?stream=true', headers: { authorization: `Bearer ${gateway.token}` } });

    expect(api.heard[0].url).toBe('/proxy/openai/v1/responses?stream=true');
  });
});

describe('the model gateway (ADR-0059 L7)', () => {
  it('carries a model request upstream under the real key, and the answer back', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(api.url);

    const reply = await ask(port, { headers: { 'x-api-key': gateway.token, 'anthropic-version': '2023-06-01' }, body: '{"model":"opus"}' });

    expect(reply).toMatchObject({ status: 200, text: '{"ok":true}' });
    expect(api.heard).toHaveLength(1);
    expect(api.heard[0]).toMatchObject({ method: 'POST', url: '/v1/messages', body: '{"model":"opus"}' });
    expect(api.heard[0].headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
  });

  it('hands a runner a token that is not the key', async () => {
    const api = await upstream();
    const { gateway } = await gatewayTo(api.url);

    expect(gateway.token).not.toContain(KEY);
    expect(gateway.token.length).toBeGreaterThan(32);
  });

  it('streams: a chunk arrives before the answer ends', async () => {
    let finish!: () => void;
    const api = await upstream((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: first\n\n');
      finish = () => res.end('event: last\n\n');
    });
    const { gateway, port } = await gatewayTo(api.url);

    const chunks: string[] = [];
    await new Promise<void>((resolve) => {
      const sent = request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'x-api-key': gateway.token } }, (res) => {
        res.on('data', (chunk) => {
          chunks.push(chunk.toString());
          if (chunks.length === 1) finish();
        });
        res.on('end', resolve);
      });
      sent.end('{}');
    });

    expect(chunks.join('')).toBe('event: first\n\nevent: last\n\n');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('turns away a request without the lease token, and asks nothing upstream', async () => {
    const api = await upstream();
    const { port } = await gatewayTo(api.url);

    expect((await ask(port)).status).toBe(401);
    expect((await ask(port, { headers: { 'x-api-key': 'a-key-of-its-own' } })).status).toBe(401);
    expect(api.heard).toEqual([]);
  });

  it('sends no credential of a client upstream: a key of its own would be a way out', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(api.url);

    await ask(port, { headers: { 'x-api-key': gateway.token, authorization: 'Bearer sk-ant-api03-a-key-of-its-own' } });

    expect(api.heard[0].headers.authorization).toBeUndefined();
    expect(api.heard[0].headers['x-api-key']).toBe(KEY);
  });

  it.each([
    ['another of the API', 'GET', '/v1/files'],
    ['an organization', 'GET', '/v1/organizations/me'],
    ['the way out of a path', 'POST', '/v1/messages/../files'],
    ['an encoded way out of a path', 'POST', '/v1/messages/%2e%2e/files'],
    ['a method the model API has no use for', 'DELETE', '/v1/messages'],
  ])('carries model traffic and nothing else: %s', async (_case, method, path) => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(api.url);

    expect((await ask(port, { method, path, headers: { 'x-api-key': gateway.token } })).status).toBe(404);
    expect(api.heard).toEqual([]);
  });

  it.each([['/v1/messages'], ['/v1/messages/count_tokens'], ['/v1/messages?beta=true']])('carries %s', async (path) => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(api.url);

    expect((await ask(port, { path, headers: { 'x-api-key': gateway.token } })).status).toBe(200);
    expect(api.heard[0].url).toBe(path);
  });

  it('turns away a request by any other name: a page on this host can rebind one to its loopback', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(api.url);

    expect((await ask(port, { headers: { 'x-api-key': gateway.token, host: 'evil.example.com' } })).status).toBe(403);
    expect(api.heard).toEqual([]);
  });

  it('keeps a path the upstream sits under', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(`${api.url}/anthropic/`);

    await ask(port, { headers: { 'x-api-key': gateway.token } });

    expect(api.heard[0].url).toBe('/anthropic/v1/messages');
  });

  it('says the upstream failed, and never says the key', async () => {
    const api = await upstream();
    api.server.closeAllConnections();
    await new Promise((resolve) => { api.server.close(resolve); });
    const { gateway, port } = await gatewayTo(api.url);

    const reply = await ask(port, { headers: { 'x-api-key': gateway.token } });

    expect(reply.status).toBe(502);
    expect(reply.text).not.toContain(KEY);
  });

  it('lets a request go when its client does', async () => {
    let gone = false;
    const api = await upstream((res, req) => {
      res.writeHead(200);
      res.write('first');
      req.socket.once('close', () => { gone = true; });
    });
    const { gateway, port } = await gatewayTo(api.url);

    await new Promise<void>((resolve) => {
      const sent = request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'x-api-key': gateway.token } }, (res) => {
        res.once('data', () => { sent.destroy(); resolve(); });
      });
      sent.on('error', () => undefined);
      sent.end('{}');
    });

    await vi.waitFor(() => expect(gone).toBe(true));
  });

  it('takes nothing once closed', async () => {
    const api = await upstream();
    const { gateway, port } = await gatewayTo(api.url);

    await gateway.close();

    await expect(ask(port, { headers: { 'x-api-key': gateway.token } })).rejects.toThrow();
  });
});
