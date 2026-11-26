import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerInstallation } from '../RunnerInstallation';
import { ModelResolver } from '../ModelResolver';
import type { AcpClientImpl, ExecImpl } from '../ModelDiscovery';
import type { AcpModelsAnswer } from '../harness/acpModels';
import { recheckRunnerSignIn, runnerReadiness, verifyRunnerSignIn } from '../runnerReadiness';
import { plannerNotReadyFor } from '../plannerReadiness';
import { recordedRunnerAuth, recordRunnerAuth, resetRunnerAuth, signedOutFromFailure, type RunnerAuthExec } from '../runnerAuth';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerManifest } from '../../plugins/types';
import { CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { fakeConfig } from '../../testing';

/**
 * The shared readiness contract (#46, #52): what a refused turn records is
 * read the same by the runner list, the planner gate and the catalog; a
 * periodic refresh keeps it, and only the user's recovery (a recheck, a
 * finished login) or current evidence replaces it.
 */

const WS = '/w';
const registry = (...manifests: RunnerManifest[]) => ({ getManifest: (id: string) => manifests.find((m) => m.name === id) }) as unknown as RunnerRegistry;
const exec: ExecImpl = vi.fn(async () => ({ stdout: '2026.10.22' }));

function cursorHost(answers: AcpModelsAnswer[]) {
  const client: AcpClientImpl = vi.fn(async () => answers.shift() ?? null);
  const installation = new RunnerInstallation(registry(CURSOR_AGENT_MANIFEST), exec, Date.now, { launch: { platform: 'linux' }, workspace: () => WS });
  const resolver = new ModelResolver(registry(CURSOR_AGENT_MANIFEST), fakeConfig(), { env: async () => ({}), acpClient: client, workspace: () => WS, execImpl: exec });
  return { client, installation, resolver };
}

const refuse = () => recordRunnerAuth('cursor-agent', signedOutFromFailure(CURSOR_AGENT_MANIFEST, 'Authentication required')!, WS);
const gate = () => plannerNotReadyFor(fakeConfig({ aiProvider: 'cursor-agent' }), (runner) => recordedRunnerAuth(runner, WS))?.code ?? null;

beforeEach(() => resetRunnerAuth());

describe('verifyRunnerSignIn, before a send to a signed-out planner', () => {
  it('asks a status-less ACP agent through its own handshake: still refused keeps the blocker', async () => {
    const { client, installation, resolver } = cursorHost(['signed-out']);
    refuse();

    expect((await verifyRunnerSignIn('cursor-agent', { installation, resolver })).auth?.state).toBe('signed-out');
    expect(client).toHaveBeenCalledTimes(1);
    expect(gate()).toBe('signed_out');
  });

  it('lets the send through once the agent opens a session: the user signed in elsewhere', async () => {
    const { installation, resolver } = cursorHost([[{ modelId: 'auto', modelLabel: 'Auto', variants: [] }]]);
    refuse();

    expect((await verifyRunnerSignIn('cursor-agent', { installation, resolver })).auth?.state).toBe('signed-in');
    expect(gate()).toBeNull();
  });

  it('keeps the blocker when the handshake gets no answer: no evidence is no recovery', async () => {
    const { installation, resolver } = cursorHost([null]);
    refuse();

    expect((await verifyRunnerSignIn('cursor-agent', { installation, resolver })).auth?.state).toBe('signed-out');
  });

  it('asks a runner with a status command that command, and spawns no handshake', async () => {
    const authExec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{"authMethod":"claude.ai"}', stderr: '' }));
    const installation = new RunnerInstallation(registry(CLAUDE_CODE_MANIFEST), exec, Date.now, { authExec, launch: { platform: 'linux' }, workspace: () => WS });
    const resolver = { rediscoverRunner: vi.fn() };
    recordRunnerAuth('claude-code', signedOutFromFailure(CLAUDE_CODE_MANIFEST, 'Not logged in · Please run /login')!, WS);

    expect((await verifyRunnerSignIn('claude-code', { installation, resolver })).auth?.state).toBe('signed-in');
    expect(resolver.rediscoverRunner).not.toHaveBeenCalled();
  });
});

describe('recheckRunnerSignIn, the user\'s explicit recovery', () => {
  it('returns to an honest unknown when the handshake cannot say, never signed in, and allows a new send', async () => {
    const { installation, resolver } = cursorHost([null]);
    refuse();

    const after = await recheckRunnerSignIn('cursor-agent', { installation, resolver });

    expect(after.auth?.state).toBe('unknown');
    expect(gate()).toBeNull();
    // A new refusal restores the blocker, and a periodic refresh keeps it.
    refuse();
    installation.refresh();
    expect((await installation.runnerUsability('cursor-agent')).auth?.state).toBe('signed-out');
    expect(gate()).toBe('signed_out');
  });

  it('restores the blocker at once when the agent still refuses', async () => {
    const { installation, resolver } = cursorHost(['signed-out']);
    refuse();

    expect((await recheckRunnerSignIn('cursor-agent', { installation, resolver })).auth?.state).toBe('signed-out');
    expect(gate()).toBe('signed_out');
  });

  it('confirms a sign-in the agent proves by opening a session, still offering its login', async () => {
    const { installation, resolver } = cursorHost([[]]);
    refuse();

    expect((await recheckRunnerSignIn('cursor-agent', { installation, resolver })).auth).toMatchObject({
      state: 'signed-in', loginCommand: ['cursor-agent', 'login'], signIn: { runner: 'cursor-agent' },
    });
  });
});

describe('runnerReadiness, the typed state a picker or catalog reads', () => {
  const signIn = { runner: 'cursor-agent', label: 'Cursor', login: ['cursor-agent', 'login'] };
  it.each([
    [{ usable: false, reason: 'cursor-agent is not installed or is not on PATH.' }, undefined, { kind: 'unusable', reason: 'cursor-agent is not installed or is not on PATH.' }],
    [{ usable: true, auth: { state: 'signed-out' as const, signIn } }, 'signed-out' as const, { kind: 'blocked', why: 'signed-out', signIn }],
    [{ usable: true, auth: { state: 'signed-out' as const, signIn, detail: 'no provider key' } }, 'no-credential' as const, { kind: 'blocked', why: 'no-credential', signIn: { ...signIn, needsKey: true } }],
    [{ usable: true, auth: { state: 'unknown' as const } }, 'pending' as const, { kind: 'pending' }],
    [{ usable: true, auth: { state: 'unknown' as const } }, 'no-answer' as const, { kind: 'discovery-failed' }],
    [{ usable: true, auth: { state: 'signed-in' as const } }, 'no-choice' as const, { kind: 'agent-default' }],
    [{ usable: true, auth: { state: 'unknown' as const } }, undefined, { kind: 'sign-in-unknown' }],
    [{ usable: true, auth: { state: 'signed-in' as const } }, undefined, { kind: 'ready' }],
  ])('%j with discovery %s reads %j', (usability, unlisted, expected) => {
    expect(runnerReadiness(usability, unlisted)).toEqual(expected);
  });
});
