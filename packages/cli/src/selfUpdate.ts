import { spawn, spawnSync } from 'child_process';
import { accessSync, constants, realpathSync } from 'fs';
import { dirname, posix } from 'path';
import { installMethod, isSea, type SeaDeps } from '@ordewell/core';
import { cliVersion } from './version';

/**
 * `ordewell update` and the TUI's `/update`: update this copy the way it was
 * installed (ADR-0048; the install methods, ADR-0065 C9). It runs the one
 * command that install method's own tool would, on this terminal, and never
 * pings: whether a newer version exists is the version check's business, and
 * the tool asked knows which is the latest.
 *
 * A copy no command can update in place (an npx run, a project's own install,
 * a source checkout) is told what would, and nothing runs.
 */

/** The installer every release publishes, which `install.sh` on the site also serves. */
export const INSTALLER_URL = 'https://github.com/ordewell/ordewell/releases/latest/download/install.sh';

export interface SelfUpdateDeps {
  sea?: SeaDeps;
  /** The script node is running for an npm or source copy; `process.argv[1]` by default. */
  entry?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Runs a command on this terminal and resolves with its exit status; `input`, when given, is its stdin. */
  run?: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; shell?: boolean; input?: string }) => Promise<number>;
  /** Runs a command and returns what it printed, or null when it failed. */
  output?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; shell?: boolean }) => string | null;
  writable?: (dir: string) => boolean;
  download?: (url: string) => Promise<string>;
  say?: (line: string) => void;
  warn?: (line: string) => void;
}

/** One command `ordewell update` runs, and how it says it. */
interface Step {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  /** A script to download first and give the command as its stdin. */
  script?: string;
}

/** What `ordewell update` would do for this copy: run a step, or say why it runs none. */
export type UpdatePlan =
  | {
    kind: 'run';
    /** The step as a line the user could type themselves. */
    shown: string;
    step: Step;
    /** The command line of the copy the step leaves in place, which answers `--version` afterwards. */
    newCopy: string[];
  }
  | { kind: 'none'; message: string; status: number };

/** A word the shell reads as itself, quoted only when it would not. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

type Run = NonNullable<SelfUpdateDeps['run']>;
type Output = NonNullable<SelfUpdateDeps['output']>;

const runOnTerminal: Run = (command, args, { env, shell, input }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, shell, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
  child.on('error', reject);
  // A child a signal ended has no status of its own; it failed all the same.
  child.on('close', (status) => resolve(status ?? 1));
  child.stdin?.end(input);
});

const capture: Output = (command, args, options = {}) => {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
  return result.status === 0 ? result.stdout.trim() : null;
};

/**
 * Fetched whole before anything runs, rather than piped from curl into sh: a
 * pipe hides a failed download, and sh given nothing exits 0.
 */
