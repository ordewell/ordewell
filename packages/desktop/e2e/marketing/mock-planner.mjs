#!/usr/bin/env node
/**
 * The planner the Harbor capture talks to: bench/live/mock-provider.mjs's
 * OpenAI-compatible /chat/completions stream (reasoning, then content, then
 * tool calls, in small chunks), answering one goal with one plan. It is a copy
 * rather than a persona there, so the marketing scenario changes no other
 * suite's planner.
 *
 * The goal gets two reads of the code it touches, then the plan. A later turn,
 * the run's supervisor waking the planner, changes nothing.
 *
 * Every AI task's prompt holds the phrase its fake runner's scene is chosen by
 * (fakes/scene.mjs, SCENES), and the Copilot task names no effort: Copilot
 * takes its model at spawn and has no effort to set.
 *
 * Its /models is a small catalog in OpenRouter's shape, so the planner's
 * settings name the model it plans with rather than a discovery error.
 *
 * Usage: node mock-planner.mjs [--port 3799]
 */
import http from 'node:http';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const port = Number(arg('--port') ?? 3799);

const ai = (over) => ({ type: 'ai', autonomy: 'AFK', sliceType: 'AFK', subtasks: [], ...over });

export const HARBOR_PLAN = {
  tasks: [
    ai({
      id: 'harbor-limit', order: 1, title: 'Limit failed sign-in attempts',
      description: 'A limiter keyed by email and address, wired into POST /sign-in',
      dependencies: [],
      assignedRunner: 'claude-code', assignedModel: { modelId: 'opus', modelLabel: 'Opus', thinkingEffort: 'high' }, taskMode: 'acceptEdits',
      prompt: 'Count failed sign-ins per email and address in a limiter of its own, src/auth/rateLimit.ts, with an injected clock, and wire it into POST /sign-in (src/routes/signIn.ts) through createApp. After five failures within fifteen minutes, answer 429 { "error": "too_many_attempts" } with Retry-After until the oldest failure leaves the window. Let createApp take the numbers as an option. Run npm test.',
    }),
    ai({
      id: 'harbor-tests', order: 2, title: 'Test the limit through the route',
      description: 'Each rule of the limit, through POST /sign-in',
      dependencies: [],
      assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5.5', modelLabel: 'GPT-5.5', thinkingEffort: 'high' }, taskMode: 'agent',
      prompt: 'Cover the limit through POST /sign-in in test/signIn.test.ts: the sixth attempt after five failures answers 429 with Retry-After 900, each address counts apart, the window reopens after fifteen minutes, and a successful sign-in clears earlier failures. Move time with createApp\'s now option, never by waiting. The limiter lands in #1, so run the existing tests here; the check runs the whole suite.',
    }),
    ai({
      id: 'harbor-docs', order: 3, title: 'Document the limit for API callers',
      description: 'The 429 in the API reference, and a changelog entry',
      dependencies: [], autonomy: 'HITL', sliceType: 'HITL',
      assignedRunner: 'copilot-cli', assignedModel: { modelId: 'gpt-5.4-mini', modelLabel: 'GPT-5.4 mini' },
      prompt: 'Document the sign-in limit for the people who call the API: add the 429 to the POST /sign-in table in docs/api.md, with its Retry-After header and when the count clears, and an Unreleased entry in CHANGELOG.md. The reference is public, so ask before publishing the numbers.',
    }),
    {
      id: 'harbor-check', order: 4, title: 'Run the test suite', description: 'The check of a loop: the whole suite, once the slices land',
      type: 'script', dependencies: ['harbor-limit', 'harbor-tests', 'harbor-docs'],
      commands: [['node', '--test', '--test-reporter=spec']], sliceType: 'AFK',
      loop: { body: ['harbor-fix'], maxRounds: 3 },
    },
    ai({
      id: 'harbor-fix', order: 5, title: 'Fix what the suite reports',
      description: 'The body of the loop: runs when the check fails',
      dependencies: ['harbor-check'],
      assignedRunner: 'opencode', assignedModel: { modelId: 'opencode-go/kimi-k2.6', modelLabel: 'Kimi K2.6', thinkingEffort: 'high' }, taskMode: 'build',
      prompt: 'Make the failing sign-in tests pass. Read the check\'s report first, change the code rather than the tests, and run node --test test/signIn.test.ts before you finish.',
    }),
    ai({
      id: 'harbor-review', order: 6, title: 'Review the change before it ships',
      description: 'A read-only review of what landed',
      dependencies: ['harbor-check'],
      assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium' }, taskMode: 'plan', readOnly: true,
      prompt: 'Review the rate limiting change as it landed: the limiter, the route and the tests. Look for what behaves differently under production traffic than in the tests, and report each finding with its file and line. Change nothing.',
    }),
  ],
};

const PREAMBLE = [
  'Six tasks. The limiter, its tests and the docs run side by side on three agents. ',
  'The suite is the check of a loop: when it fails, the fix runs and the suite runs again, up to three rounds. ',
  'The docs stop at a checkpoint before the numbers go public, and a read-only review closes the run.',
].join('');

const fence = (plan) => `${PREAMBLE}\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;

function toolTurn(calls) {
  return { toolCalls: calls.map(([name, args], i) => ({ id: `call_harbor_${i + 1}`, name, args: JSON.stringify(args) })) };
}

function scriptTurn(messages) {
  const planned = messages.some((m) => m.role === 'assistant' && String(m.content ?? '').includes('"tasks"'));
  if (planned) return { content: 'Noted. Nothing to change.' };
  const explored = messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
  if (!explored) {
    return {
      reasoning: 'Sign-in lives in src/routes/signIn.ts and its tests in test/signIn.test.ts. Read both before splitting the work. ',
      ...toolTurn([['read_file', { path: 'src/routes/signIn.ts' }], ['read_file', { path: 'test/signIn.test.ts' }]]),
    };
  }
  return {
    reasoning: 'The route has no state of its own, and createApp already injects a clock, so the limiter can be its own module and the tests can move time. Tests and docs do not need the code to exist first. The suite is the natural check. ',
    content: fence(HARBOR_PLAN),
  };
}

function sseChunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: 'harbor', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** First is the model harbor.ts's ORCHESTRATOR_MODEL names, so the picker shows it by name. */
const CATALOG = [
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
  ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
  ['openai/gpt-5.5', 'GPT-5.5'],
  ['google/gemini-3.8-pro', 'Gemini 3.8 Pro'],
].map(([id, name]) => ({ id, name, context_length: 200000, supported_parameters: ['tools', 'reasoning'] }));

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.replace(/\?.*$/, '').endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: CATALOG }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const turn = scriptTurn(Array.isArray(parsed.messages) ? parsed.messages : []);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // Paced like a model that streams, so the chat fills as it would; a capture waits for the plan, not for a time.
    for (const piece of turn.reasoning?.match(/.{1,12}/gs) ?? []) {
      res.write(sseChunk({ reasoning: piece }));
      await pause(12);
    }
    for (const piece of turn.content?.match(/.{1,24}/gs) ?? []) {
      res.write(sseChunk({ content: piece }));
      await pause(4);
    }
    turn.toolCalls?.forEach((call, index) => {
      res.write(sseChunk({ tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: '' } }] }));
      for (const piece of call.args.match(/.{1,10}/gs) ?? []) res.write(sseChunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
    });
    res.write(sseChunk({}, turn.toolCalls ? 'tool_calls' : 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${port}/v1`);
});
