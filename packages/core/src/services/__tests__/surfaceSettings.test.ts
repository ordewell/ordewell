import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { LeaseHost } from '../sessionLease';
import type { LeaseHostKind } from '../../utils/leaseRecord';
import { fakeConfig, makeSession } from './sessionTestKit';
import { heldPlanner, NOW, prose, settled, until } from './supervisorTestKit';

/**
 * The planner is told where its user is and how the run is set, in a block
 * of its turn rather than its system prompt, so it names the controls the
 * user has and never asks for a merge that happens by itself (ADR-0030).
 */

const HEADER = 'SURFACE AND SETTINGS:';
const workspaces: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function planning(options: { run?: Partial<GlobalRunSettings>; host?: LeaseHostKind; parallel?: number } = {}) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-surface-')));
  workspaces.push(workspace);
  const leaseHost = new LeaseHost();
  leaseHost.describe(options.host ?? { kind: 'daemon', port: 3742, ownerPid: 4242 });
  const planner = heldPlanner();
  let run: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', ...options.run };
  const session = makeSession({
    config: fakeConfig({ maxParallelSessions: options.parallel ?? 3 }),
    aiService: planner.aiService,
    settings: () => ({ run: { ...run } }),
    leaseHost,
    workspaceRoot: () => workspace,
  });
  return {
    session,
    planner,
    setRun: (over: Partial<GlobalRunSettings>) => { run = { ...run, ...over }; },
    sent: (i: number) => planner.calls[i].message,
    cleanup: () => { session.destroy(); leaseHost.releaseAll(); },
  };
}

type Env = ReturnType<typeof planning>;

async function opened(env: Env): Promise<void> {
  const started = env.session.startPlanning('build it', ['claude-code']);
  await until(() => env.planner.calls.length === 1);
  env.planner.calls[0].finish(prose('Which database?'));
  await started;
  await settled();
}

async function reply(env: Env, text: string): Promise<string> {
  const at = env.planner.calls.length;
  const replied = env.session.continueConversation(text);
  await until(() => env.planner.calls.length === at + 1);
  env.planner.calls[at].finish(prose('Noted.'));
  await replied;
  await settled();
  return env.sent(at);
}

describe('the SURFACE AND SETTINGS block', () => {
  it('reaches the first turn of a conversation, naming the terminal UI\'s controls', async () => {
    const env = planning({ parallel: 3 });
    try {
      await opened(env);
      const first = env.sent(0);
      expect(first).toContain(HEADER);
      expect(first).toContain('The user is on the terminal UI');
      expect(first).toContain('Merge the run\'s landed work: /merge');
      expect(first).toContain('Parallel limit: 3 tasks at once.');
    } finally {
      env.cleanup();
    }
  });

  it('is not sent again in a turn where nothing it states has changed', async () => {
    const env = planning();
    try {
      await opened(env);
      expect(await reply(env, 'Postgres')).not.toContain(HEADER);
    } finally {
      env.cleanup();
    }
  });

  it('is sent again, as it now stands, in the turn after a setting changes', async () => {
    const env = planning({ run: { mergeAtGatesAutomatically: false, supervisorLevel: 'off' } });
    try {
      await opened(env);
      expect(env.sent(0)).toContain('Supervisor: Off.');
      env.setRun({ supervisorLevel: 'watch' });
      env.session.applyRunSettings({ supervisorLevel: 'watch' });
      const next = await reply(env, 'Postgres');
      expect(next).toContain(HEADER);
      expect(next).toContain('Supervisor: Watch.');
    } finally {
      env.cleanup();
    }
  });

  it('tells a planner with automatic merging on that merges happen by themselves', async () => {
    const env = planning({ run: { mergeAtGatesAutomatically: true } });
    try {
      await opened(env);
      expect(env.sent(0)).toContain('Automatic merging: on. Merges at merge gates and at the end of a run happen by themselves, so never ask the user to merge.');
    } finally {
      env.cleanup();
    }
  });

  it('tells a planner with automatic merging off that landed work waits for the user\'s merge', async () => {
    const env = planning({ run: { mergeAtGatesAutomatically: false } });
    try {
      await opened(env);
      expect(env.sent(0)).toContain('Automatic merging: off. Landed work waits for the user\'s merge (/merge).');
    } finally {
      env.cleanup();
    }
  });

  it('names the controls of the surface the lease\'s host serves', async () => {
    const env = planning({ host: { kind: 'vscode' } });
    try {
      await opened(env);
      expect(env.sent(0)).toContain('The user is on VS Code.');
      expect(env.sent(0)).toContain('Merge the run\'s landed work: the Merge all button');
    } finally {
      env.cleanup();
    }
  });

  it('is sent again once a compaction may have taken it out of the live context', async () => {
    const env = planning();
    let compactions = 0;
    Object.assign(env.planner.aiService, { compactions: () => compactions });
    try {
      await opened(env);
      compactions = 1;
      expect(await reply(env, 'Postgres')).toContain(HEADER);
      expect(await reply(env, 'and Redis')).not.toContain(HEADER);
    } finally {
      env.cleanup();
    }
  });

  it('reaches a new live context opened from the transcript', async () => {
    const env = planning();
    try {
      await opened(env);
      env.planner.state.live = false;
      expect(await reply(env, 'Postgres')).toContain(HEADER);
    } finally {
      env.cleanup();
    }
  });

  it('stays out of the system prompt', async () => {
    const env = planning();
    try {
      await opened(env);
      const [request] = env.planner.aiService.startConversation.mock.calls[0];
      expect(JSON.stringify({ ...request, initialMessage: undefined })).not.toContain(HEADER);
    } finally {
      env.cleanup();
    }
  });
});
