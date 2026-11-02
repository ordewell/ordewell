import { parseContainerSettings, type ContainerSettings } from './containerSettings';
import { CONTAINER_RUNNERS, containerRunner, CONTAINER_RUNNER_IDS, type ContainerRunner } from './containerRunners';
import type { CredentialBroker } from './credentialBroker';
import type { DockerCli, DockerResult } from './dockerCli';

/** Why a container cannot be had yet, and what a person does about it. */
export interface ContainerProblem {
  code: string;
  message: string;
  remedy: string;
}

/** What the engine a lease would use said of itself. */
export interface EngineFacts {
  version: string;
  endpoint: string;
  /** What the engine has, which on a Mac is its VM's and not the Mac's. */
  memoryBytes: number;
}

export interface EngineCheck {
  problems: ContainerProblem[];
  /** Absent where it could not be asked, or what it said rules it out. */
  engine?: EngineFacts;
}

export interface PreflightDeps {
  cli: DockerCli;
  /** This host's, and a test's own. */
  platform?: NodeJS.Platform;
}

export interface ReadinessDeps extends PreflightDeps {
  broker: CredentialBroker;
  /** False for a script, whose container holds no login at all. */
  agent?: boolean;
  /** Whose task this is for, when the caller knows: its sign-in and its binary are asked of that runner alone. */
  runner?: string;
  setupCommand?: string;
}

export interface Readiness extends EngineCheck {
  /** Absent for a setting that cannot be used as it stands. */
  settings?: ContainerSettings;
}

/** Where a person's own sign-in is kept: theirs, made in a container, and never read here (ADR-0059 L7). */
export const LOGIN_VOLUME = CONTAINER_RUNNERS.get('claude-code')!.signIn.volume;

/** A surface waits on this, and an engine that hangs is one to report, not to wait for. */
const ASK_MS = 15_000;

const INSTALL: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Install Docker Desktop, or Colima with `brew install colima docker` and then `colima start`.',
  linux: 'Install Docker Engine (https://docs.docker.com/engine/install/) and start it with `sudo systemctl start docker`.',
};

const START: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Open Docker Desktop, or run `colima start`, and wait for it to finish starting.',
  linux: 'Start it with `sudo systemctl start docker`.',
};

const denied = (said: DockerResult): boolean => /permission denied/i.test(said.stderr);

const problem = (code: string, message: string, remedy: string): ContainerProblem => ({ code, message, remedy });

const refused = (code: string, message: string, remedy: string): EngineCheck => ({ problems: [problem(code, message, remedy)] });

const LOCAL_CONTEXT = 'Run `docker context use` with a context on this machine, and clear DOCKER_HOST if it is set.';

const CGROUP_V1 = 'Boot the host with cgroup v2, by adding `systemd.unified_cgroup_hierarchy=1` to the kernel command line or moving to a distribution that defaults to it.';

/**
 * Whether this host has a Docker this product can use, asking nothing of the
 * image or login a person chooses later, so turning containers on can be held to
 * it alone. It starts nothing. `code` -1 is the only sign of a CLI that is not
 * there: a daemon that is down says "no such file" of its socket too.
 *
 * The endpoint is judged from `docker context inspect`, which already answers for
 * DOCKER_HOST and the current context. An engine elsewhere is refused because the
 * proofs would be hollow on it: the host's paths and loopback are not its own
 * (ADR-0059 L3). A `unix://` socket is taken for a local engine, an assumption
 * that `CONTAINER_ASSUMPTIONS` states: a socket forwarded from elsewhere looks
 * the same.
 */
