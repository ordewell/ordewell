#!/usr/bin/env node
/**
 * Visual harness for the Ordewell VS Code chat webview.
 *
 * Serves the built webview bundle (packages/vscode/dist/webviews) with a
 * mocked `acquireVsCodeApi`, and exposes `window.__replay(events, delayMs)`
 * so a browser (or Playwright) can replay a scripted extension→webview event
 * stream and watch the UI behave exactly as it would inside VS Code:
 * sequential top-to-bottom rendering, thinking dropdowns streaming open,
 * task cards on plan commit.
 *
 * Usage:
 *   npm run build -w packages/vscode          # build the bundle first
 *   node bench/live/webview-harness.mjs        # serves on http://127.0.0.1:3798
 *
 * Then open the page, or drive it with Playwright (see
 * bench/live/webview-screenshot.mjs). A default demo scenario is available
 * via `window.__replayDemo()`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '../../packages/vscode/dist/webviews');
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 3798);

const DEMO_SCENARIO = [
  { type: 'setConfiguredProviders', providers: ['openrouter'] },
  { type: 'setRunnerList', runnerList: [{ id: 'claude-code', displayName: 'Claude Code' }] },
  { type: 'setEnabledRunnerIds', enabledRunnerIds: ['claude-code'] },
  { type: 'setSkillToggles', toggles: { 'grilling': true, tdd: true, prd: false } },
  { user: 'make this project better' },
  { type: 'researchProgress', progress: { type: 'thinking', text: 'The goal is vague. Let me explore the workspace before asking anything. ' } },
  { type: 'researchProgress', progress: { type: 'thinking', text: 'I will list the directory tree first, then read the README.' } },
  // Non-reasoning models narrate between tool calls as plain content tokens;
  // the webview must fold this prose into the thinking trace IN PLACE so
  // commands and thinking stay interleaved in execution order.
  { type: 'streamToken', token: 'Let me inspect the repository structure first.' },
  { type: 'researchProgress', progress: { type: 'tool_call', tool: 'list_dir', toolArgs: '{"path":".","depth":2}' } },
  { type: 'researchProgress', progress: { type: 'tool_result', step: { id: 's1', tool: 'list_dir', args: '{"path":"."}', result: 'src/\nREADME.md', timestamp: '' } } },
  { type: 'streamToken', token: 'Now the README to see what the project claims to do.' },
  { type: 'researchProgress', progress: { type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"README.md"}' } },
  { type: 'researchProgress', progress: { type: 'tool_result', step: { id: 's2', tool: 'read_file', args: '{"path":"README.md"}', result: '# Demo', timestamp: '' } } },
  { type: 'researchProgress', progress: { type: 'thinking', text: ' The repo has no tests. I should ask whether code health or features matter more.' } },
  { type: 'researchProgress', progress: { type: 'plan_token', planToken: 'Looking at the repo, "make it better" could go several ways.\n\n**Question**: ' } },
  { type: 'researchProgress', progress: { type: 'plan_token', planToken: 'should I focus on code health (tests, types) or user-facing behavior?\n\nMy recommendation: code health — the project has no tests.' } },
  { type: 'newMessage', message: { role: 'assistant', content: 'Looking at the repo, "make it better" could go several ways.\n\n**Question**: should I focus on code health (tests, types) or user-facing behavior?\n\nMy recommendation: code health — the project has no tests.', timestamp: new Date().toISOString() } },
  { user: 'code health please' },
  { type: 'researchProgress', progress: { type: 'thinking', text: 'They chose code health. Next design branch: which test framework.' } },
  { type: 'newMessage', message: { role: 'assistant', content: '**Question**: for the test setup, do you prefer node:test (zero deps) or vitest?\n\nMy recommendation: node:test, matching the bench harness convention.', timestamp: new Date().toISOString() } },
  { user: 'node:test please' },
  { type: 'researchProgress', progress: { type: 'thinking', text: 'Both branches resolved. The interview is complete — time to outline.' } },
  { type: 'newMessage', message: { role: 'assistant', content: 'Outline:\n\n1. Set up node:test and a first unit test (src/index.test.ts)\n2. Write docs\n\nReply "confirm" and I will emit the task plan.', timestamp: new Date().toISOString() } },
  { user: 'confirm' },
  { type: 'researchProgress', progress: { type: 'thinking', text: 'Emitting the final JSON now.' } },
  {
    type: 'planUpdated',
    plan: {
      tasks: [
        { id: 't1', order: 1, title: 'Set up node:test harness', description: 'First slice', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm1', taskMode: 'acceptEdits', assignedModel: { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash' } },
        { id: 't2', order: 2, title: 'Write docs', description: 'Document it', type: 'user', status: 'pending', dependencies: ['t1'], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'm2', taskMode: 'acceptEdits', userSteps: [{ order: 1, instruction: 'Update README', completed: false }] },
      ],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    },
  },
];

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/chat.css">
<title>Ordewell webview harness</title>
<style>
  body { max-width: 480px; margin: 0 auto; border-left: 1px solid #333; border-right: 1px solid #333; }
</style>
</head>
<body>
<div id="root"></div>
<script>
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => { window.__posted.push(m); },
    getState: () => undefined,
    setState: () => {},
  });
  window.__send = (msg) => window.dispatchEvent(new MessageEvent('message', { data: msg }));
  window.__typeUser = (text) => {
    const ta = document.querySelector('.chat-input-row textarea');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  window.__replay = async (events, delayMs = 120) => {
    for (const ev of events) {
      if (ev.user) window.__typeUser(ev.user);
      else window.__send(ev);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  };
  window.__demo = ${JSON.stringify(DEMO_SCENARIO)};
  window.__replayDemo = (delayMs) => window.__replay(window.__demo, delayMs);
</script>
<script type="module" src="/chat.js"></script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    return;
  }
  const file = path.join(dist, url.replace(/^\//, ''));
  if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`webview harness on http://127.0.0.1:${port}/ (bundle: ${dist})`);
});
