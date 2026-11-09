/**
 * The budget block each planner turn carried ("CONTEXT AND BUDGETS (this
 * turn):", packages/core/src/services/PlannerBudgets.ts), recorded from the
 * outside: Ordewell keeps a turn's input nowhere, so a session file cannot say
 * whether V2's read meter reached the planner. Two places see the input:
 *   - an API planner's requests, through a local proxy on OPENROUTER_BASE_URL;
 *   - Claude Code's own transcript of the session, under its config directory.
 * OpenCode keeps its turns in a store of its own, and Codex and the ACP
 * runners get no meter line at all, so those runs record none.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const HEADER = 'CONTEXT AND BUDGETS (this turn):';
const METER = /^- Your own reads: about .*$/m;

/** The runners whose turn input carries the meter line when it is on (CliAgentAiService.reportsOwnReads; an API planner always). */
export const reportsOwnReads = (cell) => ['claude-code', 'opencode', 'openrouter'].includes(cell.provider);

/** Where this bench can read a cell's turn input, or null where it cannot. */
export const budgetSource = (cell) => (cell.provider === 'openrouter' ? 'proxy' : cell.provider === 'claude-code' ? 'transcript' : null);

/** The budget block in one turn's input: its header and the `- ` lines under it. */
export function blockOf(text) {
  const at = String(text ?? '').lastIndexOf(HEADER);
  if (at < 0) return null;
  const lines = [HEADER];
  for (const line of String(text).slice(at + HEADER.length).split('\n').slice(1)) {
    if (!line.startsWith('- ')) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * What a run records: each turn input that carried a block, in order, with
 * its meter line. `expected` is whether the variant turned the meter on for a
 * runner that reports one, so the report can tell a missing line from a
 * control that never gets one.
 */
export function budgetRecord(inputs, { source, expected }) {
  const turns = inputs.map(blockOf).filter(Boolean).map((block) => ({ block, meter: METER.exec(block)?.[0].slice(2) ?? null }));
  return { source, expected, turns };
}

/** Claude Code's transcript directory for a working directory: every character but a letter or digit becomes `-`. */
export function claudeTranscriptDir(workspace, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', path.resolve(workspace).replace(/[^A-Za-z0-9]/g, '-'));
}

const textParts = (content) => (typeof content === 'string'
  ? [content]
  : Array.isArray(content) ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text) : []);

/** The user turns Claude Code saved for a working directory, oldest first; a subagent's (a sidechain) are not the planner's. */
export function claudeTurnInputs(dir) {
  if (!fs.existsSync(dir)) return [];
  const turns = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'user' || entry.isSidechain || entry.message?.role !== 'user') continue;
      const text = textParts(entry.message.content).join('\n');
      if (text) turns.push({ at: String(entry.timestamp ?? ''), text });
    }
  }
  return turns.sort((a, b) => a.at.localeCompare(b.at)).map((t) => t.text);
}

/**
 * A pass-through proxy to an OpenAI-compatible `upstream` that keeps every
 * user message the planner sent. Each request repeats the conversation so
 * far, so a message is kept once, by its place in the conversation.
 */
export async function startRecorder(upstream) {
  const seen = new Map();
  const base = upstream.replace(/\/+$/, '');
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      try {
        const messages = JSON.parse(body.toString('utf8'))?.messages;
        if (Array.isArray(messages)) {
          messages.forEach((m, i) => {
            if (m?.role === 'user') seen.set(i, textParts(m.content).join('\n'));
          });
        }
      } catch {
        // Not JSON: a models listing or a probe, with no turn in it.
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k)));
      const reply = await fetch(`${base}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      // fetch has already decoded the body, so the encoding and length it came with no longer describe it.
      const out = Object.fromEntries([...reply.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)));
      res.writeHead(reply.status, out);
      if (reply.body) Readable.fromWeb(reply.body).pipe(res);
      else res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(error?.message ?? error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    inputs: () => [...seen.entries()].sort(([a], [b]) => a - b).map(([, text]) => text),
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