export async function inspectEngine({ cli, platform = process.platform }: PreflightDeps): Promise<EngineCheck> {
  const install = INSTALL[platform];
  const start = START[platform];
  if (install === undefined || start === undefined) {
    return refused('platform-unsupported', `Containers have only been proven on Linux and macOS, and this host is ${platform}.`, 'Run Ordewell on Linux, or on a Mac with Docker Desktop or Colima.');
  }
  const ask = (args: readonly string[]) => cli.call(args, { timeoutMs: ASK_MS });
  const context = await ask(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (context.code === -1) return refused('docker-missing', 'The docker command was not found.', install);
  const endpoint = context.stdout.trim();
  if (context.code !== 0) return refused('engine-remote', `Docker could not say which engine it would use: ${context.stderr.trim()}`, LOCAL_CONTEXT);
  if (!endpoint.startsWith('unix://')) return refused('engine-remote', `Docker is set to use the engine at ${endpoint}, which is not on this machine.`, LOCAL_CONTEXT);
  const version = await ask(['version', '--format', '{{.Server.Version}}']);
  if (version.code === -1) return refused('docker-missing', 'The docker command was not found.', install);
  if (denied(version)) {
    return refused('engine-denied', `Docker refused this user: ${version.stderr.trim()}`, 'Add this user to the docker group, which is as good as root on this machine, or run Docker in rootless mode.');
  }
  if (version.code !== 0) return refused('engine-down', `The Docker engine does not answer: ${version.stderr.trim()}`, start);
  const info = await ask(['info', '--format', '{{.OSType}}|{{.CgroupVersion}}|{{.MemTotal}}']);
  const [os, cgroup, memory] = info.stdout.trim().split('|');
  if (info.code !== 0) return refused('engine-unreadable', `The Docker engine would not describe itself: ${info.stderr.trim()}`, start);
  if (os === 'windows') return refused('platform-unsupported', 'This engine runs Windows containers, and only Linux ones have been proven.', 'Switch the engine to Linux containers.');
  const memoryBytes = Number(memory);
  if (os !== 'linux' || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || (cgroup !== '1' && cgroup !== '2')) {
    return refused('engine-unreadable', `The Docker engine described itself in a way this cannot read: ${info.stdout.trim()}`, 'Update Docker, and start the engine again.');
  }
  if (cgroup === '1') return refused('cgroup-v1', 'This engine uses cgroup v1, and the memory limit can only be proven on cgroup v2.', CGROUP_V1);
  return { problems: [], engine: { version: version.stdout.trim(), endpoint, memoryBytes } };
}

/**
 * What no check here measures, and what a surface must say is taken on trust, so
 * nobody reads it as proven. Beside them sit the guarantees a probe measured, which
 * are the only ones proven (ADR-0059 L3).
 */
export const CONTAINER_ASSUMPTIONS: readonly string[] = [
  'The engine behind a unix:// socket is on this machine: a socket forwarded from elsewhere looks the same.',
  'Containers on an engine share one kernel, this host\'s on Linux and the VM\'s on a Mac. kernel.separate means separate from this host, never from another task: a kernel flaw reaches every task on the engine.',
  'A task has limits on memory and processes, and none on CPU or disk.',
  `Only ${CONTAINER_RUNNER_IDS.join(' and ')} have been proven as runners in a container: another runner's task refuses at start.`,
];

/** Where a runner's sign-in is kept, as the one thing to do about it. */
export function signInRemedy(runner: ContainerRunner): string {
  return `Sign in as docs/containers.md shows, so ${runner.id}'s is kept in the ${runner.signIn.volume} volume.`;
}

export const SIGN_IN_REMEDY = signInRemedy(CONTAINER_RUNNERS.get('claude-code')!);

const MEMORY_REMEDY: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Give the engine more with `colima stop && colima start --memory 8`, or Docker Desktop\'s Settings > Resources, or lower containers.memory.',
};

/** What is yet to be chosen, as its own items: containers can be on with nothing chosen, and every task refuses until it is. */
function readSetting(raw: unknown): { problems: ContainerProblem[]; settings?: ContainerSettings } {
  const { image, login } = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : { image: '', login: {} };
  const unset = [
    ...(image === undefined ? [problem('image-unset', 'No image has been chosen.', 'Build one as docs/containers.md shows, and name it in containers.image.')] : []),
    ...(login === undefined ? [problem('login-unset', 'No login has been chosen.', 'Choose "own-sign-in", or "broker" with the variables to hand over, in containers.login.')] : []),
  ];
  if (unset.length > 0) return { problems: unset };
  const settings = parseContainerSettings(raw);
  if ('refused' in settings) return { problems: [problem('setting-refused', `The containers setting cannot be used: ${settings.refused}.`, 'Correct it in the settings file.')] };
  return { problems: [], settings };
}

