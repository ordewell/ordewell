import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStore } from '../../services/eventStore';
import { CorruptEventLogError } from '../../services/eventStore';
import type { TreeEvent, TreeFact } from '../../models/TreeEvent';
import { FakeEventStore } from '../../testing';
import { jsonlEventStore, treeEventLogFile } from '../treeEventLog';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const AT = '2026-10-31T10:00:00.000Z';
const spent = (node: string, tokens: number): TreeFact => ({ kind: 'tokens_spent', at: AT, node, tokens });

async function all(store: EventStore, after = 0, node?: string): Promise<TreeEvent[]> {
  const events: TreeEvent[] = [];
  for await (const event of store.read(after, node)) events.push(event);
  return events;
}

const tokensOf = (events: readonly TreeEvent[]) => events.map((e) => (e.kind === 'tokens_spent' ? e.tokens : -1));

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-tree-log-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** ADR-0058's testing decision: the fake and the backend answer to one suite. */
describe.each<[string, () => EventStore]>([
  ['the in-memory fake', () => new FakeEventStore()],
  ['the JSONL backend', () => jsonlEventStore(path.join(dir, 'nested', 'tree.jsonl'))],
])('%s', (_name, open) => {
  it('reads nothing before anything is appended', async () => {
    expect(await all(open())).toEqual([]);
  });

  it('reads what was appended, in order, numbered from 1', async () => {
    const store = open();
    await store.append([spent('root/1', 10), spent('root/1', 20)]);
    await store.append([spent('root/2', 30)]);
    const events = await all(store);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(tokensOf(events)).toEqual([10, 20, 30]);
  });

  it('keeps the order of appends made without waiting for each other', async () => {
    const store = open();
    await Promise.all([10, 20, 30, 40].map((tokens) => store.append([spent('root/1', tokens)])));
    expect(tokensOf(await all(store))).toEqual([10, 20, 30, 40]);
  });

  it('reads only what came after a cursor', async () => {
    const store = open();
    await store.append([spent('root/1', 10), spent('root/1', 20), spent('root/1', 30)]);
    expect(tokensOf(await all(store, 2))).toEqual([30]);
    expect(await all(store, 3)).toEqual([]);
  });

  it('reads a node and what is under it, and not a sibling that shares its prefix', async () => {
    const store = open();
    await store.append([spent('root', 1), spent('root/3', 2), spent('root/3/2', 3), spent('root/31', 4), spent('root/4', 5)]);
    expect(tokensOf(await all(store, 0, 'root/3'))).toEqual([2, 3]);
    expect(tokensOf(await all(store, 0, 'root'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('takes an empty batch as nothing', async () => {
    const store = open();
    await store.append([]);
    await store.append([spent('root/1', 10)]);
    expect((await all(store)).map((e) => e.seq)).toEqual([1]);
  });

  it('refuses an append once closed', async () => {
    const store = open();
    await store.close();
    await expect(store.append([spent('root/1', 10)])).rejects.toThrow(/closed/);
  });
});

describe('the JSONL backend across a crash', () => {
  const file = () => path.join(dir, 'tree.jsonl');

  /** Two batches on disk, as a process that has gone left them. */
  async function written(): Promise<void> {
    const store = jsonlEventStore(file());
    await store.append([spent('root/1', 10), spent('root/1', 20)]);
    await store.append([spent('root/1', 30)]);
    await store.close();
  }

  it('makes no file for a store nothing was appended to', async () => {
    const store = jsonlEventStore(file());
    await all(store);
    await store.append([]);
    await store.close();
    expect(fs.existsSync(file())).toBe(false);
  });

  it('carries the numbering on across a reopen', async () => {
    await written();
    const store = jsonlEventStore(file());
    await store.append([spent('root/1', 40)]);
    expect((await all(store)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('drops a torn last line on read and keeps all that came before it', async () => {
    await written();
    fs.appendFileSync(file(), '[{"seq":4,"kind":"tokens_sp');
    expect(tokensOf(await all(jsonlEventStore(file())))).toEqual([10, 20, 30]);
  });

  it('never changes the file on a read: only the writer, which holds the session, repairs it', async () => {
    await written();
    fs.appendFileSync(file(), '[{"seq":4');
    const before = fs.readFileSync(file(), 'utf-8');
    await all(jsonlEventStore(file()));
    expect(fs.readFileSync(file(), 'utf-8')).toBe(before);
  });

  it('takes a batch whole or not at all: a batch torn after its first event leaves none of it', async () => {
    await written();
    const store = jsonlEventStore(file());
    await store.append([spent('root/1', 40), spent('root/1', 50), spent('root/1', 60)]);
    await store.close();
    // Past the first two of the batch's three events, short of its end.
    fs.truncateSync(file(), fs.statSync(file()).size - 20);
    expect(tokensOf(await all(jsonlEventStore(file())))).toEqual([10, 20, 30]);
  });

  it('takes a last line with no newline as torn even where it parses: the newline is what says it landed', async () => {
    await written();
    fs.appendFileSync(file(), `[${JSON.stringify({ seq: 4, ...spent('root/1', 40) })}]`);
    expect(tokensOf(await all(jsonlEventStore(file())))).toEqual([10, 20, 30]);
  });

  it('appends after a torn line onto a clean end, so what comes next is not lost with it', async () => {
    await written();
    fs.appendFileSync(file(), '[{"seq":4,"kind":"tokens_sp');
    const reopened = jsonlEventStore(file());
    await reopened.append([spent('root/1', 40)]);
    await reopened.close();
    const events = await all(jsonlEventStore(file()));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(tokensOf(events)).toEqual([10, 20, 30, 40]);
  });

  it('drops a last line of garbage that does end in a newline', async () => {
    await written();
    fs.appendFileSync(file(), 'not json\n');
    const reopened = jsonlEventStore(file());
    await reopened.append([spent('root/1', 40)]);
    expect(tokensOf(await all(reopened))).toEqual([10, 20, 30, 40]);
  });

  it('refuses a bad line with good ones after it: that is no crash, and skipping it would lose spend', async () => {
    await written();
    const [first, second] = fs.readFileSync(file(), 'utf-8').split('\n');
    fs.writeFileSync(file(), `${first}\nnot json\n${second}\n`);
    await expect(all(jsonlEventStore(file()))).rejects.toThrow(CorruptEventLogError);
  });

  it('reads a batch larger than one read of the file', async () => {
    const store = jsonlEventStore(file());
    const big = Array.from({ length: 5000 }, (_, i) => spent('root/1', i));
    await store.append(big);
    expect(await all(store)).toHaveLength(5000);
  });

  it('keeps bytes whole across a read: a name with accents does not break a line', async () => {
    const store = jsonlEventStore(file());
    const named: TreeFact = { kind: 'node_opened', at: AT, node: 'root/1', sessionId: 'é'.repeat(70_000), limit: 10, kept: 0 };
    await store.append([named]);
    const [event] = await all(jsonlEventStore(file()));
    expect(event.kind === 'node_opened' && event.sessionId).toBe(named.sessionId);
  });

  it('cuts off what a failed write left, so the next append lands and the next process reads clean', async () => {
    await written();
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      handle.appendFile = async (line) => {
        fs.appendFileSync(file(), String(line).slice(0, 12));
        throw new Error('disk full');
      };
      return handle;
    });
    const store = jsonlEventStore(file());
    await expect(store.append([spent('root/1', 40)])).rejects.toThrow('disk full');
    await store.append([spent('root/1', 50)]);
    await store.close();
    const events = await all(jsonlEventStore(file()));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(tokensOf(events)).toEqual([10, 20, 30, 50]);
  });
});

describe('where a tree keeps its log', () => {
  it('is the root session\'s directory, so it goes with that session', () => {
    expect(treeEventLogFile('root-1', '/repo')).toBe(path.join('/repo', '.ordewell', 'sessions', 'root-1', 'tree-events.jsonl'));
  });
});

describe('appending to a log just read', () => {
  it('does not read the file again for where it ends', async () => {
    const file = path.join(dir, 'tree.jsonl');
    const first = jsonlEventStore(file);
    await first.append([spent('root/1', 10), spent('root/1', 20)]);
    await first.close();
    const store = jsonlEventStore(file);
    await all(store);
    vi.mocked(fs.createReadStream).mockClear();
    await store.append([spent('root/1', 30)]);
    expect(fs.createReadStream).not.toHaveBeenCalled();
    expect((await all(store)).map((e) => e.seq)).toEqual([1, 2, 3]);
    await store.close();
  });

  it('reads it again when the file moved since', async () => {
    const file = path.join(dir, 'tree.jsonl');
    const reader = jsonlEventStore(file);
    const writer = jsonlEventStore(file);
    await writer.append([spent('root/1', 10)]);
    await all(reader);
    await writer.append([spent('root/1', 20)]);
    await writer.close();
    await reader.append([spent('root/1', 30)]);
    expect((await all(reader)).map((e) => e.seq)).toEqual([1, 2, 3]);
    await reader.close();
  });

  it('cuts a torn line the read left behind', async () => {
    const file = path.join(dir, 'tree.jsonl');
    const first = jsonlEventStore(file);
    await first.append([spent('root/1', 10)]);
    await first.close();
    fs.appendFileSync(file, '[{"kind":"tokens');
    const store = jsonlEventStore(file);
    await all(store);
    await store.append([spent('root/1', 20)]);
    expect(tokensOf(await all(store))).toEqual([10, 20]);
    await store.close();
  });

  it('leaves a read abandoned part way out of it', async () => {
    const file = path.join(dir, 'tree.jsonl');
    const first = jsonlEventStore(file);
    await first.append([spent('root/1', 10)]);
    await first.append([spent('root/1', 20)]);
    await first.close();
    const store = jsonlEventStore(file);
    for await (const event of store.read(0)) { expect(event.seq).toBe(1); break; }
    await store.append([spent('root/1', 30)]);
    expect((await all(store)).map((e) => e.seq)).toEqual([1, 2, 3]);
    await store.close();
  });
});
