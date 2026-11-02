#!/usr/bin/env node
/*
 * What the real Claude Code binary talks to in a test: Anthropic's token endpoint
 * and Messages API on one TLS listener, reached only through a CONNECT proxy of
 * its own, so a client that went around the proxy reaches nothing. Each refresh
 * token works once, as user reports say Anthropic's do; no account, no real token
 * and no network beyond the container are involved.
 *
 *   FAKE_PROVIDER_KEY, FAKE_PROVIDER_CERT  the TLS pair, for the names asked for
 *   FAKE_PROVIDER_ALLOW                    the hosts the proxy opens, comma-separated
 *
 * The proxy listens on 3128. One JSON line on stdout per thing heard, for the test
 * to read back with `docker logs`.
 */
import { createServer as createPlainServer } from 'http';
import { createServer as createTlsServer } from 'https';
import { connect } from 'net';
import { readFileSync } from 'fs';

const LISTENER = 8443;
const PROXY = 3128;
const allowed = new Set(process.env.FAKE_PROVIDER_ALLOW.split(','));

const spent = new Set();
const live = new Set();
let issued = 0;

const heard = (line) => console.log(JSON.stringify(line));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function refresh(res, token) {
  if (!token?.startsWith('refresh-') || spent.has(token)) return json(res, 400, { error: 'invalid_grant', error_description: 'That refresh token has been used.' });
  spent.add(token);
  issued += 1;
  live.add(`access-${issued}`);
  return json(res, 200, { access_token: `access-${issued}`, refresh_token: `refresh-issued-${issued}`, expires_in: 28800, scope: 'user:inference user:profile', token_type: 'bearer' });
}

const toolUse = (id, name, input) => [
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
  event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }),
].join('');

const text = (words) => [
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } }),
  event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
].join('');

/** With Ordewell's tools it writes a file and completes the task; with none, it answers. */
function reply(asked) {
  const complete = (asked.tools ?? []).map(({ name }) => name).find((name) => name.endsWith('task_complete'));
  const said = JSON.stringify(asked.messages ?? []);
  if (!complete) return text('answered');
  if (!said.includes('from-the-model.txt')) return toolUse('toolu_write', 'Write', { file_path: '/task/work/from-the-model.txt', content: 'written on a sign-in\n' });
  if (!said.includes('toolu_done')) return toolUse('toolu_done', complete, { status: 'done', summary: 'Wrote it on a sign-in.', commit: { subject: 'Write a file' } });
  return text('Done.');
}

function messages(req, res, asked) {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  if (bearer?.startsWith('access-') && !live.has(bearer)) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'That token has been replaced.' } });
  if (req.url.includes('count_tokens')) return json(res, 200, { input_tokens: 10 });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  return res.end(event('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: asked.model ?? 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) + reply(asked) + event('message_stop', { type: 'message_stop' }));
}

createTlsServer({ key: readFileSync(process.env.FAKE_PROVIDER_KEY), cert: readFileSync(process.env.FAKE_PROVIDER_CERT) }, (req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const asked = body ? JSON.parse(body) : {};
    heard({ at: 'provider', method: req.method, host: req.headers.host, url: req.url, authorization: req.headers.authorization, key: req.headers['x-api-key'], grant: asked.grant_type, refresh: asked.refresh_token });
    if (req.url.startsWith('/v1/oauth/token')) return refresh(res, asked.refresh_token);
    if (req.url.startsWith('/v1/messages')) return messages(req, res, asked);
    return json(res, 404, {});
  });
}).listen(LISTENER);

const proxy = createPlainServer((req, res) => { res.writeHead(405); res.end(); });
proxy.on('connect', (req, client, head) => {
  const [host, port] = (req.url ?? '').split(':');
  const opened = allowed.has(host) && port === '443';
  heard({ at: 'proxy', host, opened });
  if (!opened) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const upstream = connect(LISTENER, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
proxy.listen(PROXY, () => heard({ at: 'proxy', listening: true }));
