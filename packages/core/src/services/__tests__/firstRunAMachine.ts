import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { runnerCommand } from '../../plugins/types';
import { pathWithFake } from '../../testEnv';

/**
 * The agents of a first-run machine, as fake CLIs on PATH (the first-run
 * journey tests, machine A: Claude Code signed out, Codex signed in, GitHub
 * Copilot CLI older than Ordewell needs). Each fake answers `--version` and its
 * own sign-in status command the way the real CLI does, so the manifests'
 * readers (`claude auth status`, `codex login status`) judge them as they
 * would the real ones. Every other built-in agent's command answers nothing,
 * so an agent really installed on the host cannot stand in for one the
 * machine does not have.
 */

/** One installed agent: the version it prints and, where it has a status command, its sign-in. */
export interface FakeAgent {
  version: string;
  /** Read by `claude auth status` and `codex login status`; the other agents have no status command to answer. */
  signedIn?: boolean;
}

/** The agents installed, by command (`claude`, `codex`, `copilot`, `opencode`, `pi`). */
export type MachineAgents = Partial<Record<string, FakeAgent>>;

/** Machine A, as the first-time user reported it. */
export function machineA(): MachineAgents {
  return {
    claude: { version: '2.1.3 (Claude Code)', signedIn: false },
    codex: { version: 'codex-cli 0.98.0', signedIn: true },
    // Older than the 1.0.105 Copilot's ACP profile was checked against.
    copilot: { version: 'GitHub Copilot CLI 1.0.50', signedIn: undefined },
  };
}

/** Machine B's sign-ins: Claude Code signed in, Codex signed out. */
export function machineBSignIns(): MachineAgents {
  return {
    claude: { version: '2.1.3 (Claude Code)', signedIn: true },
    codex: { version: 'codex-cli 0.98.0', signedIn: false },
  };
}

export interface StagedMachine {
  bin: string;
  /** The PATH on which every built-in agent's command starts its fake here. */
  PATH: string;
  /**
   * Change what the agents answer from the next call on, as a login or logout
   * in another terminal does. Only an agent staged at the start can answer.
   */
  set(agents: MachineAgents): void;
  /** What the agents answer now. */
  agents(): MachineAgents;
}

const FAKE = `'use strict';
const fs = require('fs');
const path = require('path');
const [command, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'agents.json'), 'utf8'));
const agent = state[command];
const say = (text) => process.stdout.write(text + '\\n');
if (!agent) { process.stderr.write(command + ': command not found\\n'); process.exit(127); }
if (args[0] === '--version' || args[0] === 'version') { say(agent.version); process.exit(0); }
if (command === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  say(JSON.stringify(agent.signedIn
    ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
  process.exit(agent.signedIn ? 0 : 1);
}
if (command === 'codex' && args[0] === 'login' && args[1] === 'status') {
  if (agent.signedIn) { say('Logged in using ChatGPT'); process.exit(0); }
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
process.stderr.write(command + ': nothing to do for ' + args.join(' ') + '\\n');
process.exit(1);
`;

/** Every built-in agent's command, so each one the machine lacks is answered by a fake that is not installed. */
function agentCommands(): string[] {
  const commands = BUILTIN_MANIFESTS.map((manifest) => runnerCommand(manifest)).filter((command): command is string => Boolean(command));
  return [...new Set(commands)];
}

/**
 * Write the fakes into `<dir>/agents-bin` and return the PATH that starts
 * them: a POSIX shim beside a `.cmd` and a `.ps1`, so Windows starts the same
 * script (ADR-0010). The caller puts `PATH` on the environment.
 */
export function stageMachine(dir: string, agents: MachineAgents): StagedMachine {
  const bin = join(dir, 'agents-bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'fake-agent.cjs');
  writeFileSync(script, FAKE);
  const state = join(bin, 'agents.json');
  const set = (next: MachineAgents) => writeFileSync(state, JSON.stringify(next));
  set(agents);

  let PATH = process.env.PATH ?? '';
  for (const command of agentCommands()) {
    // An agent the machine lacks starts no Node at all: a probe of every
    // agent at once must not crowd out the ones that are installed. One the
    // machine has is the script, so a test can install it later with `set`.
    const posix = join(bin, command);
    const node = command in agents;
    writeFileSync(posix, node ? `#!/bin/sh\nexec "${process.execPath}" "${script}" ${command} "$@"\n` : '#!/bin/sh\nexit 127\n');
    chmodSync(posix, 0o755);
    writeFileSync(join(bin, `${command}.cmd`), node ? `@"${process.execPath}" "${script}" ${command} %*\r\n` : '@exit /b 127\r\n');
    writeFileSync(join(bin, `${command}.ps1`), node ? `& "${process.execPath}" "${script}" ${command} @args\r\nexit $LASTEXITCODE\r\n` : 'exit 127\r\n');
    PATH = pathWithFake(bin, command, PATH);
  }
  // Each call put the directory first again; once is enough.
  PATH = [bin, ...PATH.split(delimiter).filter((entry) => entry && entry !== bin)].join(delimiter);

  return {
    bin,
    PATH,
    set,
    agents: () => JSON.parse(readFileSync(state, 'utf8')) as MachineAgents,
  };
}

/** The fresh two-file project of the report. */
export function writeTwoFileProject(workspace: string): void {
  mkdirSync(join(workspace, '.git'), { recursive: true });
  writeFileSync(join(workspace, 'hello.py'), 'print("hello")\n');
  writeFileSync(join(workspace, 'README.md'), '# hello\n\nPrints a greeting.\n');
}
