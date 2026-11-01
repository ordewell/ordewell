import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { release, tmpdir, type as osType } from 'os';
import { basename, join, posix, relative, sep } from 'path';
import { augmentedPath } from '../../utils/shellPath';
import { refuseUnproven, type ExecutionBackend, type GuaranteeReport, type LeaseExit, type LeaseRecord, type LeaseRepo, type LeaseRequest, type LeaseSpec, type OpenLease, type PlacedLaunch, type ReservedLease, type RunnerLaunch } from '../executionLease';
import { defaultExecFile, git, type GitInvoker } from '../gitExec';
import { settleWithin } from '../harness/settleWithin';
import { CredentialBroker } from './credentialBroker';
import { CACHE_VARIABLES, parseContainerSettings, type ContainerSettings } from './containerSettings';
import { SpawnedDockerCli, type DockerCli } from './dockerCli';
import { judgeProbe, PROBE_SCRIPT, type ProbeAsked, type ProbeFindings } from './guaranteeProbe';
import { LeaseRelay, RELAY_ENTRY } from './leaseRelay';
import { hooksLandingWouldRun, PushRefused, restoreSnapshot, takeThroughGate } from './pushGate';
import { EXPORT_SCRIPT, exportRef, HOME_DIR, MIRROR_ROOT, mirrorDir, pinRefs, pushToMirror, repoDir, SEED_SCRIPT, TASK_ROOT, WORK_ROOT } from './taskWorkspace';

/** Limits every container takes, a helper's too; memory is the setting's. One count, so a fork bomb stays in its cgroup. */
const PIDS_LIMIT = 8192;

/** The image's unprivileged user. Named volumes take their owner from the image, so a task image is built for this one. */
const CONTAINER_USER = '1000:1000';

/** Each runner a container has been proven with. A protocol that needs this host's loopback or its own sandbox has not. */
const CONTAINER_RUNNERS: ReadonlySet<string> = new Set(['claude-code']);

/** A runner told to stop is bounded by its own interrupt grace; this bounds one that never said it ended. */
const RUNNER_GRACE_MS = 30_000;
const ENTRY_START_MS = 60_000;
const EXPORT_TIMEOUT_MS = 600_000;
/** Past any repository's worth of one attempt: what comes back is written to this host's disk. */
const MAX_BUNDLE_BYTES = 8 * 1024 ** 3;

/** A launch variable that names this host's own: the container has its own of each, and the docker CLI reads these. */
const STAYS_HERE = /^(HOME|PATH|DOCKER_.*)$/;

/**
 * How a lease's container reaches beyond itself, as the seam the egress sidecar
 * and the model gateway of L7 plug into: an internal network in `runArgs`, a
 * base URL in `env`. Today there is one path, the engine's default network, which
 * limits nothing: this lease alone is not the network guarantee.
 */
export interface EgressPath {
  runArgs(container: string): readonly string[];
  env(): Readonly<Record<string, string>>;
}

export const OPEN_EGRESS: EgressPath = { runArgs: () => [], env: () => ({}) };

export interface DockerBackendOptions {
  settings: ContainerSettings | { refused: string };
  sessionId: () => string;
  tell: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** What a worktree's bootstrap runs on this host. Absent, none. */
  setupCommand?: () => string | undefined;
  cli?: DockerCli;
  git?: GitInvoker;
  broker?: CredentialBroker;
  egress?: EgressPath;
}

/** One attempt's container, from its open until it has gone and its work has come back. */
interface Box {
  taskId: string;
  settings: ContainerSettings;
  name: string;
  volume: string;
  mirror: string;
  pin: string;
  /** The ref this attempt alone may bring back through the gate. */
  ref: string;
  /** What each repo stood on when its runner started. */
  bases: ReadonlyMap<string, string>;
  repos: readonly LeaseRepo[];
  cwd: string;
  credentials: Readonly<Record<string, string>>;
  relay: LeaseRelay;
  relayGone: boolean;
  launches: number;
  running: number;
  runnersGone: (() => void)[];
  closing: Promise<void> | null;
  bringing: Promise<void> | null;
  exit: LeaseExit | null;
}

