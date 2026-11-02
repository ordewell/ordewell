import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { DockerCall, DockerCli, DockerResult } from '../dockerCli';
import { parseContainerSettings, type ContainerSettings } from '../containerSettings';
import { DockerExecutionBackend } from '../dockerLease';
import { reclaimContainers, reclaimTree, UNPIN_SCRIPT } from '../reclaim';
import { FakeExecutionBackend } from '../../../testing';

const settings = parseContainerSettings({ image: 'ordewell-task', login: { kind: 'own-sign-in' } }) as ContainerSettings;

/** An engine that holds what it is told: `docker ls` answers from these, and every call is written down. */
class EngineHolding implements DockerCli {
  calls: string[] = [];
  containers = ['box-1'];
  networks = ['net-1'];
  volumes = ['ordewell-task-1'];
  mirrors = ['ordewell-mirror-aaaa'];
  caches = ['ordewell-cache-aaaa-npm', 'ordewell-cache-aaaa-pip'];
  /** What each mirror's helper says: it held this tree's pins, and what it still holds of others'. */
  held = true;
  pinsLeft = '';
  /** What a helper finds in a volume that holds no repository: one it made itself, by naming it. */
  hollow = false;
  failing: RegExp | null = null;
  scripts: { args: readonly string[] }[] = [];

