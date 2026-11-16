import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import type { AgentStartOptions } from '../harness/AgentAdapter';
import { mcpClientConfig } from '../mcp';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { CMD_EXE_MAX_COMMAND_LINE, planDirectLaunch, windowsCommandLine, type LaunchDeps } from '../../utils/launch';
import { modeIds, spawnedConnectors, type FakeLaunch } from './harnessTestKit';
import { FAKE_RUNNERS, type FakeRunner } from './fakeRunners';

/**
 * No prompt rides a runner's command line (ADR-0010 §1), checked the same way
 * for every connector that starts a process, as a planner and as a task in
 * each of its modes: however long the prompts and whatever they hold, the
 * argv stays short, on one line and free of `"`, so it starts through any
 * launcher Windows has — a native `.exe`, the file an npm shim names, a
 * `.ps1`, and a `.cmd` of another make, through cmd.exe's 8191-character
 * buffer that a line break or a quote shuts out. And the prompts still reach
 * the runner whole, by a file or its own protocol.
 */

/** What a command line mangles somewhere: a quote, cmd.exe's and PowerShell's expansions, a backtick, cmd.exe's metacharacters, CRLF and LF. */
const HOSTILE = 'He said "ship it" at %PATH% with $(whoami) and `id`, & del x | more ^ <in >out \\"\'quoted\'\r\nthen a CRLF line\nand an LF one';

/** About 200,000 characters of `HOSTILE`, past Windows' 32767 several times over, each end marked. */
function huge(name: string): string {
  const lines = [`BEGIN ${name}`];
  for (let n = 1; lines.join('\r\n').length < 200_000; n++) lines.push(`${name} ${n}: ${HOSTILE}`);
  return [...lines, `END ${name}`].join('\r\n');
}

const SYSTEM_PROMPT = huge('SYSTEM');
const TASK_PROMPT = huge('TASK');

const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });
const manifests = new RunnerRegistry();
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

/**
 * A host whose only `command` is a `.cmd` npm did not write, in a folder with
 * a space in its name: the batch route, which no shim's target is read past.
 */
function loneBatchShim(command: string): LaunchDeps {
  const dir = 'C:\\Users\\Some One\\AppData\\Local\\bin';
  const shim = path.win32.join(dir, `${command}.cmd`);
  return {
    platform: 'win32',
    resolvePath: async () => dir,
    exists: (candidate) => candidate.toLowerCase() === shim.toLowerCase(),
    comSpec: () => COMSPEC,
    pathExt: () => '.COM;.EXE;.BAT;.CMD',
    readShim: () => `@echo off\r\nset AGENT_HOME=%~dp0\r\n"%~dp0\\${command}-real.exe" %*\r\n`,
  };
}

/** Every launch short, on one line and quote-free, and started through a lone `.cmd`. */
async function expectShortCommandLines(launches: FakeLaunch[]): Promise<void> {
  expect(launches.length).toBeGreaterThan(0);
  for (const { command, args } of launches) {
    expect(args.filter((arg) => /[\r\n"]/.test(arg))).toEqual([]);
    expect(windowsCommandLine(command, args).length).toBeLessThan(CMD_EXE_MAX_COMMAND_LINE);
    await expect(planDirectLaunch(command, args, loneBatchShim(command))).resolves.toMatchObject({ file: COMSPEC, verbatim: true });
  }
}

/** Whether `text` reached the runner whole: in what it was told to read, or in what it was sent. */
function reached(fake: FakeRunner, text: string): boolean {
  return [fake.instructions(), ...fake.received()].some((delivered) => delivered.includes(text));
}

function taskStart(runner: string, mode: string): AgentStartOptions {
  const flags = resolveTaskRunnerFlags(manifests.get(runner)!.manifest, { mode });
  return { kind: 'task', cwd: '/repo', mode, flags, mcp };
}

const plannerStarts: Array<[string, AgentStartOptions]> = [
  ['planner', { kind: 'planner', cwd: '/repo', systemPrompt: SYSTEM_PROMPT, mcp }],
  // A subplanner's own process narrows what it loads (ADR-0057 R11).
  ['subplanner', { kind: 'planner', cwd: '/repo', systemPrompt: SYSTEM_PROMPT, mcp, runnerConfig: 'minimal', noSubagents: true }],
];

async function opened(runner: string, start: AgentStartOptions): Promise<{ fake: FakeRunner; dispose: () => void }> {
  const fake = FAKE_RUNNERS[runner]({ attach: 'connected' });
  const adapter = CONNECTORS[runner].create(fake.deps);
  await adapter.start(fake.withServer?.(start) ?? start);
  void adapter.send(TASK_PROMPT, () => {}).catch(() => undefined);
  await fake.turnOpen();
  return { fake, dispose: () => adapter.dispose() };
}

it('holds a prompt far past every command-line limit, with every character one mangles', () => {
  for (const prompt of [SYSTEM_PROMPT, TASK_PROMPT]) {
    expect(prompt.length).toBeGreaterThan(190_000);
    for (const character of ['"', '%PATH%', '$(', '`', '\r\n', '\n']) expect(prompt).toContain(character);
  }
});

describe.each(spawnedConnectors())('the %s connector\'s command line', (runner) => {
  const tasks = modeIds(manifests.get(runner)!.manifest).map((mode): [string, AgentStartOptions] => [`task in ${mode}`, taskStart(runner, mode)]);
  const starts = [...(CONNECTORS[runner].plans ? plannerStarts : []), ...tasks];

  it.each(starts)('starts a %s on a short, single-line, quote-free command line, and the prompts reach it whole', async (role, start) => {
    const { fake, dispose } = await opened(runner, start);
    try {
      await expectShortCommandLines(fake.launched());
      if (start.kind === 'planner') expect(reached(fake, SYSTEM_PROMPT), `${role}'s system prompt`).toBe(true);
      expect(reached(fake, TASK_PROMPT), `${role}'s first message`).toBe(true);
    } finally {
      dispose();
    }
  });
});

// The one launch that is neither a planner nor a task: it asks who is signed in, and what the plan's limits stand at.
it('starts Claude Code\'s account query on a short, single-line, quote-free command line', async () => {
  const fake = FAKE_RUNNERS['claude-code']({ attach: 'connected' });
  const adapter = CONNECTORS['claude-code'].create(fake.deps);
  if (!(adapter instanceof ClaudeCodeAdapter)) throw new Error('the claude-code connector makes no ClaudeCodeAdapter');
  try {
    expect((await adapter.openAccountQuery('/repo', 2_000)).kind).toBe('answered');
    await expectShortCommandLines(fake.launched());
  } finally {
    adapter.dispose();
  }
});
