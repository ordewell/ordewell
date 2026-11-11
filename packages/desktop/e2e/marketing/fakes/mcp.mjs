/**
 * The Ordewell MCP client the Harbor fakes share, as bench/pipeline's fakes
 * speak it: Streamable HTTP, a fresh initialize per call, and an answer read
 * from JSON or from the SSE `data:` lines the server may send instead.
 */
const MCP_PROTOCOL_VERSION = '2025-06-18';

async function post(server, body, extraHeaders = {}) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...server.headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ordewell MCP server answered ${res.status}: ${text}`);
  if (body.id === undefined) return null;
  const payloads = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const answer = payloads.find((payload) => payload.id === body.id);
  if (!answer) throw new Error(`no answer to ${body.method} in: ${text}`);
  if (answer.error) throw new Error(`${body.method} failed: ${answer.error.message}`);
  return answer.result;
}

async function open(server, client) {
  const init = await post(server, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: client, version: '1' } },
  });
  const headers = { 'mcp-protocol-version': init?.protocolVersion ?? MCP_PROTOCOL_VERSION };
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  return headers;
}

/** The first contact a harness makes while it opens a session, which Ordewell reads as the server attached. */
export async function contact(server, client) {
  const headers = await open(server, client);
  await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers);
}

/** One Ordewell tool call: `{ text, isError }`. A checkpoint's call returns only once the user has answered. */
export async function callTool(server, client, name, args) {
  const headers = await open(server, client);
  const result = await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, headers);
  return { text: (result?.content ?? []).map((part) => part.text ?? '').join('\n'), isError: result?.isError === true };
}