async function loginProblems(settings: ContainerSettings, cli: DockerCli, broker: CredentialBroker, runner: string | undefined): Promise<ContainerProblem[]> {
  if (settings.login.kind === 'own-sign-in') {
    // A surface knows no task's runner, so it is satisfied by any runner's sign-in; a lease knows its own and asks only for that.
    const wanted = runner === undefined ? [...CONTAINER_RUNNERS.values()] : [containerRunner(runner)].filter((entry): entry is ContainerRunner => entry !== null);
    if (wanted.length === 0) return [problem('runner-unknown', `${runner} has not been proven in a container.`, `Assign the task to ${CONTAINER_RUNNER_IDS.join(' or ')}.`)];
    const made: ContainerRunner[] = [];
    for (const entry of wanted) {
      const kept = await cli.call(['volume', 'inspect', entry.signIn.volume], { timeoutMs: ASK_MS });
      if (kept.code === 0) made.push(entry);
    }
    if (made.length > 0) return [];
    const remedy = wanted.map(signInRemedy).join(' ');
    return [problem('sign-in-missing', `The containers setting names your own sign-in, and none has been made for ${wanted.map((entry) => entry.id).join(' or ')}.`, remedy)];
  }
  try {
    broker.issue(settings.login.variables);
    return [];
  } catch (err) {
    return [problem('login-unavailable', err instanceof Error ? err.message : String(err), 'Set it in the environment Ordewell starts from, or use the "own-sign-in" login.')];
  }
}

/**
 * Whether the image has the runner on it. A lease asks this before it makes a
 * worktree: an image built for one runner starts no other, and the alternative
 * is a server that never comes up after an attempt has been spent on it.
 */
async function runnerInImage(settings: ContainerSettings, cli: DockerCli, runner: ContainerRunner): Promise<ContainerProblem[]> {
  const asked = await cli.call(['run', '--rm', '--network', 'none', '--user', '1000:1000', '--entrypoint', 'sh', settings.image, '-c', `command -v ${runner.binary}`], { timeoutMs: ASK_MS });
  if (asked.code === 0) return [];
  return [problem('runner-missing', `The image ${settings.image} has no ${runner.binary} on its PATH, so a ${runner.id} task cannot start in it.`, `Add ${runner.binary} to the image, as docs/containers.md shows, and build it again.`)];
}

/**
 * Whether a task could start now: the engine, and all a person chose on it. What
 * only a start can know stays with the lease: its repositories' hooks, its
 * runner, and the guarantees a container proves (ADR-0059 L3). A surface and a
 * lease both ask this, so what one reports is what the other refuses. A script
 * is asked nothing of the login it never gets. Nothing here reads a sign-in, or
 * pulls: an image is what a person built. A lease that names its runner starts
 * the image once, with no network, to ask whether the runner is on it.
 */
export async function inspectReadiness(raw: unknown, { cli, platform, broker, agent = true, runner, setupCommand }: ReadinessDeps): Promise<Readiness> {
  const { problems: engineProblems, engine } = await inspectEngine({ cli, ...(platform ? { platform } : {}) });
  const { problems: settingProblems, settings } = readSetting(raw);
  const setup = setupCommand ? [problem('setup-command', 'A worktree setup command is set: it would run on this host, in what a container wrote.', 'Unset worktreeSetupCommand and ORDEWELL_WORKTREE_SETUP for this session.')] : [];
  const problems = [...engineProblems, ...settingProblems, ...setup];
  if (!engine || !settings) return { problems, ...(engine ? { engine } : {}) };
  if (settings.memoryBytes > engine.memoryBytes) {
    problems.push(problem('memory-over-engine', `containers.memory is ${settings.memory}, and this engine has ${Math.floor(engine.memoryBytes / 1024 ** 2)} MiB: Docker would accept that limit, and it would limit nothing.`, MEMORY_REMEDY[platform ?? process.platform] ?? 'Lower containers.memory.'));
  }
  const image = await cli.call(['image', 'inspect', '--format', '{{.Id}}', settings.image], { timeoutMs: ASK_MS });
  if (image.code !== 0) problems.push(problem('image-missing', `The image ${settings.image} is not there.`, 'Ordewell publishes no image: build it as docs/containers.md shows.'));
  if (agent) {
    problems.push(...await loginProblems(settings, cli, broker, runner));
    const chosen = containerRunner(runner);
    if (image.code === 0 && chosen) problems.push(...await runnerInImage(settings, cli, chosen));
  }
  return { problems, engine, ...(problems.length === 0 ? { settings } : {}) };
}

/** Problems as one error for a person to read. */
export const describeProblems = (problems: readonly ContainerProblem[]): string => problems.map(({ message, remedy }) => [message.replace(/\.?$/, '.'), remedy].filter(Boolean).join(' ')).join(' ');
