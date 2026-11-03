import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createSession, createTask, LeaseHost, LEASE_STALE_MS, RunnerRegistry, BufferedTaskOutputSource, RUN_SETTINGS_DEFAULTS, saveSession, saveState, loadSession } from '@ordewell/core';
import type { IAiService, IRunner, LegacyPlanState, ModelResolver, Session } from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { HostToWebview } from '@ordewell/ui/protocol';
import { restoreState, saveCurrentSession, type PersistenceDeps } from '../StatePersistence';

const SESSION = 'session-shared';

function plan(): LegacyPlanState {
  const at = '2026-10-24T01:00:00.000Z';
  return {
    tasks: [createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: at,
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: at,
    conversationHistory: [{ role: 'user', content: 'build me a parser', timestamp: at }],
  };
}

function sessionIn(workspace: string, leaseHost: LeaseHost): Session {
  return createSession({
    config: fakeConfig(),
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
    runner: { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner,
    registry: new RunnerRegistry(),
    workspaceRoot: () => workspace,
    fsAdapter: fakeFileSystem({ getWorkspaceRoot: () => workspace }),
    broadcast: () => {},
    modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    aiService: { reset: () => {}, hasActiveConversation: () => false } as unknown as IAiService,
    taskOutput: new BufferedTaskOutputSource(),
    saveSession,
    leaseHost,
  });
}

/** A VS Code window reopening on a session a TUI's daemon is running in the same checkout (ADR-0049). */
describe('VS Code and a session another host holds', () => {
  let workspace: string;
  const hosts: LeaseHost[] = [];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-lease-'));
    saveSession(plan(), 'build me a parser', workspace, SESSION);
    // The window's restore snapshot names the session, as after a reload.
    saveState(plan(), workspace, SESSION);
    const daemon = new LeaseHost({ id: 'daemon', pid: 76279, alive: () => true, kind: () => ({ kind: 'daemon', port: 49558, ownerPid: 76271 }) });
    hosts.push(daemon);
    const held = sessionIn(workspace, daemon);
    const saved = loadSession(SESSION, workspace)!;
    held.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: SESSION });
  });

  afterEach(() => {
    for (const host of hosts.splice(0)) host.releaseAll();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function window() {
    const vscodeHost = new LeaseHost({ id: 'vscode', alive: () => true, kind: () => ({ kind: 'vscode' }) });
    hosts.push(vscodeHost);
    const session = sessionIn(workspace, vscodeHost);
    const posts: HostToWebview[] = [];
    const chatProvider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
    chatProvider.postMessage = (msg) => { posts.push(msg); };
    let current: LegacyPlanState = { ...plan(), tasks: [] };
    const warn = vi.fn();
    const deps: PersistenceDeps = {
      session,
      chatProvider,
      getCurrentPlan: () => current,
      setCurrentPlan: (p) => { current = p; },
      getCurrentGoal: () => 'build me a parser',
      setCurrentGoal: () => {},
      workspaceRoot: () => workspace,
      log: () => {},
      warn,
    };
    return { session, deps, posts, warn, current: () => current };
  }

  it('says who holds it on restore, and shows no plan this window cannot run', () => {
    const w = window();

    restoreState(w.deps);

    expect(w.warn).toHaveBeenCalledTimes(1);
    expect(w.warn.mock.calls[0][0]).toContain('a TUI (pid 76271), through its daemon on port 49558 (pid 76279)');
    expect(w.session.planState).toBeNull();
    expect(w.current().tasks).toEqual([]);
    expect(w.posts.some((m) => m.type === 'planUpdated')).toBe(false);
  });

  it('saves nothing over the session once another host has taken it from this window', () => {
    // The daemon lets go; this window opens the session, then sleeps past the
    // stale age, and a daemon that judged it gone takes the session over.
    for (const host of hosts.splice(0)) host.releaseAll();
    const start = Date.now();
    const vscodeHost = new LeaseHost({ id: 'vscode', now: () => start, kind: () => ({ kind: 'vscode' }) });
    const later = new LeaseHost({ id: 'daemon-2', pid: 80001, alive: () => true, now: () => start + LEASE_STALE_MS + 1 });
    hosts.push(vscodeHost, later);
    const session = sessionIn(workspace, vscodeHost);
    const opened = loadSession(SESSION, workspace)!;
    session.loadPlan(opened.plan, opened.meta.goal, workspace, { sessionId: SESSION });
    sessionIn(workspace, later).loadPlan(loadSession(SESSION, workspace)!.plan, opened.meta.goal, workspace, { sessionId: SESSION });
    const file = path.join(workspace, '.ordewell', 'sessions', fs.readdirSync(path.join(workspace, '.ordewell', 'sessions')).find((f) => f.endsWith('.json'))!);
    const before = fs.readFileSync(file, 'utf8');
    let current: LegacyPlanState = { ...plan(), tasks: [createTask({ id: 'x', order: 1, title: 'Not this window\'s', prompt: 'p', assignedRunner: 'claude-code' })] };

    const unsaved = saveCurrentSession({ ...window().deps, session, getCurrentPlan: () => current, setCurrentPlan: (p) => { current = p; } });

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // Said back, so Save Session does not report a save that never happened.
    expect(unsaved).toMatch(/another Ordewell host/);
  });
});
