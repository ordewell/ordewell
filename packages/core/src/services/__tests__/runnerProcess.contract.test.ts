import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import type { ChildProcess } from 'child_process';
import { CONNECTORS } from '../harness/connectors';
import { RunnerProcess } from '../harness/runnerProcess';
import type { AgentProcessDeps, AgentStartOptions } from '../harness/AgentAdapter';
import { fakeSpawn, type FakeAgentProcess } from './harnessTestKit';
import { FAKE_RUNNERS } from './fakeRunners';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { mcpClientConfig } from '../mcp';

/**
 * What every structured adapter owes the runner process it starts, checked
 * the same way for each entry of the connector registry: a start that is
 * refused leaves nothing running, and dispose reaches the whole tree — the
 * runner's process group, not just the CLI at its head.
 */

const MCP = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' });
const plannerStart: AgentStartOptions = { kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', mcp: MCP };
const manifests = new RunnerRegistry();

/** A planner's start where the runner can plan; a task's, which a runner that only runs tasks needs, where it cannot. */
function startFor(runner: string): AgentStartOptions {
  if (CONNECTORS[runner].plans) return plannerStart;
  const manifest = manifests.getManifest(runner)!;
  const mode = manifest.modes![0].id;
  return { kind: 'task', cwd: '/repo', mode, flags: resolveTaskRunnerFlags(manifest, { mode }), mcp: MCP };
}

function baseDeps(spawn: AgentProcessDeps['spawn'], fetchImpl: typeof fetch): AgentProcessDeps {
  return {
    spawn,
    fetch: fetchImpl,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
}

const noHttp = (async () => { throw new Error('no HTTP for this runner'); }) as unknown as typeof fetch;
const emptyHttp = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;

/** How each runner's start is refused, and how many runners it had launched by then. */
const REFUSED: Record<string, { deps: () => AgentProcessDeps; launches: number }> = {
  // Claude Code takes its first message without a handshake, so its start is
  // only ever refused before anything is spawned.
  'claude-code': { deps: () => ({ ...baseDeps(fakeSpawn([]).spawn, noHttp), exists: () => false }), launches: 0 },
  codex: { deps: () => baseDeps(fakeSpawn([`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unsupported client' } })}\n`]).spawn, noHttp), launches: 1 },
  opencode: { deps: () => {
    const spawned = fakeSpawn([]);
    const spawn: AgentProcessDeps['spawn'] = (command, args, options) => {
      const proc = spawned.spawn(command, args, options);
      queueMicrotask(() => spawned.processes[spawned.processes.length - 1].emitStdout('opencode server listening on http://127.0.0.1:4096\n'));
      return proc;
    };
    // Listening, but it hands back no session.
    return baseDeps(spawn, emptyHttp);
  }, launches: 1 },
  // An ACP agent is refused at `initialize`, once it is running.
  'copilot-cli': { deps: () => baseDeps(fakeSpawn([`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'unsupported client' } })}\n`]).spawn, noHttp), launches: 1 },
  'qwen-code': { deps: () => baseDeps(fakeSpawn([`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'unsupported client' } })}\n`]).spawn, noHttp), launches: 1 },
  // Cline's key is handed in as Ordewell's environment would hold it, so the start never reads Cline's own store.
  cline: { deps: () => ({ ...baseDeps(fakeSpawn([`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'unsupported client' } })}\n`]).spawn, noHttp), workspaceEnv: async () => ({ CLINE_API_KEY: 'sk-fake' }) }), launches: 1 },
};

let nextPid = 3_900_000;
const launched: FakeAgentProcess[] = [];
let kill: MockInstance<typeof process.kill>;

/** `deps`, with every runner it launches given a pid, so it leads a process group the way a real one does. */
function tracked(deps: AgentProcessDeps): AgentProcessDeps {
  return {
    ...deps,
    spawn: (command, args, options) => {
      const proc = deps.spawn(command, args, options);
      // Codex's sandbox probe is a side process that ends itself, not the runner.
      if (args[0] !== 'sandbox') {
        Object.defineProperty(proc, 'pid', { value: nextPid++ });
        launched.push(proc as unknown as FakeAgentProcess);
      }
      return proc;
    },
  };
}

function groupSignals(proc: ChildProcess): string[] {
  return kill.mock.calls.filter(([pid]) => pid === -(proc.pid ?? 0)).map(([, signal]) => String(signal));
}

beforeEach(() => {
  // The forced follow-up is a timer: faked, it fires here under the spy rather
  // than against a real process group after the test.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  // Ends each leader, which is what drops its group from the host's teardown list.
  for (const proc of launched.splice(0)) proc.exit(0);
  kill.mockRestore();
  vi.useRealTimers();
});

it('has a refusal for every connector', () => {
  expect(Object.keys(REFUSED).sort()).toEqual(Object.keys(CONNECTORS).sort());
});

describe.each(Object.keys(CONNECTORS))('the %s adapter', (runner) => {
  it('leaves no live process behind a start that was refused', async () => {
    const adapter = CONNECTORS[runner].create(tracked(REFUSED[runner].deps()));

    await expect(adapter.start(startFor(runner))).rejects.toThrow();
    vi.advanceTimersByTime(5_000);
    expect(launched).toHaveLength(REFUSED[runner].launches);
    for (const proc of launched) expect(groupSignals(proc)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('kills the runner\'s whole process group on dispose', async () => {
    const fake = FAKE_RUNNERS[runner]({ attach: 'connected' });
    const adapter = CONNECTORS[runner].create(tracked(fake.deps));
    const start = startFor(runner);
    await adapter.start(fake.withServer?.(start) ?? start);
    expect(launched).toHaveLength(1);
    expect(groupSignals(launched[0])).toEqual([]);

    adapter.dispose();
    expect(groupSignals(launched[0])).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(5_000);
    expect(groupSignals(launched[0])).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('RunnerProcess', () => {
  it('takes the process down with a handshake that throws, and rethrows its error unchanged', async () => {
    const runner = new RunnerProcess(tracked(baseDeps(fakeSpawn([]).spawn, noHttp)));
    const refused = new Error('handshake refused');

    await expect(runner.start('/repo', () => ({ command: 'agent', args: [] }), async () => { throw refused; })).rejects.toBe(refused);
    expect(launched).toHaveLength(1);
    expect(groupSignals(launched[0])).toEqual(['SIGTERM']);
  });

  it('spawns nothing for a workspace that does not exist, and never asks what to launch', async () => {
    const spawned = fakeSpawn([]);
    const describe = vi.fn(() => ({ command: 'agent', args: [] }));
    const runner = new RunnerProcess({ ...baseDeps(spawned.spawn, noHttp), isDirectory: () => false });

    await expect(runner.start('/gone', describe, async () => {})).rejects.toThrow('/gone');
    expect(describe).not.toHaveBeenCalled();
    expect(spawned.processes).toHaveLength(0);
  });

  it('starts a launch that names its own directory there, under the workspace\'s variables, and refuses one a placement would put elsewhere', async () => {
    const spawned = fakeSpawn([]);
    const askedFor: string[] = [];
    const deps = { ...baseDeps(spawned.spawn, noHttp), workspaceEnv: async (cwd: string) => { askedFor.push(cwd); return { FROM_ENVRC: 'yes' }; } };
    await new RunnerProcess(tracked(deps)).start('/repo', () => ({ command: 'agent', args: [], cwd: '/private-start' }), async () => {});
    expect(spawned.lastCwd()).toBe('/private-start');
    expect(askedFor).toEqual(['/repo']);
    expect(spawned.lastEnv().FROM_ENVRC).toBe('yes');

    const place = vi.fn();
    const placed = new RunnerProcess({ ...deps, placement: { cwd: '/work', place, reach: async (url) => url, blob: async () => undefined } });
    await expect(placed.start('/repo', () => ({ command: 'agent', args: [], cwd: '/private-start' }), async () => {})).rejects.toThrow(/placement/);
    expect(place).not.toHaveBeenCalled();
    expect(spawned.processes).toHaveLength(1);
  });
});
