#!/usr/bin/env node
/*
 * The rehearsal's scripted provider: an OpenRouter-shaped endpoint on the
 * box's loopback, where the planner, the built-in runner and the supervisor
 * reach it through OPENROUTER_BASE_URL. The gateway lets nothing through to a
 * private address, so the fake lives in the box rather than on the host.
 *
 *   --scenario <name>   a scenario of rehearsal.mjs
 *   --port <n>          the port (0 picks one), reported on the ready line
 *   --src, --tests      the library's source and test directories
 *   --long-sec <n>      how long the scripted long command runs
 *   --model <id>        the model the listing names
 *   --context <n>       the context window the listing states
 *   --log <file>        one JSON line per request heard and turn played
 */
import http from 'node:http';
import fs from 'node:fs';
import { createState, modelsBody, readyLine, sseBody, turnFor } from './rehearsal.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const name = arg('--scenario');
const port = Number(arg('--port', '0'));
const ctx = { src: arg('--src', 'src'), tests: arg('--tests', 'tests'), longSec: Number(arg('--long-sec', '90')) };
const model = arg('--model', 'deepseek/deepseek-v4.1-flash');
const contextLength = Number(arg('--context', '131072'));
const logFile = arg('--log', null);
const state = createState();

const heard = (line) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`); };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && /\/models(\?|$)/.test(req.url)) {
      heard({ url: req.url, method: req.method });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(modelsBody({ modelId: model, contextLength })));
      return;
    }
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
      heard({ url: req.url, method: req.method, unanswered: true });
      res.writeHead(404).end('not found');
      return;
    }
    let request;
    try { request = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    let turn;
    try {
      turn = turnFor(name, request, state, ctx);
    } catch (err) {
      heard({ error: String(err?.stack ?? err) });
      res.writeHead(500).end(String(err?.message ?? err));
      return;
    }
    heard({
      url: req.url, model: request.model, stream: request.stream, toolChoice: request.tool_choice ?? null,
      // The reasoning effort the caller asked for (OpenRouter's `reasoning` object, or `reasoning_effort` where a dialect takes that).
      reasoning: request.reasoning ?? (request.reasoning_effort ? { effort: request.reasoning_effort } : null),
      tools: (request.tools ?? []).map((t) => t.function?.name ?? t.name),
      messages: (request.messages ?? []).map((m) => ({ role: m.role, content: String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), toolCalls: m.tool_calls?.map((c) => c.function?.name) })),
      turn,
    });
    if (request.stream === false) {
      const message = turn.toolCall
        ? { role: 'assistant', content: turn.content ?? null, tool_calls: [{ id: 'call_rehearsal', type: 'function', function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) } }] }
        : { role: 'assistant', content: turn.content ?? '' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'rehearsal', object: 'chat.completion', model: request.model,
        choices: [{ index: 0, message, finish_reason: turn.toolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: turn.costUsd },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(sseBody(turn, { promptChars: body.length }));
  });
});

server.listen(port, '127.0.0.1', () => console.log(readyLine(server.address().port)));
