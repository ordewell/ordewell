import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, posix, relative, sep } from 'path';
import { augmentedPath } from '../../utils/shellPath';
import { CHECKOUT_BRANCH, KeptWorkError, refuseUnproven, type ExecutionBackend, type GuaranteeReport, type LeaseExit, type LeaseRecord, type LeaseRepo, type LeaseRequest, type LeaseSpec, type OpenLease, type PlacedLaunch, type ReservedLease, type RunnerLaunch } from '../executionLease';
import { defaultExecFile, git, tryGit, type GitInvoker } from '../gitExec';
import { SELF_REPO } from '../isolationRecord';
import { settleWithin } from '../harness/settleWithin';
import { CredentialBroker, type IssuedLogin } from './credentialBroker';
import { describeProblems, inspectReadiness } from './containerPreflight';
import { CONTAINER_RUNNER_IDS, brokerRefusal, containerRunner, modelHosts, signInRemedy, type ContainerRunner, type ContainerSignIn } from './containerRunners';
import { networkAsked, probeExpected, probeFindings, proveEngine, withCanaries } from './containerProof';
import { CACHE_VARIABLES, CLI_READS, containerLimits, envArgs, helperArgs, parseContainerSettings, type ContainerSettings } from './containerSettings';
import { SpawnedDockerCli, type DockerCli } from './dockerCli';
import { NO_WAY_OUT, SidecarEgress, type EgressPath, type EgressRoute } from './egressSidecar';
import { judgeProbe, PROBE_SCRIPT, type ProbeAsked } from './guaranteeProbe';
import { LeaseRelay, RELAY_ENTRY } from './leaseRelay';
import { MODEL_APIS } from './modelGateway';
import { reclaimTree, TREE_LABEL, treePins } from './reclaim';
import { hooksLandingWouldRun, PushRefused, restoreSnapshot, takeThroughGate } from './pushGate';
import { EXPORT_SCRIPT, exportRef, HOME_DIR, MIRROR_ROOT, mirrorDir, pinRefs, pushToMirror, repoDir, SEED_SCRIPT, TASK_ROOT, WORK_ROOT } from './taskWorkspace';

/** A runner told to stop is bounded by its own interrupt grace; this bounds one that never said it ended. */
const RUNNER_GRACE_MS = 30_000;
const ENTRY_START_MS = 60_000;
const EXPORT_TIMEOUT_MS = 600_000;
/** Past any repository's worth of one attempt: what comes back is written to this host's disk. */
const MAX_BUNDLE_BYTES = 8 * 1024 ** 3;

/** A regular file within the size a board reads: a pipe there would never end the read. By `./`, since a path may start with a dash and `find` has no `--`. */
const BLOB_SCRIPT = `file="./$0"; [ -n "$(find -P "$file" -maxdepth 0 -type f -size -16385k 2>/dev/null)" ] && exec git hash-object --no-filters -- "$file"`;

export interface DockerBackendOptions {
  /** As it stands in the settings file: read again at each start, so a check there and at a surface are one check. */
  settings: unknown;
  sessionId: () => string;
  /** The root of this Session's tree, which what a lease leaves in the engine is labelled by. Absent, the Session is one. */
  treeId?: () => string;
  tell: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** What a worktree's bootstrap runs on this host. Absent, none. */
  setupCommand?: () => string | undefined;
  cli?: DockerCli;
  git?: GitInvoker;
  broker?: CredentialBroker;
  egress?: EgressPath;
}

