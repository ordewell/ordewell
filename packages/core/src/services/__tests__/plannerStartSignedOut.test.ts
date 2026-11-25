import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { CONNECTORS } from '../harness/connectors';
import { RunnerSignedOutError } from '../signInHint';
import { RunnerInstallation } from '../RunnerInstallation';
import { plannerNotReadyFor } from '../plannerReadiness';
import { recordedRunnerAuth, recordedRunnerEvidence, resetRunnerAuth } from '../runnerAuth';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';
import { OrdewellMcpServer } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';
import { fakeConfig, fakeFileSystem } from '../../testing';

/**
 * #49 F2: Cursor refuses `session/new` with ACP's auth-required error while
 * the planner starts, so the failure is the adapter's start, never a turn's
 * words. The refusal is a typed error and is recorded for the workspace the
 * first time, so the next send is refused before anything is spawned, even
 * after the runner list refreshes.
 */

/** Cursor CLI 2026.10.22's answers, as `fixtures/acp/cursor-agent/signed-out.jsonl` recorded them. */
const SIGNED_OUT: FakeAcpStep[] = [
  {
    expect: 'initialize',
    reply: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
      authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
    },
  },
  {
    expect: 'session/new',
    error: { code: -32000, message: 'Authentication required', data: { message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'." } },
  },
];

const servers: OrdewellMcpServer[] = [];
const workspaces: string[] = [];
beforeEach(() => resetRunnerAuth());
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cursorPlanner() {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-signed-out-')));
  workspaces.push(workspace);
  const agent = fakeAcpSpawn(SIGNED_OUT);
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'cursor-agent' }), {
    spawn: agent.spawn,
    createAdapter: (_runner, deps) => CONNECTORS['cursor-agent'].create(deps),
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
    workspaceRoot: () => workspace,
    mcpServer: server,
  });
  return { svc, workspace, agent };
}

describe('a planner whose agent refuses its session as signed out (#49 F2)', () => {
  it('throws the shared signed-out error and records the blocker for its workspace, which a refresh keeps', async () => {
    const { svc, workspace } = cursorPlanner();

    const started = svc.startConversation({
      goal: 'Add a cache layer',
      runners: ['cursor-agent'],
      modelsByRunner: { 'cursor-agent': [] },
      fs: fakeFileSystem(),
      onProgress: () => {},
      plannerTools: { sessionId: 's1', handler: {} },
    });

    await expect(started).rejects.toBeInstanceOf(RunnerSignedOutError);
    await expect(started).rejects.toHaveProperty('message', 'Cursor is not signed in. Sign in with /login cursor-agent, or run cursor-agent login.');
    expect(recordedRunnerEvidence('cursor-agent', workspace)).toMatchObject({ source: 'turn', auth: { state: 'signed-out', signIn: { runner: 'cursor-agent', login: ['cursor-agent', 'login'] } } });

    // The list every surface loads after the turn asks again, and must keep it.
    const registry = { getManifest: (id: string) => (id === 'cursor-agent' ? CURSOR_AGENT_MANIFEST : undefined) } as unknown as RunnerRegistry;
    const installation = new RunnerInstallation(registry, async () => ({ stdout: '2026.10.22' }), Date.now, { launch: { platform: 'linux' }, workspace: () => workspace });
    installation.refresh();
    expect((await installation.runnerUsability('cursor-agent')).auth?.state).toBe('signed-out');
    expect(plannerNotReadyFor(fakeConfig({ aiProvider: 'cursor-agent' }), (runner) => recordedRunnerAuth(runner, workspace))).toMatchObject({ code: 'signed_out', runner: 'cursor-agent' });
  });
});
