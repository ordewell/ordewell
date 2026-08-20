#!/usr/bin/env node
/**
 * Cheap-model simulator: a local OpenAI-compatible /chat/completions server
 * that reproduces the formatting quirks of budget models (DeepSeek V4 Flash
 * class) so the planner conversation loop can be exercised end-to-end,
 * deterministically, and offline:
 *
 *   - `reasoning` deltas streamed before any content (long think time)
 *   - plan JSON wrapped in ```json fences with a trailing comma
 *   - prose preamble before the JSON ("Here is the plan:")
 *   - questions asked as plain prose (no tags — the loop must not need them)
 *   - an eager persona that ignores grilling and commits a plan immediately
 *   - an empty-content turn (some cheap models return "" after tool use)
 *
 * Personas are selected by the requested `model` id:
 *   mock/interviewer   grilling flow: explore → question → question → outline → fenced plan
 *   mock/eager-planner ignores interviewing and emits a plan on turn one
 *   mock/fenced-json   research (2 tools) → preamble + fenced JSON plan
 *   mock/prd-flow      PRD preview → marker-wrapped PRD → outline → plan
 *   mock/empty-turn    returns an empty assistant turn after one tool call
 *   mock/visibility    one parallel round mixing allowed, refused and out-of-scope calls
 *   mock/task-query-editor  reads a task's prompt via taskQuery, then edits it
 *                       from what the answer actually contained
 *
 * Usage: node bench/live/mock-provider.mjs [--port 3799]
 */
import http from 'node:http';

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 3799);

const PLAN_JSON = (title) => JSON.stringify({
  tasks: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      order: 1,
      title,
      description: 'First slice',
      type: 'ai',
      dependencies: [],
      prompt: 'Do the first slice end to end. Touch src/index.ts.',
      assignedModel: { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash' },
      assignedRunner: 'claude-code',
      taskMode: 'acceptEdits',
      autonomy: 'AFK',
      sliceType: 'AFK',
      subtasks: [],
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      order: 2,
      title: 'Write docs',
      description: 'Document the feature',
      type: 'user',
      dependencies: ['11111111-1111-4111-8111-111111111111'],
      userSteps: [{ order: 1, instruction: 'Update README', completed: false }],
      assignedRunner: 'claude-code',
      taskMode: 'acceptEdits',
      autonomy: 'HITL',
      sliceType: 'HITL',
      subtasks: [],
    },
  ],
}, null, 2);

// Trailing comma before the closing brace — classic budget-model emission.
const FENCED_PLAN = (title) =>
  'Great — generating the plan now.\n```json\n' + PLAN_JSON(title).replace(/\n  \]\n\}$/, '\n  ],\n}') + '\n```';

function toolCallTurn(name, args) {
  return { toolCalls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, args: JSON.stringify(args) }] };
}

/** Fixed ids, so a test can assert a result landed on the call that announced it. */
function parallelToolTurn(calls) {
  return { toolCalls: calls.map(([id, name, args]) => ({ id, name, args: JSON.stringify(args) })) };
}

/** Count how many user turns arrived after the system prompt (tool msgs excluded). */
function shape(messages) {
  const users = messages.filter((m) => m.role === 'user').length;
  const lastRole = messages[messages.length - 1]?.role;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const toolRounds = messages.filter((m) => m.role === 'assistant' && m.tool_calls).length;
  return { users, lastRole, lastUser: String(lastUser), toolRounds };
}