  async call(args: readonly string[], _opts?: DockerCall): Promise<DockerResult> {
    const line = args.join(' ');
    this.calls.push(line);
    if (this.failing?.test(line)) return { code: 1, stdout: '', stderr: 'no such thing' };
    const said = (names: string[]) => ({ code: 0, stdout: names.map((name) => `${name}\n`).join(''), stderr: '' });
    if (line.startsWith('container ls')) return said(this.containers);
    if (line.startsWith('network ls')) return said(this.networks);
    if (line.includes('volume ls') && line.includes('label=')) return said(this.volumes);
    if (line.includes('name=ordewell-mirror-')) return said(this.mirrors);
    if (line.includes('name=ordewell-cache-')) return said(this.caches);
    if (args[0] === 'run') {
      this.scripts.push({ args });
      if (this.hollow) return said(['hollow']);
      return said([...(this.held ? ['mine'] : []), ...(this.pinsLeft ? [`left ${this.pinsLeft}`] : [])]);
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  async entry(): Promise<ChildProcess> { throw new Error('nothing starts here'); }
}

const helperOf = (engine: EngineHolding) => engine;

describe('what a tree leaves in the engine goes with it (ADR-0059 L6)', () => {
  it('takes what carries the tree\'s label: containers, then networks, then volumes', async () => {
    const engine = new EngineHolding();

    await reclaimTree('session-1', engine, settings, () => undefined);

    const lines = engine.calls;
    expect(lines).toContain('container ls -aq --filter label=ordewell.tree=session-1');
    const order = ['rm -f box-1', 'network rm net-1', 'volume rm -f ordewell-task-1'].map((line) => lines.indexOf(line));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('takes its pins out of every mirror, in a helper held to the limits of any container, with no network', async () => {
    const engine = new EngineHolding();
    engine.pinsLeft = 'refs/ordewell/pins/other/x/head';

    await reclaimTree('session-1', engine, settings, () => undefined);

    const [{ args }] = engine.scripts;
    expect(args).toContain(UNPIN_SCRIPT);
    expect(args.join(' ')).toContain('ordewell-mirror-aaaa:/mirror');
    expect(args.join(' ')).not.toContain('ordewell-mirror-aaaa:/mirror:ro');
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('--pids-limit 8192');
    expect(args).toContain('--init');
    expect(args.join(' ')).toContain('--memory 4g');
  });

  it('leaves a mirror another tree still pins, and the caches beside it: its clones lean on them', async () => {
    const engine = new EngineHolding();
    engine.pinsLeft = 'refs/ordewell/pins/other/x/head';

    await reclaimTree('session-1', engine, settings, () => undefined);

    expect(engine.calls.some((line) => line.includes('volume rm') && line.includes('ordewell-mirror-'))).toBe(false);
    expect(engine.calls.some((line) => line.includes('volume rm') && line.includes('ordewell-cache-'))).toBe(false);
  });

  it('takes a mirror nothing pins whole, with the caches of its project: nothing leans on either', async () => {
    const engine = new EngineHolding();

    await reclaimTree('session-1', engine, settings, () => undefined);

    expect(engine.calls).toEqual(expect.arrayContaining(['volume rm -f ordewell-mirror-aaaa', 'volume rm -f ordewell-cache-aaaa-npm', 'volume rm -f ordewell-cache-aaaa-pip']));
    expect(engine.calls.some((line) => line.includes('name=ordewell-cache-aaaa-'))).toBe(true);
  });

  it("leaves a mirror it held no pin in, however empty: another project's is none of its business", async () => {
    const engine = new EngineHolding();
    engine.held = false;

    await reclaimTree('session-1', engine, settings, () => undefined);

    expect(engine.calls.some((line) => line.includes('volume rm') && /ordewell-(mirror|cache)-/.test(line))).toBe(false);
  });

  it('never touches a person\'s own sign-in', async () => {
    const engine = new EngineHolding();

    await reclaimTree('session-1', engine, settings, () => undefined);

    expect(engine.calls.join('\n')).not.toContain('ordewell-login');
  });

  it('keeps a mirror it could not read, and says so: pins it cannot see may be in use', async () => {
    const engine = new EngineHolding();
    engine.failing = /^run /;
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(engine.calls.some((line) => line.includes('rm -f ordewell-mirror-'))).toBe(false);
    expect(told.join()).toContain('ordewell-mirror-aaaa');
  });

  it('waits for a volume a closing container still holds: `--rm` takes it a moment after its `rm`', async () => {
    const engine = new EngineHolding();
    let refusals = 2;
    const call = engine.call.bind(engine);
    engine.call = async (args, opts) => {
      if (args.join(' ') === 'volume rm -f ordewell-task-1' && refusals-- > 0) {
        engine.calls.push(args.join(' '));
        return { code: 1, stdout: '', stderr: 'volume is in use' };
      }
      return call(args, opts);
    };
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(engine.calls.filter((line) => line === 'volume rm -f ordewell-task-1')).toHaveLength(3);
    expect(told).toEqual([]);
  });

  const refusingMirror = (engine: EngineHolding, refusals: number, meanwhile: (refused: number) => void = () => undefined) => {
    const call = engine.call.bind(engine);
    let refused = 0;
    engine.call = async (args, opts) => {
      if (args.join(' ') === 'volume rm -f ordewell-mirror-aaaa' && refused < refusals) {
        engine.calls.push(args.join(' '));
        refused += 1;
        meanwhile(refused);
        return { code: 1, stdout: '', stderr: 'Error response from daemon: remove ordewell-mirror-aaaa: volume is in use - [bbbda4f6]' };
      }
      return call(args, opts);
    };
  };

  it("outlasts another session's clean-up reading the mirror: no later clean-up would take one with no pin of its own", async () => {
    const engine = new EngineHolding();
    refusingMirror(engine, 10);
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(told).toEqual([]);
    expect(engine.calls.filter((line) => line === 'volume rm -f ordewell-mirror-aaaa')).toHaveLength(11);
    expect(engine.calls).toContain('volume rm -f ordewell-cache-aaaa-npm');
  });

  it('gives a refused mirror up as soon as a new session has pinned it: waiting must not take what has come to lean on it', async () => {
    const engine = new EngineHolding();
    refusingMirror(engine, 10, (refused) => { if (refused === 5) engine.pinsLeft = 'refs/ordewell/pins/other/x/head'; });
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(engine.calls.filter((line) => line === 'volume rm -f ordewell-mirror-aaaa')).toHaveLength(5);
    expect(engine.calls.some((line) => line.includes('volume rm') && line.includes('ordewell-cache-'))).toBe(false);
    expect(told).toEqual([]);
  });

  it('says so when a mirror it emptied will not go, and leaves the caches beside it', async () => {
    const engine = new EngineHolding();
    refusingMirror(engine, Number.MAX_SAFE_INTEGER);
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(told.join()).toContain('ordewell-mirror-aaaa');
    expect(engine.calls.some((line) => line.includes('volume rm') && line.includes('ordewell-cache-'))).toBe(false);
  });

  it('takes a volume with no repository in it, once and without waiting: a helper makes one by naming a mirror another clean-up took', async () => {
    const engine = new EngineHolding();
    engine.hollow = true;
    refusingMirror(engine, Number.MAX_SAFE_INTEGER);
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(engine.calls.filter((line) => line === 'volume rm -f ordewell-mirror-aaaa')).toHaveLength(1);
    expect(engine.calls.some((line) => line.includes('volume rm') && line.includes('ordewell-cache-'))).toBe(false);
    expect(told).toEqual([]);
  });

  it('names a volume it could not take, and goes on with the rest', async () => {
    const engine = new EngineHolding();
    engine.volumes = ['ordewell-task-stuck', 'ordewell-task-2'];
    engine.failing = /^volume rm -f ordewell-task-stuck$/;
    const told: string[] = [];

    await reclaimTree('session-1', engine, settings, (text) => told.push(text));

    expect(told.join()).toContain('ordewell-task-stuck');
    expect(engine.calls).toContain('volume rm -f ordewell-task-2');
  });

  it('says so where the engine does not answer, and fails nothing', async () => {
    const engine = new EngineHolding();
    engine.failing = /./;
    const told: string[] = [];

    await expect(reclaimTree('session-1', engine, settings, (text) => told.push(text))).resolves.toBeUndefined();

    expect(told).toHaveLength(1);
    expect(told[0]).toContain('no such thing');
  });

  it('still takes what is labelled under settings it cannot read: only the pins need an image', async () => {
    const engine = new EngineHolding();

    await reclaimTree('session-1', engine, null, () => undefined);

    expect(engine.calls).toContain('volume rm -f ordewell-task-1');
    expect(engine.scripts).toEqual([]);
  });
});

describe('a session delete, with no Session left to ask', () => {
  it('reads the setting as it is written, and clears the tree', async () => {
    const engine = new EngineHolding();

    await reclaimContainers('session-1', { image: 'ordewell-task', login: { kind: 'own-sign-in' } }, { cli: helperOf(engine) });

    expect(engine.calls).toContain('volume rm -f ordewell-task-1');
  });

  it('asks nothing of Docker without the setting: local worktrees stay exactly as they are', async () => {
    const engine = new EngineHolding();

    await reclaimContainers('session-1', undefined, { cli: helperOf(engine) });

    expect(engine.calls).toEqual([]);
  });

  it('clears what is labelled under a setting it cannot use', async () => {
    const engine = new EngineHolding();

    await reclaimContainers('session-1', { login: {} }, { cli: helperOf(engine) });

    expect(engine.calls).toContain('volume rm -f ordewell-task-1');
  });
});

describe('a Clean up, through the backend', () => {
  it('waits for an attempt still bringing its work back: a helper started after a volume went would make it again', async () => {
    const engine = new EngineHolding();
    const local = new FakeExecutionBackend();
    const lines: string[] = [];
    engine.containers = [];
    const backend = new DockerExecutionBackend(local, { settings, cli: engine, sessionId: () => 's', tell: vi.fn() });
    let finish!: () => void;
    const box = { bringing: new Promise<void>((resolve) => { finish = resolve; }), closing: Promise.resolve() };
    (backend as unknown as { boxes: Map<string, unknown> }).boxes.set('a', box);
    const call = engine.call.bind(engine);
    engine.call = async (args, opts) => { lines.push(args.join(' ')); return call(args, opts); };

    const reclaiming = backend.reclaim();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines).toEqual([]);

    finish();
    await reclaiming;
    expect(lines.length).toBeGreaterThan(0);
  });

  it('clears the tree the Session stands in, not only the Session', async () => {
    const engine = new EngineHolding();
    const backend = new DockerExecutionBackend(new FakeExecutionBackend(), { settings, cli: engine, sessionId: () => 'child-1', treeId: () => 'root-1', tell: vi.fn() });

    await backend.reclaim();

    expect(engine.calls).toContain('volume ls -q --filter label=ordewell.tree=root-1');
  });
});