/** What a container starts from, once the lease's checks have passed. */
interface Starting {
  /** A task's, with a login; a script has none. */
  runner: ContainerRunner | null;
  settings: ContainerSettings;
  spec: LeaseSpec;
  opened: OpenLease;
  repos: readonly LeaseRepo[];
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
  /** What a runner is handed by name: what it may read, and the token that stands for a key. */
  credentials: Readonly<Record<string, string>>;
  /** Its runner's launch, as this container needs it. */
  args(launch: RunnerLaunch): readonly string[];
  /** A read-only attempt's: nothing of it comes back, and nothing of it is kept. */
  landsNothing: boolean;
  route: EgressRoute;
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
 * the host, under their envelope and their seal, a merge is not an agent's, and
 * a subplanner stays there too (ADR-0055). A script always runs in a container:
 * its body is a person's or a planner's, but what it runs over is what containers
 * wrote, so `npm test` on the host would run that code outside the boundary. A
 * runner's work in the user's checkout cannot be anywhere else, so it is refused:
 * a user who asked for a container does not get the host instead (L3).
 */
export function whereItRuns({ role }: LeaseRequest, { workspace }: LeaseSpec): 'host' | 'container' | { refused: string } {
  if (role === 'script') return 'container';
  if (role !== 'task') return 'host';
  if (workspace.kind === 'checkout') return { refused: "this task works in your checkout, which a container cannot reach, so it did not start: turn containers off for it, or make it a task that runs in a worktree" };
  return workspace.intent === 'readOnly' ? 'host' : 'container';
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** A script's container holds no login: a body the plan names has no use for a model's. */
const NO_LOGIN: IssuedLogin = { gated: null, handed: {} };

/** The APIs a broker keeps keys for: never handed over beside a gated key, so a task under one has no business reaching them. */
const BROKERED_HOSTS: ReadonlySet<string> = new Set(MODEL_APIS.map(({ upstream }) => new URL(upstream).hostname));

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
  private toldOfCopy = false;
  private toldOfGuarantees = false;
  private readonly lettingGo = new Set<Promise<void>>();

  constructor(private readonly local: ExecutionBackend, private readonly options: DockerBackendOptions) {
    this.cli = options.cli ?? new SpawnedDockerCli();
    this.git = options.git ?? { exec: defaultExecFile, resolvePath: () => augmentedPath() };
    this.broker = options.broker ?? new CredentialBroker(process.env);
    this.egress = options.egress ?? new SidecarEgress(this.cli);
  }

  /** What a throwaway container proves, for a surface to report before any task runs. */
  async probe(): Promise<GuaranteeReport> {
    return proveEngine(await this.preflight(null), { cli: this.cli, egress: this.egress, labels: this.labels('probe') });
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
    // A script has no runner to prove: its steps are the lease's own execs.
    const agent = request.role === 'task';
    const runner = (agent && containerRunner(request.runner)) || null;
    if (agent && !runner) throw new Error(`This session runs tasks in containers, and ${request.runner ?? 'this runner'} has not been proven in one: assign the task to ${CONTAINER_RUNNER_IDS.join(', ')}.`);
    // A Continue restores what the worktree holds, so one started at once must not get there first. Before all else: a start that fails
    // below gives its workspace up, which held-back work must outlive.
    if (spec.task) await this.collect(spec.task.id).catch((err: unknown) => { if (err instanceof KeptWorkError) throw err; });
    const settings = await this.preflight(runner, spec.task?.assignedModel?.modelId);
    const opened = await lease.open({ ...spec, required: [] }, signal);
    // Ended since its claim: the worktree is the attempt's to undo, as it undoes any it finds it no longer wants.
    if (signal.aborted) return opened;
    const box = await this.start({ runner, settings, spec, opened, repos: await this.reposOf(agent, opened) }, signal);
    if (!box) return opened;
    mine.box = box;
    return {
      ...opened,
      guarantees: box.report,
      placement: {
        cwd: box.cwd,
        place: (launch) => this.place(box, launch),
        reach: (url) => this.reach(box, url),
        reachIn: (url) => this.reachIn(box, url),
        blob: (file) => this.blob(box, file),
        env: box.route.gateway?.env ?? {},
      },
      ended: async () => {
        await this.close(box);
        return box.exit;
      },
    };
  }

  /**
   * Every check that spends nothing, before a worktree is made for a start that
   * cannot go on. It runs at each start, and the claim stays synchronous without
   * it: an engine that answered an hour ago proves nothing of this one.
   */
  private async preflight(runner: ContainerRunner | null, model?: string): Promise<ContainerSettings> {
    const setupCommand = this.options.setupCommand?.();
    const { problems, settings } = await inspectReadiness(this.options.settings, { cli: this.cli, broker: this.broker, agent: runner !== null, ...(runner ? { runner } : {}), ...(setupCommand ? { setupCommand } : {}) });
    if (!settings) throw new Error(`This session runs tasks in containers, and this task cannot start in one. ${describeProblems(problems)}`);
    // A task's model is the one thing here no surface could have asked about.
    const refusal = runner && settings.login.kind === 'broker' ? brokerRefusal(runner, model) : null;
    if (refusal) throw new Error(`This session runs tasks in containers, and this task cannot start in one. ${refusal}`);
    return settings;
  }

  /**
   * What a container is seeded from. A script with no worktree of its own runs
   * where a script always does, at the workspace root (ADR-0035), so it gets what
   * that root has committed: its merge gate brought what landed there first.
   */
  private async reposOf(agent: boolean, { workspace: { worktree, repos, cwd } }: OpenLease): Promise<readonly LeaseRepo[]> {
    if (worktree && repos?.length) return repos;
    if (agent) throw new Error('This session runs tasks in containers, and this run shares its workspace, which a container cannot reach. Start it with worktree isolation on.');
    const known = repos?.length ? repos : this.local.checkoutRepos?.() ?? [];
    if (known.length > 0) return known;
    const lone = await tryGit(this.git, cwd, ['rev-parse', '--show-toplevel']);
    if (!lone.ok) throw new Error(`This session runs tasks in containers, and ${cwd} is no git repository, so there is nothing to copy into one.`);
    return [{ path: SELF_REPO, root: lone.stdout.trim(), worktree: lone.stdout.trim(), branch: CHECKOUT_BRANCH, integrationBranch: 'HEAD', linked: [] }];
  }

  /** Where a script of the workspace root runs in its copy: a folder of a repository keeps its place in it. */
  private async checkoutFolder(cwd: string): Promise<string> {
    const prefix = await tryGit(this.git, cwd, ['rev-parse', '--show-prefix']);
    return prefix.ok ? prefix.stdout.trim() : '';
  }

  private async workingDirectory(opened: OpenLease): Promise<string> {
    const { worktree, writable, cwd } = opened.workspace;
    return posix.join(WORK_ROOT, worktree ? relative(writable ?? cwd, cwd).split(sep).join('/') : await this.checkoutFolder(cwd));
  }

  private async start({ runner, settings, spec, opened, repos }: Starting, signal: AbortSignal): Promise<(Box & { report: GuaranteeReport }) | null> {
    const taskId = spec.task!.id;
    const sealed = spec.workspace.kind === 'worktree' && spec.workspace.intent === 'readOnly';
    const landsNothing = sealed || !opened.workspace.worktree;
    if (!landsNothing) await this.refuseHooks(repos);
    const login = runner && settings.login.kind === 'broker' ? this.broker.issue(settings.login.variables, runner.api) : NO_LOGIN;
    const signIn = runner && settings.login.kind === 'own-sign-in' ? runner.signIn : null;
    const key = this.taskKey(taskId);
    const nonce = randomBytes(4).toString('hex');
    // Nothing of a read-only attempt is kept, so a retry cannot be handed a volume its last attempt is still giving up.
    const volume = landsNothing ? `ordewell-task-${key}-${nonce}` : `ordewell-task-${key}`;
    const mirror = await this.mirrorVolume(repos);
    const labels = this.labels(taskId);
    await this.cli.call(['volume', 'create', ...labels, volume]);
    const pin = `${treePins(this.tree())}/${key}`;
    // What is left of an attempt that never was: a task's own volume stays for its next one.
    const dropThrowaway = () => (landsNothing ? this.dropVolume(volume) : Promise.resolve());
    const dropAndThrow = async (err: unknown): Promise<never> => {
      await dropThrowaway();
      throw err;
    };
    const tips = await this.syncMirror(settings, mirror, pin, repos).catch(dropAndThrow);
    if (signal.aborted) {
      await dropThrowaway();
      return null;
    }
    if (signIn) await this.handSignIn(settings, signIn, volume, labels).catch(dropAndThrow);

    const name = `ordewell-${key}-${nonce}`;
    // A read-only script runs as a sealed one does, which reaches nothing (ADR-0056 M9).
    const route = sealed ? NO_WAY_OUT : await this.egress.open({ name, labels, limits: containerLimits(settings), image: settings.image, allow: this.allowOf(settings, runner !== null, login, signIn, spec.task?.assignedModel?.modelId), gated: login.gated }).catch(dropAndThrow);
    const giveUp = async () => {
      await this.cli.call(['rm', '-f', name]);
      await route.close();
      await dropThrowaway();
    };
    try {
      const startedAt = Date.now();
      const told = envArgs(this.containerEnv(settings, route, signIn));
      const entry = await this.cli.entry([
        'run', '-i', '--rm', '--name', name, ...labels,
        ...containerLimits(settings), ...route.runArgs,
        '-v', `${volume}:${TASK_ROOT}`, '-v', `${mirror}:${MIRROR_ROOT}:ro`,
        ...told.args,
        settings.image, 'node', '-e', RELAY_ENTRY,
      ], { env: told.env });
      const relay = new LeaseRelay(entry);
      const box: Box & { report: GuaranteeReport } = {
        taskId, settings, name, volume, mirror, pin, ref: exportRef(name), bases: new Map(repos.map((repo) => [repo.path, tips.get(repo.path)!.head])), repos,
        cwd: await this.workingDirectory(opened),
        credentials: { ...login.handed, ...route.gateway?.env },
        args: (launch) => launch.command === runner?.binary ? runner.args(launch, { gatewayPort: route.gateway?.port ?? null, signedIn: signIn !== null }) : launch.args,
        landsNothing, route, relay, relayGone: false, launches: 0, running: 0, runnersGone: [], closing: null, bringing: null, exit: null,
        report: opened.guarantees,
      };
      void relay.ended.then(() => { box.relayGone = true; });
      await settleWithin(relay.ready, { timeoutMs: ENTRY_START_MS, onTimeout: () => { throw new Error('The container did not start in time.'); } });
      console.error(`[container] ${name} up in ${Date.now() - startedAt}ms`);
      if (runner) await this.refuseAbsentRunner(name, settings, runner);
      if (route.gateway) await relay.forward(route.gateway.port, route.gateway.port);
      for (const repo of repos) await this.seed(box, repo, tips.get(repo.path)!);
      box.report = await this.prove(box, settings, opened.workspace.cwd, login, signIn);
      refuseUnproven([...spec.required, ...settings.required], box.report);
      if (signal.aborted) {
        await giveUp();
        return null;
      }
      this.boxes.set(taskId, box);
      this.tellOfNetwork(box.report);
      this.tellOfGuarantees(box.report);
      if (!opened.workspace.worktree) this.tellOfCopy();
      return box;
    } catch (err) {
      await giveUp();
      throw err;
    }
  }

  private tree(): string {
    return (this.options.treeId ?? this.options.sessionId)();
  }

  private taskKey(taskId: string): string {
    return digest(`${this.options.sessionId()}\0${taskId}`);
  }

  /**
   * A volume whose being there says the task's work was not brought back: it
   * holds nothing, no container mounts it, and it outlives this host as what it
   * stands for does (L2). A task's clone is no place for this, since a container
   * could then lift it.
   */
  private heldVolume(taskId: string): string {
    return `ordewell-held-${this.taskKey(taskId)}`;
  }

  /** Whose a thing in the engine is, as a clean-up finds it: all a session delete has left to go on. */
  private labels(taskId: string): string[] {
    return Object.entries({ [TREE_LABEL]: this.tree(), 'ordewell.session': this.options.sessionId(), 'ordewell.task': taskId }).flatMap(([label, value]) => ['--label', `${label}=${value}`]);
  }

  private async refuseHooks(repos: readonly LeaseRepo[]): Promise<void> {
    for (const repo of repos) {
      const hooks = await hooksLandingWouldRun(this.git, repo.worktree);
      if (hooks.length > 0) throw new Error(`This session runs tasks in containers, and ${repo.root} has git hooks (${hooks.join(', ')}) that landing would run on this host, over what a container wrote. Remove them or turn containers off for this repository.`);
    }
  }

  private tellOfCopy(): void {
    if (this.toldOfCopy) return;
    this.toldOfCopy = true;
    this.options.tell('info', 'Script tasks run in containers on this session, on a copy of what your checkout has committed: what they write stays there, and your uncommitted changes do not reach them.');
  }

  private tellOfNetwork(report: GuaranteeReport): void {
    if (this.toldOfNetwork || report['net.allowlist'].proven) return;
    this.toldOfNetwork = true;
    this.options.tell('warn', `Tasks run in containers on this session, and their network is not limited: ${report['net.allowlist'].by}. A container then hides your files from a runner, not the internet from it.`);
  }

  /** What a person chose to require stopped nothing, and may be what they took for granted: said once, in its proof's own words. */
  private tellOfGuarantees(report: GuaranteeReport): void {
    const unproven = Object.entries(report).filter(([, { proven }]) => !proven);
    if (this.toldOfGuarantees || unproven.length === 0) return;
    this.toldOfGuarantees = true;
    this.options.tell('info', `Tasks run in containers on this session, and these were not proven: ${unproven.map(([guarantee, { by }]) => `${guarantee} (${by})`).join('; ')}.`);
  }

  /**
   * A task's own copy of a person's sign-in, in its own volume. The kept one is
   * never where a runner runs: one task could write it, and every later task of
   * every session loads what it wrote. A helper with no network and no agent reads
   * it, read-only. A Continue keeps the copy it has, refreshed token and sessions
   * alike, until a new sign-in comes over it; a link an earlier attempt planted leads
   * nowhere the helper may write but this same volume.
   */
  /** Asked before anything is copied in: launched, a missing binary reads in the task's log as a runner that died. */
  private async refuseAbsentRunner(name: string, settings: ContainerSettings, { binary }: ContainerRunner): Promise<void> {
    const found = await this.cli.call(['exec', name, 'sh', '-c', 'command -v "$0"', binary]);
    if (found.code !== 0) throw new Error(`The image ${settings.image} holds no ${binary}, so this task has no runner in it: build the image as docs/containers.md shows.`);
  }

  private async handSignIn(settings: ContainerSettings, signIn: ContainerSignIn, volume: string, labels: readonly string[]): Promise<void> {
    const helper = helperArgs(settings, [`${volume}:${TASK_ROOT}`, `${signIn.volume}:/login:ro`], {}, labels);
    const copied = await this.cli.call([...helper.args, ...signIn.copy], { env: helper.env });
    if (copied.code !== 0) throw new Error(`Your own sign-in could not be handed to this task: ${copied.stderr.trim() || 'it could not be copied'}. ${signInRemedy(signIn)}`);
  }

  private containerEnv(settings: ContainerSettings, route: EgressRoute, signIn: ContainerSignIn | null): Record<string, string> {
    return {
      HOME: HOME_DIR,
      // Behind a proxy Claude Code's memory grew until killed in user reports (ADR-0059 L7), and a task needs none of this traffic.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // In the task's own volume: a cache every task writes is one task's code running in the next. A retry keeps its own.
      ...Object.fromEntries(settings.caches.map((cache) => [CACHE_VARIABLES[cache], `${TASK_ROOT}/caches/${cache}`])),
      ...signIn?.env,
      ...route.env,
    };
  }

  /**
   * What a lease's container may reach: what the person listed, where a person's
   * own sign-in talks and refreshes, and a model's own API where a key was handed
   * or that sign-in holds one. A broker's key that stops at the gateway reaches no
   * host at all, and the other API a login keeps from this runner reaches none
   * either, so beside a gated key only a handed one opens its provider.
   */
  private allowOf(settings: ContainerSettings, agent: boolean, login: IssuedLogin, signIn: ContainerSignIn | null, model: string | undefined): readonly string[] {
    const hosts = [...settings.allow];
    if (signIn) hosts.push(...signIn.hosts);
    // A script holds no login and calls no model: what it reaches is the person's list alone.
    if (agent && !login.gated) hosts.push(...modelHosts(model));
    if (agent && login.gated && Object.keys(login.handed).length > 0) hosts.push(...modelHosts(model).filter((host) => !BROKERED_HOSTS.has(host)));
    return [...new Set(hosts)];
  }

  /** One volume for a repo group, by where git keeps the first repository: worktrees of it and later sessions share it. */
  private async mirrorVolume(repos: readonly LeaseRepo[]): Promise<string> {
    const commonDir = (await git(this.git, repos[0].root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const volume = `ordewell-mirror-${digest(commonDir)}`;
    await this.cli.call(['volume', 'create', volume]);
    return volume;
  }

  /** What each repo's attempt starts from, pinned in its mirror for as long as the task's clone leans on it. */
  private async syncMirror(settings: ContainerSettings, mirror: string, pin: string, repos: readonly LeaseRepo[]): Promise<Map<string, { head: string; integration: string; name: string; email: string }>> {
    const helper = helperArgs(settings, [`${mirror}:${MIRROR_ROOT}`]);
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
    const told = envArgs(variables);
    const seeded = await this.cli.call(['exec', ...told.args, box.name, 'sh', '-c', SEED_SCRIPT], { env: told.env });
    if (seeded.code !== 0) throw new Error(`Could not put the task's work in its container: ${seeded.stderr.trim()}`);
  }

  /** L3: the proof is a run in the container, as its runner will run, with what its runner will hold. */
  private prove(box: Box, settings: ContainerSettings, hostCwd: string, { gated, handed }: IssuedLogin, signIn: ContainerSignIn | null): Promise<GuaranteeReport> {
    return withCanaries(async ({ file, port, loopbackHits }) => {
      const network = networkAsked(box.route, port);
      const salt = randomBytes(16).toString('hex');
      const secrets = gated ? { secrets: { salt, digests: [createHash('sha256').update(salt + gated.key).digest('hex')] } } : {};
      const asked: ProbeAsked = { hostPaths: [file, hostCwd], deniedWrites: ['/', '/usr', '/etc', MIRROR_ROOT], workspace: WORK_ROOT, credentials: Object.keys(handed), ...(signIn ? { login: signIn.path } : {}), network, ...secrets };
      const told = envArgs({ ORDEWELL_PROBE: JSON.stringify(asked), ...box.credentials });
      const ran = await this.cli.call(['exec', ...told.args, box.name, 'node', '-e', PROBE_SCRIPT], { env: told.env });
      return judgeProbe(probeFindings(ran.stdout, ran.stderr), { ...probeExpected(settings, [TASK_ROOT, MIRROR_ROOT, '/tmp']), network, loopbackHits: loopbackHits(), gated: gated !== null }, new Date().toISOString());
    });
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
    // The container has its own HOME, PATH and PWD, which `-w` sets; the CLI's are this host's.
    const told = envArgs({ ...Object.fromEntries(Object.entries(launch.env).filter(([variable]) => !CLI_READS.test(variable))), ...box.credentials });
    const pidFile = `/tmp/ordewell/${launchNumber}.pid`;
    box.running += 1;
    return {
      command: 'docker',
      args: [
        'exec', '-i', '-w', box.cwd, ...told.args, box.name,
        'sh', '-c', 'mkdir -p /tmp/ordewell; echo $$ > "$0"; exec "$@"', pidFile, launch.command, ...box.args(launch).map((arg) => moved.get(arg) ?? arg),
      ],
      env: told.env,
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

  /**
   * A server the runner started inside, as the host reaches it (L6): the relay
   * carries this host's loopback into the container, so a server bound to the
   * container's own `127.0.0.1` is reached with no network and under any
   * egress. The URL keeps its path and protocol and takes the port the relay
   * took here, which is never the container's.
   */
  private async reachIn(box: Box, url: string): Promise<string> {
    const target = new URL(url);
    const port = Number(target.port);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`A listener inside the container was named without a port: ${url}`);
    const hostPort = await box.relay.expose(port);
    // The address a server prints is its origin; a path it names is kept, but a bare root is not a second slash in every URL built on it.
    const path = target.pathname === '/' ? '' : target.pathname;
    return `${target.protocol}//${target.hostname}:${hostPort}${path}${target.search}`;
  }

  /**
   * A file of the attempt as it stands in its container (ADR-0057 R9): its
   * worktree on this host holds what it was seeded with until the work comes back.
   * Over the same limit as a read on this host. What it answers is only a pin's
   * staleness signal, so a process in the container can lie here to no gain.
   */
  private async blob(box: Box, file: string): Promise<string | undefined> {
    const read = await this.cli.call(['exec', '-w', box.cwd, box.name, 'sh', '-c', BLOB_SCRIPT, file]);
    const sha = read.stdout.trim();
    return read.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }

  /** An attempt's lease has ended. A kept worktree's `letGo` decides what follows; a landed one has no `letGo` to come (ADR-0059 L1). */
  private ended(box: Box): void {
    void this.close(box).then(async () => {
      // Only a landing says so: a task with no record may be a restore between its worktrees, and its session is in this volume.
      const record = (await this.local.list()).find((candidate) => candidate.taskId === box.taskId);
      if (!box.landsNothing && record?.status !== 'merged') return;
      await this.dropVolume(box.volume);
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
      await box.route.close();
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
    if (box) {
      await this.close(box);
      if (!box.landsNothing) return this.bringBack(box);
    }
    const held = await this.cli.call(['volume', 'ls', '-q', '--filter', `name=${this.heldVolume(taskId)}`]);
    if (held.stdout.trim()) throw new KeptWorkError(heldBack(taskId, 'it was not brought back'));
  }

  /**
   * The attempt's work, every repo through the gate before any is touched, as a
   * landing is the whole task or none of it. Once per attempt: a refusal stands,
   * and what it refused waits on the user, as {@link heldVolume} says past this
   * Session, for a Retry to give up (L2).
   */
  private bringBack(box: Box): Promise<void> {
    box.bringing ??= (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ordewell-export-'));
      try {
        const taken: { repo: LeaseRepo; snapshot: string }[] = [];
        for (const repo of box.repos) taken.push({ repo, snapshot: await this.take(box, repo, join(dir, `${taken.length}.bundle`)) });
        for (const { repo, snapshot } of taken) await restoreSnapshot(this.git, repo.worktree, snapshot, repo.linked);
      } catch (err) {
        await this.cli.call(['volume', 'create', ...this.labels(box.taskId), this.heldVolume(box.taskId)]);
        throw new KeptWorkError(heldBack(box.taskId, errorText(err)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    return box.bringing;
  }

  private async take(box: Box, repo: LeaseRepo, file: string): Promise<string> {
    const base = box.bases.get(repo.path)!;
    // The clone leans on the mirror's objects, so it is read through it, as the attempt read it.
    const helper = helperArgs(box.settings, [`${box.volume}:${TASK_ROOT}`, `${box.mirror}:${MIRROR_ROOT}:ro`], { ORDEWELL_REPO_DIR: repoDir(repo), ORDEWELL_REF: box.ref, ORDEWELL_BASE: base }, this.labels(box.taskId));
    const ran = await this.cli.call([...helper.args, 'sh', '-c', EXPORT_SCRIPT], { env: helper.env, stdoutTo: { file, maxBytes: MAX_BUNDLE_BYTES }, timeoutMs: EXPORT_TIMEOUT_MS });
    if (ran.overflowed) throw new PushRefused('it is larger than any one attempt\'s work should be');
    if (ran.code !== 0) throw new Error(`Could not read the attempt's work out of its volume: ${ran.stderr.trim()}`);
    return takeThroughGate(this.git, repo.root, file, { ref: box.ref, base });
  }

  private async dropVolume(volume: string): Promise<void> {
    await this.cli.call(['volume', 'rm', '-f', volume]);
  }

  letGo(taskId: string, how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void> {
    const going: Promise<void> = this.releaseTask(taskId, how).finally(() => this.lettingGo.delete(going));
    this.lettingGo.add(going);
    return going;
  }

  private async releaseTask(taskId: string, how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void> {
    // What refused it has been said; it is why the work stays where it is, not a reason to keep the worktree.
    await how.landing?.then(() => undefined, () => undefined);
    const box = this.boxes.get(taskId);
    if (box) {
      await this.close(box);
      if (how.keep && !box.landsNothing) await this.bringBack(box).catch((err: unknown) => this.options.tell('warn', errorText(err)));
      if (this.boxes.get(taskId) === box) this.boxes.delete(taskId);
    }
    if (!how.keep) {
      await this.dropVolume(`ordewell-task-${this.taskKey(taskId)}`);
      await this.dropVolume(this.heldVolume(taskId));
    }
    return this.local.letGo(taskId, { ...how, landing: null });
  }

  list(): Promise<readonly LeaseRecord[]> {
    return this.local.list();
  }

  /** The Session is closing: its containers go, with the relay and the way out each holds open, and a kept task's volume stays for a Continue. */
  async settle(): Promise<void> {
    for (const box of this.boxes.values()) {
      await this.close(box).catch(() => undefined);
      await box.bringing?.catch(() => undefined);
    }
    await Promise.allSettled(this.lettingGo);
  }

  /**
   * What the tree left in the engine, as a Clean up lets it go: no attempt is
   * live, so nothing kept here is reopened. What is still winding down goes first:
   * a helper started after a volume has gone makes it again, with no label.
   */
  async reclaim(): Promise<void> {
    await this.settle();
    this.boxes.clear();
    const settings = parseContainerSettings(this.options.settings);
    await reclaimTree(this.tree(), this.cli, 'refused' in settings ? null : settings, (text) => this.options.tell('warn', text));
  }
}

/** What a user finds on a task whose work did not come back: where it is, and the one act that gives it up. */
function heldBack(taskId: string, why: string): string {
  return `The work of task ${taskId} stays in its container's volume: ${why.replace(/\.$/, '')}. Nothing starts over it until you retry the task, which gives that work up.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `containers` setting as the seam's `execution`: a Session's own backend, around its own local one. */
export function containerExecution(raw: unknown): (local: ExecutionBackend, context: Pick<DockerBackendOptions, 'sessionId' | 'tell' | 'setupCommand'> & { treeId: () => string }) => ExecutionBackend {
  return (local, context) => new DockerExecutionBackend(local, { settings: raw, ...context });
}
