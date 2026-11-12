import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fakeConfig, pathWithFake, patient, removeDir, setEnv } from '../../testing';
import { clearAugmentedPathCache } from '../../utils/shellPath';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { UserSettings } from '../SettingsService';
import { closeSessions, makeSession } from './sessionTestKit';

/*
 * A Claude Code planner's own native reads are counted against the planner
 * read limit and refused past it (ADR-0068), with nothing faked but the CLI:
 * the fake runs Read, Grep, Glob and LSP itself, asking first exactly where
 * the ask rules Ordewell launches it with say to, as the real CLI does.
 */

const FAKE_CLAUDE = resolve(__dirname, '../../../../../bench/pipeline/fake-claude');

const dirs: string[] = [];
const restores: Array<() => void> = [];
beforeEach(() => clearAugmentedPathCache());
afterEach(async () => {
  await closeSessions();
  while (restores.length) restores.pop()!();
  while (dirs.length) await removeDir(dirs.pop()!);
  clearAugmentedPathCache();
});

interface Said { tool?: string; native?: boolean; reply?: { text: string; isError: boolean } }

/** Runs one planner turn of native reads in a workspace holding `files`, and returns what each read got back. */
async function plannerReads(files: Record<string, string>, calls: Array<[string, Record<string, unknown>]>, plannerReadLimit: UserSettings['plannerReadLimit']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-readlimit-')));
  dirs.push(root);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(root, name), contents);
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-readlimit-state-')));
  dirs.push(state);
  const log = join(state, 'said.jsonl');
  const turns = join(state, 'turns.json');
  writeFileSync(turns, JSON.stringify([calls]));
  restores.push(setEnv({
    PATH: pathWithFake(FAKE_CLAUDE, 'claude', process.env.PATH),
    FAKE_CLAUDE_STATE: state,
    FAKE_CLAUDE_LOG: log,
    ORDEWELL_PLANNER_READ_LIMIT: undefined,
  }));
  const session = makeSession({
    workspaceRoot: () => root,
    config: fakeConfig({ aiProvider: 'claude-code' }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, plannerReadLimit }),
  });

  await session.startPlanning(`Plan the parser. <fake-claude>${JSON.stringify({ turnsFrom: turns })}</fake-claude>`, ['claude-code']);

  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Said)
    .filter((line) => line.native).map((line) => ({ tool: line.tool, ...line.reply! }));
}

describe('a Claude Code planner\'s native reads under the read limit (ADR-0068)', () => {
  it('refuses every read-class native tool past the call limit, LSP included', async () => {
    const replies = await plannerReads(
      { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' },
      [
        ['Read', { file_path: 'a.ts' }],
        ['Grep', { pattern: 'export' }],
        ['LSP', { operation: 'documentSymbol', filePath: 'b.ts', line: 1, character: 1 }],
        ['Glob', { pattern: '*.ts' }],
      ],
      { calls: 2 },
    );

    expect(replies.map(({ tool, isError }) => [tool, isError])).toEqual([['Read', false], ['Grep', false], ['LSP', true], ['Glob', true]]);
    expect(replies[2]?.text).toMatch(/^Read limit reached: you have made 2 reads this turn/);
    expect(replies[3]?.text).toMatch(/delegate what is left to a research agent or a research task/);
  }, patient(60_000));

  it('charges the bytes a native read returned, and refuses the next read past them', async () => {
    const replies = await plannerReads(
      { 'big.ts': `${'// a long comment line, read in full\n'.repeat(60)}` },
      [
        ['Read', { file_path: 'big.ts' }],
        ['LSP', { operation: 'hover', filePath: 'big.ts', line: 1, character: 1 }],
      ],
      { calls: 10, kb: 1 },
    );

    expect(replies.map(({ tool, isError }) => [tool, isError])).toEqual([['Read', false], ['LSP', true]]);
    expect(replies[1]?.text).toMatch(/^Read limit reached: you have made 1 read this turn \(2 KB\)/);
  }, patient(60_000));
});

describe('a confined read outside a planner\'s workspace (ADR-0008)', () => {
  it('is refused without asking anyone, where a plain read would be offered for approval', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-confined-')));
    dirs.push(base);
    const workspaceRoot = join(base, 'ws');
    mkdirSync(workspaceRoot);
    writeFileSync(join(base, 'other.ts'), 'export {};\n');
    const request = vi.fn(async () => true);
    const ask = { kind: 'path', path: join(base, 'other.ts'), directory: false } as const;

    const confined = await decidePlannerPermission({ ...ask, confined: true }, {}, { workspaceRoot, approval: { request } });
    expect(confined).toMatchObject({ decision: 'deny', note: expect.stringContaining('reads only inside it') });
    expect(request).not.toHaveBeenCalled();
    expect((await decidePlannerPermission(ask, {}, { workspaceRoot, approval: { request } })).decision).toBe('allow');
    expect(request).toHaveBeenCalledOnce();
  });
});
