import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { AgentAdapter, AgentEvent, AgentStartOptions, PlannerStartOptions } from '../harness/AgentAdapter';
import { scriptedAdapter, fakeMcpServer } from './harnessTestKit';
import { OrdewellMcpServer } from '../mcp/OrdewellMcpServer';
import type { ResearchChat } from '../BaseAiService';
import { setEnv } from '../../testEnv';

/*
 * Which research agent an OpenCode planner session is given (ADR-0066): the
 * API-key agent where the workspace names one, else the login agent on
 * OpenCode 2.x, else none. The login agent runs against the fake 2.x serve.
 */
const FAKE = resolve(__dirname, '../../../../../bench/pipeline/fake-opencode/fake-opencode-v2.mjs');
const cue = (spec: unknown) => `Research this. <fake-opencode>${JSON.stringify(spec)}</fake-opencode>`;
const AGENT_ENV = { ORDEWELL_RESEARCH_AGENT_MODEL: 'openrouter:deepseek/deepseek-v4.1-flash', OPENROUTER_API_KEY: 'sk-agent' };

let real: OrdewellMcpServer;
let scratch: string;
beforeAll(() => {
  real = new OrdewellMcpServer({ heartbeatMs: 60_000 });
  scratch = mkdtempSync(join(tmpdir(), 'oc-login-service-test-'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let restore: () => void = () => {};
beforeEach(() => { restore = setEnv({ ORDEWELL_RESEARCH_AGENT_MODEL: undefined, OPENROUTER_API_KEY: undefined }); });
afterEach(() => restore());

type Reply = { text: string; isError?: boolean };

function service({ env = {}, brief = cue({ text: 'found it' }), apiKeyAgent = true }: { env?: Record<string, string>; brief?: string; apiKeyAgent?: boolean } = {}) {
  const starts: AgentStartOptions[] = [];
  const children: ChildProcess[] = [];
  const replies: Reply[] = [];
  const apiKeyChats: number[] = [];
  const turn: AgentEvent[] = [{ type: 'assistant_text', runId: 'r1', text: 'Mapped.' }, { type: 'turn_end' }];
  const scripted = scriptedAdapter([turn, turn]);
  const fake = fakeMcpServer();
  // The research serve reaches Ordewell's tools over HTTP, so its token comes from a real server.
  const researchTokens: string[] = [];
  const mcp = Object.assign(fake, {
    researchTokens,
    issueResearchToken: async (...args: Parameters<OrdewellMcpServer['issueResearchToken']>) => {
      const credential = await real.issueResearchToken(...args);
      researchTokens.push(credential.token);
      return credential;
    },
    revoke: (token: string) => { fake.revoked.push(token); real.revoke(token); },
  });
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'opencode', orchestratorModel: 'opencode/planner-model' }), {
    createAdapter: (name, deps): AgentAdapter => {
      const adapter = scripted(name, deps)!;
      return {
        ...adapter,
        start: async (opts) => { starts.push(opts); },
        send: async (message, onEvent, signal, onLiveness) => {
          const handler = mcp.plannerHandlers.at(-1)!;
          if (handler.spawnResearchAgent) replies.push(await handler.spawnResearchAgent({ prompt: brief }, { signal: new AbortController().signal }));
          return adapter.send(message, onEvent, signal, onLiveness);
        },
      };
    },
    spawn: (command, args, options) => { const child = nodeSpawn(command, args, options); children.push(child); return child; },
    workspaceRoot: () => scratch,
    workspaceEnv: async () => ({ HOME: join(scratch, 'home'), ...env }),
    mcpServer: mcp,
    loginResearch: { command: process.execPath, args: [FAKE] },
    ...(apiKeyAgent ? {
      researchAgent: () => ({
        model: 'deepseek/deepseek-v4.1-flash',
        createChat: (): ResearchChat => {
          apiKeyChats.push(1);
          return {
            sendMessage: async () => ({ text: 'from the API-key agent', toolCalls: [], hasToolCalls: false }),
            sendToolResults: async () => ({ text: '', toolCalls: [], hasToolCalls: false }),
          };
        },
      }),
    } : {}),
  });
  const notices: string[] = [];
  const start = () => svc.startConversation({
    plannerTools: { sessionId: 's1', handler: {} },
    goal: 'Map the repo', runners: ['opencode' as const], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
    notice: (_level: string, message: string) => notices.push(message),
  });
  const prompt = () => (starts.at(-1) as PlannerStartOptions).systemPrompt;
  /** Serves only: `--version` children exit on their own. */
  const serves = () => children.filter((child) => child.spawnargs.includes('serve'));
  return { svc, start, prompt, children, serves, replies, notices, apiKeyChats, mcp };
}

const exited = (child: ChildProcess) => new Promise<void>((done) => {
  if (child.exitCode !== null || child.signalCode !== null) done(); else child.once('exit', () => done());
});

describe('the research agent an OpenCode planner session is given (ADR-0066)', () => {
  it('is the API-key agent when the workspace names its model, and no OpenCode is started for it', async () => {
    const s = service({ env: AGENT_ENV });
    try {
      await s.start();
      expect(s.prompt()).toContain('Use spawn_research_agent');
      expect(s.replies).toEqual([{ text: 'from the API-key agent' }]);
      expect(s.apiKeyChats).toHaveLength(1);
      expect(s.children).toEqual([]);
    } finally { s.svc.reset(); }
  });

  it('is the login agent on OpenCode 2.x, on the planner\'s model, with no setting at all', async () => {
    const s = service();
    try {
      await s.start();
      expect(s.mcp.plannerScopes.at(-1)).toMatchObject({ research: true });
      expect(s.prompt()).toContain('Use spawn_research_agent');
      expect(s.replies).toEqual([{ text: 'found it' }]);
      expect(s.apiKeyChats).toEqual([]);
      expect(s.serves()).toHaveLength(1);
      expect(s.notices).toEqual([]);
    } finally { s.svc.reset(); }
  });

  it('is none on OpenCode 1.x: the planner delegates with research tasks', async () => {
    const s = service({ env: { FAKE_OPENCODE_VERSION: '1.4.0' } });
    try {
      await s.start();
      expect(s.mcp.plannerHandlers.at(-1)!.spawnResearchAgent).toBeUndefined();
      expect(s.prompt()).not.toContain('spawn_research_agent');
      expect(s.prompt()).toContain('research tasks are how you delegate');
      expect(s.serves()).toEqual([]);
    } finally { s.svc.reset(); }
  });

  it.each([
    ['its serve fails to start', { FAKE_OPENCODE_EXIT: '1' }, cue({ text: 'never' }), /before it was ready/],
    ['the login cannot run the model', {}, cue({ fail: { type: 'provider.auth', message: 'no credentials for opencode' } }), /provider\.auth/],
  ])('turns unavailable, says why once, and points the planner at research tasks when %s', async (_why, env, brief, reason) => {
    const s = service({ env, brief, apiKeyAgent: false });
    try {
      await s.start();
      expect(s.replies).toHaveLength(1);
      expect(s.replies[0].isError).toBe(true);
      expect(s.replies[0].text).toMatch(/research task/);
      expect(s.notices).toHaveLength(1);
      expect(s.notices[0]).toMatch(reason);
      await Promise.all(s.serves().map(exited));
    } finally { s.svc.reset(); }
  });

  it('closes its serve when the planner session is discarded', async () => {
    const s = service();
    await s.start();
    expect(s.serves()).toHaveLength(1);
    const [serve] = s.serves();
    s.svc.reset();
    await exited(serve);
    expect(serve.exitCode !== null || serve.signalCode !== null).toBe(true);
    expect(s.mcp.researchTokens).toHaveLength(1);
    await expect.poll(() => s.mcp.revoked).toContain(s.mcp.researchTokens[0]);
  });
});