/**
 * What a lease opens where (ADR-0059 L5). Planners and read-only tasks stay on
 * the host, under their envelope and their seal; a script's literal body and a
 * merge are not an agent's; a subplanner stays there too (ADR-0055). Work in the
 * user's checkout cannot be anywhere else, so it is refused: a user who asked for
 * a container does not get the host instead (L3).
 */
export function whereItRuns({ role }: LeaseRequest, { workspace }: LeaseSpec): 'host' | 'container' | { refused: string } {
  if (role !== 'task') return 'host';
  if (workspace.kind === 'checkout') return { refused: "this task works in your checkout, which a container cannot reach, so it did not start: turn containers off for it, or make it a task that runs in a worktree" };
  return workspace.intent === 'readOnly' ? 'host' : 'container';
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The first container backend (ADR-0059 L5, L6): the Docker API through the
 * docker CLI, around the local one, which keeps the slots and the worktrees.
 * The host's worktree stays where a task's result lives, so Landing, a repair
 * and a Continue are what they always were: the container gets a copy of it
 * through a mirror in the engine, and its work comes back through the push gate
 * before Landing runs. A lease that cannot be what was asked refuses; nothing
 * here runs on the host in a container's place.
 */
export class DockerExecutionBackend implements ExecutionBackend {
  private readonly cli: DockerCli;
  private readonly git: GitInvoker;
  private readonly broker: CredentialBroker;
  private readonly egress: EgressPath;
  private readonly boxes = new Map<string, Box>();
  private toldOfNetwork = false;

  constructor(private readonly local: ExecutionBackend, private readonly options: DockerBackendOptions) {
    this.cli = options.cli ?? new SpawnedDockerCli();
    this.git = options.git ?? { exec: defaultExecFile, resolvePath: () => augmentedPath() };
    this.broker = options.broker ?? new CredentialBroker(process.env);
    this.egress = options.egress ?? OPEN_EGRESS;
  }

  /** What a throwaway container proves, for a surface to report before any task runs. */
  async probe(): Promise<GuaranteeReport> {
    const settings = await this.preflight();
    const canary = this.plantCanary();
    try {
      const flags = [...this.limits(settings), '--network', 'none', '--tmpfs', `${TASK_ROOT}:uid=1000,gid=1000`];
      const asked: ProbeAsked = { hostPaths: [canary.file], deniedWrites: ['/', '/usr', '/etc', MIRROR_ROOT], workspace: TASK_ROOT, credentials: [] };
      const ran = await this.cli.call(['run', '--rm', ...flags, '-e', `ORDEWELL_PROBE=${JSON.stringify(asked)}`, settings.image, 'node', '-e', PROBE_SCRIPT]);
      return judgeProbe(this.findings(ran.stdout, ran.stderr), this.expected(settings, [TASK_ROOT, '/tmp']), new Date().toISOString());
    } finally {
      canary.remove();
    }
  }

  refusal(request: LeaseRequest): string | null {
    return this.local.refusal(request);
  }

  reserve(request: LeaseRequest): { lease: ReservedLease } | { refused: string } {
    const reserved = this.local.reserve(request);
    if ('refused' in reserved) return reserved;
    const { lease } = reserved;
    const opened: { box?: Box } = {};
    return {
      lease: {
        id: lease.id,
        holdsSlot: lease.holdsSlot,
        open: (spec, signal) => this.open(lease, request, spec, signal, opened),
        release: (reason) => {
          lease.release(reason);
          if (opened.box) this.ended(opened.box);
        },
      },
    };
  }

  private async open(lease: ReservedLease, request: LeaseRequest, spec: LeaseSpec, signal: AbortSignal, mine: { box?: Box }): Promise<OpenLease> {
    const place = whereItRuns(request, spec);
    if (place === 'host') return lease.open(spec, signal);
    if (place !== 'container') throw new Error(`This session runs tasks in containers, but ${place.refused}.`);
    if (!CONTAINER_RUNNERS.has(request.runner ?? '')) throw new Error(`This session runs tasks in containers, and ${request.runner ?? 'this runner'} has not been proven in one: assign the task to ${[...CONTAINER_RUNNERS].join(', ')}.`);
    const settings = await this.preflight();
    // A Continue restores what the worktree holds, so one started at once must not get there first. A refusal was said as it was refused.
    if (spec.task) await this.collect(spec.task.id).catch(() => undefined);
    const opened = await lease.open({ ...spec, required: [] }, signal);
    // Ended since its claim: the worktree is the attempt's to undo, as it undoes any it finds it no longer wants.
    if (signal.aborted) return opened;
    if (!opened.workspace.worktree || !opened.workspace.repos?.length) throw new Error('This session runs tasks in containers, and this run shares its workspace, which a container cannot reach. Start it with worktree isolation on.');
    const box = await this.start(spec.task!.id, settings, spec, opened, signal);
    if (!box) return opened;
    mine.box = box;
    return {
      ...opened,
      guarantees: box.report,
      placement: {
        place: (launch) => this.place(box, launch),
        reach: (url) => this.reach(box, url),
      },
      ended: async () => {
        await this.close(box);
        return box.exit;
      },
    };
  }

  /** Every check that spends nothing, before a worktree is made for a start that cannot go on. */
  private async preflight(): Promise<ContainerSettings> {
    const { settings } = this.options;
    if ('refused' in settings) throw new Error(`This session runs tasks in containers, but ${settings.refused}.`);
    if (this.options.setupCommand?.()) throw new Error('This session runs tasks in containers, and a worktree setup command is set (worktreeSetupCommand, ORDEWELL_WORKTREE_SETUP): it would run on this host, in what a container wrote. Unset it for this session.');
    const engine = await this.cli.call(['version', '--format', '{{.Server.Version}}']);
    if (engine.code !== 0) throw new Error(`This session runs tasks in containers, and Docker does not answer: ${engine.stderr.trim()}`);
    const image = await this.cli.call(['image', 'inspect', '--format', '{{.Id}}', settings.image]);
    if (image.code !== 0) throw new Error(`The image ${settings.image} is not there. Ordewell publishes no image: build it as docs/containers.md shows.`);
    if (settings.login.kind === 'own-sign-in') {
      const login = await this.cli.call(['volume', 'inspect', loginVolume()]);
      if (login.code !== 0) throw new Error(`The containers setting names your own sign-in, and none has been made: sign in as docs/containers.md shows, so it is kept in the ${loginVolume()} volume.`);
    }
    return settings;
  }

  private async start(taskId: string, settings: ContainerSettings, spec: LeaseSpec, opened: OpenLease, signal: AbortSignal): Promise<(Box & { report: GuaranteeReport }) | null> {
    const repos = opened.workspace.repos!;
    await this.refuseHooks(repos);
    const credentials = settings.login.kind === 'broker' ? this.broker.issue(settings.login.variables) : {};
    const key = digest(`${this.options.sessionId()}\0${taskId}`);
    const volume = `ordewell-task-${key}`;
    const mirror = await this.mirrorVolume(repos);
    await this.cli.call(['volume', 'create', '--label', `ordewell.session=${this.options.sessionId()}`, '--label', `ordewell.task=${taskId}`, volume]);
    const tips = await this.syncMirror(settings, mirror, key, repos);
    if (signal.aborted) return null;

    const name = `ordewell-${key}-${randomBytes(4).toString('hex')}`;
    const { caches, login } = this.mounts(settings, mirror);
    const startedAt = Date.now();
    const entry = await this.cli.entry([
      'run', '-i', '--rm', '--name', name, '--label', `ordewell.task=${taskId}`,
      ...this.limits(settings), ...this.egress.runArgs(name),
      '-v', `${volume}:${TASK_ROOT}`, '-v', `${mirror}:${MIRROR_ROOT}:ro`, ...caches, ...login,
      ...envArgs(this.containerEnv(settings)),
      settings.image, 'node', '-e', RELAY_ENTRY,
    ]);
    const relay = new LeaseRelay(entry);
    const box: Box & { report: GuaranteeReport } = {
      taskId, settings, name, volume, mirror, pin: key, ref: exportRef(name), bases: new Map(repos.map((repo) => [repo.path, tips.get(repo.path)!.head])), repos,
      cwd: posix.join(WORK_ROOT, relative(opened.workspace.writable ?? opened.workspace.cwd, opened.workspace.cwd).split(sep).join('/')),
      credentials, relay, relayGone: false, launches: 0, running: 0, runnersGone: [], closing: null, bringing: null, exit: null,
      report: opened.guarantees,
    };
    void relay.ended.then(() => { box.relayGone = true; });
    try {
      await settleWithin(relay.ready, { timeoutMs: ENTRY_START_MS, onTimeout: () => { throw new Error('The container did not start in time.'); } });
      console.error(`[container] ${name} up in ${Date.now() - startedAt}ms`);
      for (const repo of repos) await this.seed(box, repo, tips.get(repo.path)!);
      box.report = await this.prove(box, settings, opened.workspace.cwd, credentials);
      refuseUnproven([...spec.required, ...settings.required], box.report);
    } catch (err) {
      await this.cli.call(['rm', '-f', name]);
      throw err;
    }
    if (signal.aborted) {
      await this.cli.call(['rm', '-f', name]);
      return null;
    }
    this.boxes.set(taskId, box);
    this.tellOfNetwork(box.report);
    return box;
  }

  private async refuseHooks(repos: readonly LeaseRepo[]): Promise<void> {
    for (const repo of repos) {
      const hooks = await hooksLandingWouldRun(this.git, repo.worktree);
      if (hooks.length > 0) throw new Error(`This session runs tasks in containers, and ${repo.root} has git hooks (${hooks.join(', ')}) that landing would run on this host, over what a container wrote. Remove them or turn containers off for this repository.`);
    }
  }

  private tellOfNetwork(report: GuaranteeReport): void {
    if (this.toldOfNetwork || report['net.allowlist'].proven) return;
    this.toldOfNetwork = true;
    this.options.tell('warn', 'Tasks run in containers on this session, and their network is not limited yet: a container hides your files from a runner, not the internet from it.');
  }

  /** Limits and hardening for every container of a lease, in the order `docker run` reads them. */
  private limits(settings: ContainerSettings): string[] {
    return [
      '--init', '--pids-limit', String(PIDS_LIMIT), '--memory', settings.memory, '--memory-swap', settings.memory,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--user', CONTAINER_USER,
    ];
  }

  private mounts(settings: ContainerSettings, mirror: string): { caches: string[]; login: string[] } {
    const project = mirror.slice('ordewell-mirror-'.length);
    return {
      caches: settings.caches.flatMap((cache) => ['-v', `ordewell-cache-${project}-${cache}:/caches/${cache}`]),
      login: settings.login.kind === 'own-sign-in' ? ['-v', `${loginVolume()}:/login`] : [],
    };
  }

  private containerEnv(settings: ContainerSettings): Record<string, string> {
    return {
      HOME: HOME_DIR,
      // Behind a proxy Claude Code's memory grew until killed in user reports (ADR-0059 L7), and a task needs none of this traffic.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...Object.fromEntries(settings.caches.map((cache) => [CACHE_VARIABLES[cache], `/caches/${cache}`])),
      ...(settings.login.kind === 'own-sign-in' ? { CLAUDE_CONFIG_DIR: '/login/claude' } : {}),
      ...this.egress.env(),
    };
  }

  /** One volume for a repo group, by where git keeps the first repository: worktrees of it and later sessions share it. */
  private async mirrorVolume(repos: readonly LeaseRepo[]): Promise<string> {
    const commonDir = (await git(this.git, repos[0].root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const volume = `ordewell-mirror-${digest(commonDir)}`;
    await this.cli.call(['volume', 'create', volume]);
    return volume;
  }

  /** A throwaway container with no network and no agent ever in it, for what is done to a volume. */
  private helper(settings: ContainerSettings, volumes: readonly string[], variables: Readonly<Record<string, string>> = {}): string[] {
    return ['run', '--rm', '-i', ...this.limits(settings), '--network', 'none', ...volumes.flatMap((volume) => ['-v', volume]), ...envArgs({ HOME: HOME_DIR, ...variables }), settings.image];
  }

  /** What each repo's attempt starts from, pinned in its mirror for as long as the task's clone leans on it. */
  private async syncMirror(settings: ContainerSettings, mirror: string, pin: string, repos: readonly LeaseRepo[]): Promise<Map<string, { head: string; integration: string; name: string; email: string }>> {
    const helper = this.helper(settings, [`${mirror}:${MIRROR_ROOT}`]);
    const tips = new Map<string, { head: string; integration: string; name: string; email: string }>();
    for (const repo of repos) {
      const head = (await git(this.git, repo.worktree, ['rev-parse', 'HEAD'])).trim();
      const integration = (await git(this.git, repo.root, ['rev-parse', repo.integrationBranch])).trim();
      await pushToMirror(this.git, repo, helper, pinRefs(pin, head, integration));
      const name = await this.identity(repo, 'user.name', 'Ordewell');
      const email = await this.identity(repo, 'user.email', 'ordewell@localhost');
      tips.set(repo.path, { head, integration, name, email });
    }
    return tips;
  }

  private async identity(repo: LeaseRepo, key: string, fallback: string): Promise<string> {
    return (await git(this.git, repo.root, ['config', '--get', key]).catch(() => '')).trim() || fallback;
  }

  private async seed(box: Box, repo: LeaseRepo, tip: { name: string; email: string }): Promise<void> {
    const variables = { ORDEWELL_REPO_DIR: repoDir(repo), ORDEWELL_MIRROR: mirrorDir(repo), ORDEWELL_PIN: box.pin, ORDEWELL_BRANCH: repo.branch, ORDEWELL_INTEGRATION: repo.integrationBranch, ORDEWELL_GIT_NAME: tip.name, ORDEWELL_GIT_EMAIL: tip.email };
    const seeded = await this.cli.call(['exec', ...envArgs(variables), box.name, 'sh', '-c', SEED_SCRIPT]);
    if (seeded.code !== 0) throw new Error(`Could not put the task's work in its container: ${seeded.stderr.trim()}`);
  }

  private plantCanary(): { file: string; remove: () => void } {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ordewell-canary-'));
    const file = join(dir, 'canary');
    writeFileSync(file, randomBytes(16).toString('hex'));
    return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
  }

  private expected(settings: ContainerSettings, mounts: readonly string[]) {
    return { mounts, memoryBytes: settings.memoryBytes, pids: PIDS_LIMIT, hostKernel: `${osType()} ${release()}` };
  }

  private findings(stdout: string, stderr: string): ProbeFindings {
    try {
      return JSON.parse(stdout) as ProbeFindings;
    } catch {
      throw new Error(`The container's guarantees could not be proven: its probe said nothing readable${stderr.trim() ? ` (${stderr.trim()})` : ''}.`);
    }
  }

  /** L3: the proof is a run in the container, as its runner will run, with what its runner will hold. */
  private async prove(box: Box, settings: ContainerSettings, hostCwd: string, credentials: Readonly<Record<string, string>>): Promise<GuaranteeReport> {
    const canary = this.plantCanary();
    try {
      const login = settings.login.kind === 'own-sign-in' ? '/login/claude' : undefined;
      const asked: ProbeAsked = { hostPaths: [canary.file, hostCwd], deniedWrites: ['/', '/usr', '/etc', MIRROR_ROOT], workspace: WORK_ROOT, credentials: Object.keys(credentials), ...(login ? { login } : {}) };
      const names = Object.keys(credentials).flatMap((variable) => ['-e', variable]);
      const ran = await this.cli.call(['exec', '-e', `ORDEWELL_PROBE=${JSON.stringify(asked)}`, ...names, box.name, 'node', '-e', PROBE_SCRIPT], { env: credentials });
      const mounts = [TASK_ROOT, MIRROR_ROOT, '/tmp', ...settings.caches.map((cache) => `/caches/${cache}`), ...(login ? ['/login'] : [])];
      return judgeProbe(this.findings(ran.stdout, ran.stderr), this.expected(settings, mounts), new Date().toISOString());
    } finally {
      canary.remove();
    }
  }

  /** The runner by exec, so the container's one idle entry outlives each spawn; a variable goes by name, its value in the CLI's environment. */
  private async place(box: Box, launch: RunnerLaunch): Promise<PlacedLaunch> {
    const launchNumber = ++box.launches;
    const moved = new Map<string, string>();
    for (const file of launch.files) {
      const inside = `/tmp/ordewell/${launchNumber}-${basename(file)}`;
      const wrote = await this.cli.call(['exec', '-i', box.name, 'sh', '-c', 'umask 077; mkdir -p /tmp/ordewell; cat > "$0"', inside], { input: readFileSync(file) });
      if (wrote.code !== 0) throw new Error(`Could not hand the runner its configuration: ${wrote.stderr.trim()}`);
      moved.set(file, inside);
    }
    const env = { ...Object.fromEntries(Object.entries(launch.env).filter(([variable]) => !STAYS_HERE.test(variable))), ...box.credentials };
    const pidFile = `/tmp/ordewell/${launchNumber}.pid`;
    box.running += 1;
    return {
      command: 'docker',
      args: [
        'exec', '-i', '-w', box.cwd, ...Object.keys(env).flatMap((variable) => ['-e', variable]), box.name,
        'sh', '-c', 'mkdir -p /tmp/ordewell; echo $$ > "$0"; exec "$@"', pidFile, launch.command, ...launch.args.map((arg) => moved.get(arg) ?? arg),
      ],
      env,
      // A killed `docker exec` leaves its process running in the container.
      stop: () => { void this.cli.call(['exec', box.name, 'sh', '-c', 'kill -KILL "$(cat "$0")"', pidFile]); },
      ended: () => {
        box.running -= 1;
        if (box.running === 0) for (const wake of box.runnersGone.splice(0)) wake();
      },
    };
  }

  /** `endpoints.mcp` (L6): the same URL, since the relay listens on the same port of the container's own loopback, and the server's Host check still holds. */
  private async reach(box: Box, url: string): Promise<string> {
    const port = Number(new URL(url).port);
    await box.relay.forward(port, port);
    return url;
  }

  /** An attempt's lease has ended. A kept worktree's `letGo` decides what follows; a landed one has no `letGo` to come (ADR-0059 L1). */
  private ended(box: Box): void {
    void this.close(box).then(async () => {
      // Only a landing says so: a task with no record may be a restore between its worktrees, and its session is in this volume.
      const record = (await this.local.list()).find((candidate) => candidate.taskId === box.taskId);
      if (record?.status !== 'merged') return;
      await this.dropVolume(box.taskId);
      if (this.boxes.get(box.taskId) === box) this.boxes.delete(box.taskId);
    }).catch((err: unknown) => this.options.tell('warn', `Could not clear the container of task ${box.taskId}: ${errorText(err)}`));
  }

  /**
   * The container goes once its runner has: what a stop winds down may still
   * report and save. Everything in it goes too, a background job included, so
   * nothing of the attempt is alive when its work is read.
   */
  private close(box: Box): Promise<void> {
    box.closing ??= (async () => {
      if (box.running > 0) {
        await settleWithin(new Promise<void>((wake) => { box.runnersGone.push(wake); }), { timeoutMs: RUNNER_GRACE_MS, onTimeout: () => undefined });
      }
      box.exit = await this.exitOf(box);
      await this.cli.call(['rm', '-f', box.name]);
      await settleWithin(box.relay.ended, { timeoutMs: RUNNER_GRACE_MS, onTimeout: () => undefined });
      if (box.exit === 'oom') this.options.tell('error', `Something in the container of task ${box.taskId} was killed for passing its memory limit. Raise containers.memory if it needs more.`);
      if (box.exit === 'killed') this.options.tell('error', `The container of task ${box.taskId} went before its task ended.`);
    })();
    return box.closing;
  }

  private async exitOf(box: Box): Promise<LeaseExit | null> {
    if (box.relayGone) return 'killed';
    const events = await this.cli.call(['exec', box.name, 'cat', '/sys/fs/cgroup/memory.events']);
    return /^oom_kill [1-9]/m.test(events.stdout) ? 'oom' : null;
  }

  /**
   * A task's work reaches its worktree after its attempt has ended, so whatever
   * reads that worktree next waits here: a landing and the task's next attempt.
   */
  async collect(taskId: string): Promise<void> {
    const box = this.boxes.get(taskId);
    if (!box) return;
    await this.close(box);
    await this.bringBack(box);
  }

  /**
   * The attempt's work, every repo through the gate before any is touched, as a
   * landing is the whole task or none of it. Once per attempt: a refusal stands.
   */
  private bringBack(box: Box): Promise<void> {
    box.bringing ??= (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ordewell-export-'));
      try {
        const taken: { repo: LeaseRepo; snapshot: string }[] = [];
        for (const repo of box.repos) taken.push({ repo, snapshot: await this.take(box, repo, join(dir, `${taken.length}.bundle`)) });
        for (const { repo, snapshot } of taken) await restoreSnapshot(this.git, repo.worktree, snapshot, repo.linked);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    return box.bringing;
  }

  private async take(box: Box, repo: LeaseRepo, file: string): Promise<string> {
    const base = box.bases.get(repo.path)!;
    // The clone leans on the mirror's objects, so it is read through it, as the attempt read it.
    const helper = this.helper(box.settings, [`${box.volume}:${TASK_ROOT}`, `${box.mirror}:${MIRROR_ROOT}:ro`], { ORDEWELL_REPO_DIR: repoDir(repo), ORDEWELL_REF: box.ref, ORDEWELL_BASE: base });
    const ran = await this.cli.call([...helper, 'sh', '-c', EXPORT_SCRIPT], { stdoutTo: { file, maxBytes: MAX_BUNDLE_BYTES }, timeoutMs: EXPORT_TIMEOUT_MS });
    if (ran.overflowed) throw new PushRefused('it is larger than any one attempt\'s work should be');
    if (ran.code !== 0) throw new Error(`Could not read the attempt's work out of its volume: ${ran.stderr.trim()}`);
    return takeThroughGate(this.git, repo.root, file, { ref: box.ref, base });
  }

  private async dropVolume(taskId: string): Promise<void> {
    const volume = `ordewell-task-${digest(`${this.options.sessionId()}\0${taskId}`)}`;
    await this.cli.call(['volume', 'rm', '-f', volume]);
  }

  async letGo(taskId: string, how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void> {
    // What refused it has been said; it is why the work stays where it is, not a reason to keep the worktree.
    await how.landing?.then(() => undefined, () => undefined);
    const box = this.boxes.get(taskId);
    if (box) {
      await this.close(box);
      if (how.keep) await this.bringBack(box).catch((err: unknown) => this.options.tell('warn', `The work of task ${taskId} stays in its container's volume: ${errorText(err)}`));
      if (this.boxes.get(taskId) === box) this.boxes.delete(taskId);
    }
    if (!how.keep) await this.dropVolume(taskId);
    return this.local.letGo(taskId, { ...how, landing: null });
  }

  list(): Promise<readonly LeaseRecord[]> {
    return this.local.list();
  }
}

/** Not secrets: what is goes by name, in the CLI's environment. */
const envArgs = (variables: Readonly<Record<string, string>>): string[] => Object.entries(variables).flatMap(([variable, value]) => ['-e', `${variable}=${value}`]);

/** A person's own sign-in, for the one runner proven in a container. */
const loginVolume = (): string => 'ordewell-login-claude-code';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `containers` setting as the seam's `execution`: a Session's own backend, around its own local one. */
export function containerExecution(raw: unknown): (local: ExecutionBackend, context: Pick<DockerBackendOptions, 'sessionId' | 'tell' | 'setupCommand'>) => ExecutionBackend {
  return (local, context) => new DockerExecutionBackend(local, { settings: parseContainerSettings(raw), ...context });
}
