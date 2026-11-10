import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fakeConfig, pathWithFake, patient, removeDir, setEnv } from '../../testing';
import { clearAugmentedPathCache } from '../../utils/shellPath';
import { closeSessions, makeSession } from './sessionTestKit';

/*
 * A checkpoint seeds the next context with the decision record (ADR-0067): on
 * each backend, nothing faked but the agent's binary, the planner records as it
 * goes, the user compacts, and the fresh session the next message starts is
 * told the record, the constraint in the user's own words, and where things are.
 */

const FAKE_CLAUDE = resolve(__dirname, '../../../../../bench/pipeline/fake-claude');
const FAKE_ACP = resolve(__dirname, '../../../../../bench/pipeline/fake-acp');

const dirs: string[] = [];
const restores: Array<() => void> = [];
// The spawn PATH is resolved once per process: each backend's fake must be found on the PATH its test sets.
beforeEach(() => clearAugmentedPathCache());
afterEach(async () => {
  await closeSessions();
  while (restores.length) restores.pop()!();
  while (dirs.length) await removeDir(dirs.pop()!);
  clearAugmentedPathCache();
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-record-')));
  dirs.push(dir);
  return dir;
}

const CONSTRAINT = 'Never add a runtime dependency.';
const GOAL = `Build a JSON parser. ${CONSTRAINT}`;
const RECORDED = {
  entries: [
    { kind: 'decision', text: 'Stream with a pull parser', why: 'the files are large' },
    { kind: 'constraint', text: CONSTRAINT },
  ],
};
const WHERE = 'The parser is half planned; the planner waits on the user to pick an error format.';

interface Said { sessionId: string; prompt?: string; tool?: string; reply?: { text: string; isError: boolean } }
const said = (log: string): Said[] => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Said);

/** What every backend's restart is checked by: the first prompt of the session after the checkpoint. */
function expectSeeded(prompt: string | undefined) {
  expect(prompt).toContain('<decision_record>');
  expect(prompt).toContain('- D1: Stream with a pull parser. Why: the files are large');
  expect(prompt).toContain(`- C1: "${CONSTRAINT}"`);
  expect(prompt).toContain(`Where we are:\n${WHERE}`);
}

describe('a compaction restarts the planner seeded with the decision record', () => {
  it('on Claude Code', async () => {
    const state = tempDir();
    const log = join(state, 'said.jsonl');
    restores.push(setEnv({ PATH: pathWithFake(FAKE_CLAUDE, 'claude', process.env.PATH), FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: log }));
    const cue = (spec: unknown) => `<fake-claude>${JSON.stringify(spec)}</fake-claude>`;
    const before = join(state, 'before.json');
    const after = join(state, 'after.json');
    writeFileSync(before, JSON.stringify([[['record', RECORDED]], [], [], { text: `<conversation_summary>${WHERE}</conversation_summary>` }]));
    writeFileSync(after, JSON.stringify([[]]));
    const session = makeSession({ workspaceRoot: () => state, config: fakeConfig({ aiProvider: 'claude-code' }) });

    await session.startPlanning(`${GOAL} ${cue({ turnsFrom: before })}`, ['claude-code']);
    await session.continueConversation('Large files, yes.');
    await session.continueConversation('Let me think about errors.');
    expect(session.planState?.decisionRecord).toHaveLength(2);
    expect(await session.compactConversation()).toMatchObject({ summary: WHERE });
    await session.continueConversation(`Report errors with line numbers. ${cue({ turnsFrom: after })}`);

    const lines = said(log);
    expect(lines.find((l) => l.tool === 'record')?.reply).toMatchObject({ isError: false });
    const first = lines.find((l) => l.prompt !== undefined)!.sessionId;
    expectSeeded(lines.find((l) => l.prompt !== undefined && l.sessionId !== first)?.prompt);
  }, patient(60_000));

  it('on Copilot CLI, over ACP', async () => {
    const state = tempDir();
    const log = join(state, 'said.jsonl');
    restores.push(setEnv({ PATH: pathWithFake(FAKE_ACP, 'copilot', process.env.PATH), FAKE_ACP_LOG: log }));
    const cue = (spec: unknown) => `<fake-acp>${JSON.stringify(spec)}</fake-acp>`;
    const turns = [{ role: 'planner' }, { role: 'planner' }, { role: 'planner', text: `<conversation_summary>${WHERE}</conversation_summary>` }];
    const session = makeSession({ workspaceRoot: () => state, config: fakeConfig({ aiProvider: 'copilot-cli', enabledRunners: ['copilot-cli'] }) });

    await session.startPlanning(`${GOAL} ${cue({ role: 'planner', calls: [['record', RECORDED]], turns })}`, ['copilot-cli']);
    await session.continueConversation('Large files, yes.');
    await session.continueConversation('Let me think about errors.');
    expect(session.planState?.decisionRecord).toHaveLength(2);
    expect(await session.compactConversation()).toMatchObject({ summary: WHERE });
    await session.continueConversation(`Report errors with line numbers. ${cue({ role: 'planner' })}`);

    const lines = said(log);
    expect(lines.find((l) => l.tool === 'record')?.reply).toMatchObject({ isError: false });
    const first = lines.find((l) => l.prompt !== undefined)!.sessionId;
    expectSeeded(lines.find((l) => l.prompt !== undefined && l.sessionId !== first)?.prompt);
  }, patient(60_000));
});