function scriptTurn(model, messages) {
  const persona = model.split('/')[1] ?? model;
  const s = shape(messages);

  if (persona === 'eager-planner') {
    // Ignores the grilling instructions entirely — commits a plan turn one.
    return { reasoning: 'The goal seems clear enough, skipping questions. ', content: FENCED_PLAN('Eagerly planned slice') };
  }

  if (persona === 'empty-turn') {
    if (s.toolRounds === 0) return { reasoning: 'Let me look around first. ', ...toolCallTurn('list_dir', { path: '.', depth: 2 }) };
    return { content: '' };
  }

  if (persona === 'visibility') {
    if (s.toolRounds === 0) {
      return {
        reasoning: 'Reading two files at once, and trying a couple of things I probably may not do. ',
        ...parallelToolTurn([
          ['vc-1', 'read_file', { path: 'README.md' }],
          ['vc-2', 'read_file', { path: 'src/index.ts' }],
          ['vc-3', 'bash', { command: 'rm -rf build' }],
          ['vc-4', 'read_file', { path: '/etc/passwd' }],
        ]),
      };
    }
    return { content: 'Some lookups were not allowed. **Question**: how should I proceed?' };
  }

  if (persona === 'task-query-editor') {
    // A scripted stand-in for "read before you edit": it never assumes what a
    // task's prompt says, it asks (the taskQuery envelope), and only emits an
    // edit once the answer — carrying a marker the plan context block never
    // includes — has actually come back on a prior user turn.
    const seen = messages.map((m) => String(m.content ?? '')).join('\n');
    const marker = seen.match(/MARKER-[A-Z0-9]+/)?.[0];
    if (!marker) {
      return { content: JSON.stringify({ taskQuery: { tasks: ['#2'], fields: ['prompt'] } }) };
    }
    return { content: JSON.stringify({ taskOps: [{ op: 'update', taskId: '#2', changes: { description: `read-confirmed:${marker}` } }] }) };
  }

  if (persona === 'fenced-json') {
    if (s.toolRounds === 0) return { reasoning: 'I should read the README to ground the plan. ', ...toolCallTurn('read_file', { path: 'README.md' }) };
    if (s.toolRounds === 1) return { ...toolCallTurn('grep', { pattern: 'TODO', include: '*.md' }) };
    return { reasoning: 'Research done, emitting the plan. ', content: FENCED_PLAN('Fenced plan slice') };
  }

  if (persona === 'prd-flow') {
    if (s.users === 1 && s.toolRounds === 0) return { reasoning: 'Exploring before the PRD preview. ', ...toolCallTurn('list_dir', { path: '.', depth: 2 }) };
    if (s.users === 1) {
      return { content: 'Here is a short preview before the full PRD.\n\n**Problem**: the demo app lacks a widget.\n**Approach**: add a widget module.\n**Testing seams**: unit tests around widget.ts.\n**Risks**: none notable.\n\nProposed feature-slug: `demo-widget`. Do you agree with this preview?' };
    }
    if (s.users === 2) {
      return {
        content: 'Writing the full PRD now.\n\n<!-- ORDEWELL_PRD_START slug="demo-widget" -->\n# PRD: Demo Widget\n\n## Problem\nThe demo app lacks a widget.\n\n## User stories\n- As a user, I want a widget so that I can widget.\n\n## Implementation decisions\n- Add `src/widget.ts`.\n\n## Testing seams\n- Unit tests in `src/widget.test.ts`.\n\n## Out of scope\n- Widget theming.\n<!-- ORDEWELL_PRD_END -->\n\nNext, here is the outline:\n1. Add widget module (src/widget.ts)\n2. Document it\n\nConfirm to generate the task plan.',
      };
    }
    return { content: FENCED_PLAN('Add widget module') };
  }

  // default: interviewer (grilling flow)
  if (s.users === 1 && s.toolRounds === 0) {
    return { reasoning: 'Vague goal. Explore the workspace before asking anything. ', ...toolCallTurn('list_dir', { path: '.', depth: 2 }) };
  }
  if (s.users === 1) {
    return {
      reasoning: 'The repo is a tiny demo. The goal "make it better" could mean performance, UX, or code health. Ask one question with a recommendation. ',
      content: 'Looking at the repo, "make it better" could go several ways.\n\n**Question**: should I focus on code health (tests, types) or user-facing behavior?\n\nMy recommendation: code health first — the project has no tests at all.',
    };
  }
  if (s.users === 2) {
    return {
      content: '**Question**: for the test setup, do you prefer node:test (zero deps) or vitest?\n\nMy recommendation: node:test, matching the bench harness convention.',
    };
  }
  if (s.users === 3) {
    return {
      content: 'I believe we share an understanding now. Outline:\n\n1. Set up node:test and a first unit test (src/index.test.ts)\n2. Write docs\n\nReply "confirm" and I will emit the task plan.',
    };
  }
  return { reasoning: 'User confirmed. Emitting the final JSON. ', content: FENCED_PLAN('Set up node:test harness') };
}

function sseChunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
    const { model, messages } = parsed;
    const turn = scriptTurn(model ?? 'mock/interviewer', messages ?? []);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    // Stream reasoning first (in small chunks, like a real reasoning model)...
    if (turn.reasoning) {
      for (const piece of turn.reasoning.match(/.{1,12}/gs) ?? []) {
        res.write(sseChunk({ reasoning: piece }));
      }
    }
    // ...then content...
    if (turn.content) {
      for (const piece of turn.content.match(/.{1,24}/gs) ?? []) {
        res.write(sseChunk({ content: piece }));
      }
    }
    // ...then tool calls, arguments split across chunks.
    if (turn.toolCalls) {
      turn.toolCalls.forEach((tc, index) => {
        res.write(sseChunk({ tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: '' } }] }));
        for (const piece of tc.args.match(/.{1,10}/gs) ?? []) {
          res.write(sseChunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
        }
      });
    }
    res.write(sseChunk({}, turn.toolCalls ? 'tool_calls' : 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock provider listening on http://127.0.0.1:${port}/v1`);
});
