import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const spawned = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter: Emitter } = await import('events');
  return {
    ...real,
    spawn: vi.fn(() => {
      const child = Object.assign(new Emitter(), { kill: vi.fn() });
      spawned.children.push(child);
      return child;
    }),
  };
});
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), existsSync: () => true }));

import { handleWeb } from '../web';

type FakeChild = EventEmitter & { kill: ReturnType<typeof vi.fn> };

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

let exit: MockInstance<typeof process.exit>;
let baseline: Record<string, Array<(...a: unknown[]) => void>>;

beforeEach(() => {
  spawned.children.length = 0;
  baseline = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s) as Array<(...a: unknown[]) => void>]));
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  for (const s of SIGNALS) {
    for (const l of process.listeners(s)) if (!baseline[s].includes(l as never)) process.off(s, l);
  }
  vi.restoreAllMocks();
});

async function start(): Promise<FakeChild> {
  await handleWeb(['--port', '3999']);
  return spawned.children[0] as FakeChild;
}

describe('ordewell web (foreground)', () => {
  it.each(SIGNALS)('relays %s to the server it started, so it is not orphaned', async (signal) => {
    const child = await start();
    const added = process.listeners(signal).filter((l) => !baseline[signal].includes(l as never));

    expect(added.length).toBeGreaterThan(0);
    added.forEach((l) => l(signal));

    expect(child.kill).toHaveBeenCalledWith(signal);
  });

  it('exits with the server’s own code', async () => {
    const child = await start();

    child.emit('exit', 3, null);

    expect(exit).toHaveBeenCalledWith(3);
  });

  it('does not report success for a server a signal killed', async () => {
    const child = await start();
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);

    child.emit('exit', null, 'SIGKILL');

    // Either re-raised on this process or turned into a failing exit code.
    const reRaised = kill.mock.calls.some(([, sig]) => sig === 'SIGKILL');
    const failed = exit.mock.calls.some(([code]) => typeof code === 'number' && code !== 0);
    expect(reRaised || failed).toBe(true);
    expect(exit).not.toHaveBeenCalledWith(0);
  });
});