async function fetchScript(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
  return response.text();
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function realPath(path: string, sea: SeaDeps): string {
  try {
    return (sea.realpath ?? realpathSync)(path);
  } catch {
    return path;
  }
}

/** What `ordewell update` would do here, decided before anything runs. */
export function planUpdate(deps: SelfUpdateDeps = {}): UpdatePlan {
  const sea = deps.sea ?? {};
  // The binary exists only for macOS and Linux, so its paths are POSIX ones.
  if (isSea(sea) && installMethod(sea) === 'homebrew') {
    // Brew links the Cellar's copy into its prefix's bin/, and an upgrade moves the link.
    const real = realPath(sea.execPath ?? process.execPath, sea);
    const cellar = real.indexOf('/Cellar/');
    return {
      kind: 'run',
      shown: 'brew upgrade ordewell',
      step: { command: 'brew', args: ['upgrade', 'ordewell'] },
      newCopy: [cellar >= 0 ? posix.join(real.slice(0, cellar), 'bin', 'ordewell') : 'ordewell'],
    };
  }
  if (isSea(sea)) {
    const dir = posix.dirname(realPath(sea.execPath ?? process.execPath, sea));
    if (!(deps.writable ?? isWritable)(dir)) {
      return {
        kind: 'none',
        status: 1,
        message: `${dir} is not writable, so this copy cannot replace itself there. To update it, run:\n`
          + `  curl -fsSL ${INSTALLER_URL} | sudo env ORDEWELL_INSTALL_DIR=${shellWord(dir)} sh`,
      };
    }
    return {
      kind: 'run',
      shown: `curl -fsSL ${INSTALLER_URL} | ORDEWELL_INSTALL_DIR=${shellWord(dir)} sh`,
      step: { command: 'sh', args: ['-s'], env: { ...(deps.env ?? process.env), ORDEWELL_INSTALL_DIR: dir }, script: INSTALLER_URL },
      newCopy: [posix.join(dir, 'ordewell')],
    };
  }
  return planNodeUpdate(deps, sea);
}

type NodeCopy =
  | { kind: 'npx' }
  | { kind: 'source'; dir: string }
  | { kind: 'npm'; entry: string; modules: string; pkg: string };

const slashed = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/** A copy node runs, judged by where its script really is. */
function nodeCopy(deps: SelfUpdateDeps, sea: SeaDeps): NodeCopy {
  const entry = realPath(deps.entry ?? process.argv[1] ?? '', sea);
  // npm exec keeps what it fetches in its cache's _npx/, and fetches anew when asked for @latest.
  if (slashed(entry).toLowerCase().includes('/_npx/')) return { kind: 'npx' };
  const installed = /^(.*?\/node_modules)\/(ordewell|@ordewell\/cli)\//.exec(slashed(entry));
  if (!installed) return { kind: 'source', dir: dirname(entry) };
  return { kind: 'npm', entry, modules: installed[1], pkg: installed[2] };
}

/**
 * How the update line tells this copy to update, `command` for one
 * `ordewell update` can. Decided by paths alone, since it runs on every start:
 * a project's own npm install is told apart only when the update runs.
 */
export function updateHint(command: string, deps: Pick<SelfUpdateDeps, 'sea' | 'entry'> = {}): string {
  const sea = deps.sea ?? {};
  if (isSea(sea)) return command;
  const copy = nodeCopy(deps, sea);
  if (copy.kind === 'npx') return '`npx ordewell@latest` runs it';
  if (copy.kind === 'source') return 'pull and rebuild this checkout';
  return command;
}

/**
 * Global npm puts the `ordewell` package, or `@ordewell/cli` installed on its
 * own, straight under `npm root -g`; anywhere else under node_modules is a
 * project's install, which a global one would not replace.
 */
function planNodeUpdate(deps: SelfUpdateDeps, sea: SeaDeps): UpdatePlan {
  const nothing = (message: string): UpdatePlan => ({ kind: 'none', status: 0, message: `${message} Nothing was run.` });
  const copy = nodeCopy(deps, sea);
  if (copy.kind === 'npx') {
    return nothing('This copy runs through npx, so there is no install to update: `npx ordewell@latest` runs the latest.');
  }
  if (copy.kind === 'source') {
    return nothing(`This copy runs from a source checkout or a development build (${copy.dir}): pull and rebuild it to update.`);
  }
  const windows = (deps.platform ?? process.platform) === 'win32';
  const comparable = (path: string) => (windows ? slashed(path).toLowerCase() : slashed(path));
  const npm = windows ? { command: 'npm.cmd', shell: true } : { command: 'npm' };
  const root = (deps.output ?? capture)(npm.command, ['root', '-g'], windows ? { shell: true } : undefined);
  if (root !== null && comparable(realPath(root.trim(), sea)) !== comparable(copy.modules)) {
    return nothing(`This copy is installed in the project at ${dirname(copy.modules)}: update it there with \`npm install ${copy.pkg}@latest\`.`);
  }
  const args = ['install', '-g', `${copy.pkg}@latest`];
  return {
    kind: 'run',
    shown: `npm ${args.join(' ')}`,
    step: { ...npm, args },
    newCopy: [sea.execPath ?? process.execPath, copy.entry],
  };
}

/** `ordewell update [--dry-run]`: resolves with the status to exit with. */
export async function runUpdate(args: string[], deps: SelfUpdateDeps = {}): Promise<number> {
  // Before the plan is made: a mistyped option must not start a real update.
  const bad = args.find((arg) => arg !== '--dry-run');
  if (bad !== undefined) {
    (deps.warn ?? console.error)(`${bad.startsWith('-') ? 'Unknown option' : 'Unexpected argument'}: ${bad}`);
    (deps.warn ?? console.error)('Run `ordewell update --help` for usage.');
    return 1;
  }
  const plan = planUpdate(deps);
  if (plan.kind === 'run' && args.includes('--dry-run')) {
    (deps.say ?? console.log)(`Would run: ${plan.shown}`);
    return 0;
  }
  return carryOutUpdate(plan, deps);
}

/** Runs what {@link planUpdate} decided, with the terminal, and names the version before and after. */
export async function carryOutUpdate(plan: UpdatePlan, deps: SelfUpdateDeps = {}): Promise<number> {
  const say = deps.say ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.error(line));
  if (plan.kind === 'none') {
    (plan.status === 0 ? say : warn)(plan.message);
    return plan.status;
  }
  const before = cliVersion(deps.sea);
  say(`Running: ${plan.shown}`);
  const { command, args: stepArgs, env, shell, script } = plan.step;
  let status: number;
  try {
    const input = script ? await (deps.download ?? fetchScript)(script) : undefined;
    status = await (deps.run ?? runOnTerminal)(command, stepArgs, { env, shell, input });
  } catch (err) {
    warn(`Could not update: ${(err as Error).message}`);
    return 1;
  }
  if (status !== 0) {
    warn(`The update exited with status ${status}.`);
    return status;
  }
  const [copy, ...copyArgs] = plan.newCopy;
  const after = (deps.output ?? capture)(copy, [...copyArgs, '--version']);
  say(after === null
    ? `Updated Ordewell ${before}, but ${plan.newCopy.join(' ')} --version did not answer.`
    : `Ordewell ${before} → ${after}`);
  return 0;
}
