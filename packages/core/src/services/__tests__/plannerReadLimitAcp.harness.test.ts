import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fakeConfig, pathWithFake, patient, removeDir, setEnv } from '../../testing';
import { clearAugmentedPathCache } from '../../utils/shellPath';
import { closeSessions, makeSession } from './sessionTestKit';

/*
 * The planner's read limit (ADR-0068) on an ACP planner, nothing faked but the
 * agent's binary: Copilot CLI over ACP, started as the fake ACP agent, reads
 * the workspace with its own tool. A read it asks about is admitted or refused
 * at its permission request; one it ran without asking is counted from its
 * result, so the reads after it are refused once the turn is past the limit.
 */

const FAKE_ACP = resolve(__dirname, '../../../../../bench/pipeline/fake-acp');

const dirs: string[] = [];
const restores: Array<() => void> = [];
beforeEach(() => clearAugmentedPathCache());
afterEach(async () => {
  await closeSessions();
  while (restores.length) restores.pop()!();
  while (dirs.length) await removeDir(dirs.pop()!);
  clearAugmentedPathCache();
});

interface Read { read: string; asked: boolean; allowed: boolean }

async function planWithReads(limit: string, reads: unknown[], files: Record<string, string>): Promise<Read[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-acp-reads-')));
  dirs.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  const log = join(root, 'said.jsonl');
  restores.push(setEnv({ PATH: pathWithFake(FAKE_ACP, 'copilot', process.env.PATH), FAKE_ACP_LOG: log, ORDEWELL_PLANNER_READ_LIMIT: limit }));
  // The agent starts in a directory of its own, so it names the workspace's files by their full paths.
  const at = (entry: unknown) => (typeof entry === 'string' ? join(root, entry) : { ...(entry as { path: string; ask?: boolean }), path: join(root, (entry as { path: string }).path) });
  const cue = `<fake-acp>${JSON.stringify({ role: 'planner', read: reads.map(at) })}</fake-acp>`;
  const session = makeSession({ workspaceRoot: () => root, config: fakeConfig({ aiProvider: 'copilot-cli', enabledRunners: ['copilot-cli'] }) });
  await session.startPlanning(`Plan a parser. ${cue}`, ['copilot-cli']);
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Partial<Read>)
    .filter((line): line is Read => typeof line.read === 'string')
    .map(({ read, asked, allowed }) => ({ read: read.slice(root.length + 1), asked, allowed }));
}

describe('an ACP planner\'s own reads are held to the read limit', () => {
  it('refuses an asked read past the turn\'s calls', async () => {
    const reads = await planWithReads('2,60', ['a.txt', 'b.txt', 'c.txt'], { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    expect(reads).toEqual([
      { read: 'a.txt', asked: true, allowed: true },
      { read: 'b.txt', asked: true, allowed: true },
      { read: 'c.txt', asked: true, allowed: false },
    ]);
  }, patient(60_000));

  it('counts the reads the agent ran without asking, so the next asked one is refused', async () => {
    const reads = await planWithReads('2,60', [{ path: 'a.txt', ask: false }, { path: 'b.txt', ask: false }, 'c.txt'], { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    expect(reads).toEqual([
      { read: 'a.txt', asked: false, allowed: true },
      { read: 'b.txt', asked: false, allowed: true },
      { read: 'c.txt', asked: true, allowed: false },
    ]);
  }, patient(60_000));

  it('charges an unasked read\'s bytes, so a large one spends the turn\'s budget', async () => {
    const reads = await planWithReads('10,1', [{ path: 'big.txt', ask: false }, 'c.txt'], { 'big.txt': 'x'.repeat(2048), 'c.txt': 'c' });
    expect(reads).toEqual([
      { read: 'big.txt', asked: false, allowed: true },
      { read: 'c.txt', asked: true, allowed: false },
    ]);
  }, patient(60_000));
});
