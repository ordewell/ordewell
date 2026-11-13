import type { ExecutionActor } from '../models/Execution';
import type { LegacyPlanState, Task } from '../models/Task';
import type { UsageRecord } from '../models/Usage';
import type { INotification } from '../interfaces/INotification';
import type { IConfig } from '../interfaces/IConfig';
import type { IWorktreeIsolation } from '../interfaces/IWorktreeIsolation';
import type { PlannerToolsOffer } from './AiService';
import type { ApprovalModeSetting } from './ApprovalPolicy';
import { ChildDirectory } from './ChildDirectory';
import { ownedRunner, type ChildNode, type SubplannerLink } from './ChildPlanRunner';
import type { ChildPlacement, SaveSession, SessionDeps, SessionRuntimeSettings } from './createSession';
import type { EventStore } from './eventStore';
import type { IsolationRunController } from './IsolationRunController';
import type { TaskRunnerConfig } from './harness/AgentAdapter';
import { SCRIPT_PAST_THE_RULES, heldMandate, mandateRefusalText, rootAuthority, withheldPlannerTools, type Mandate, type MandateLimits, type NodeAuthority, type RootSettings } from './Mandate';
import { ChildFunding, RootFunding, type FundingHost, type NodeFunding } from './NodeFunding';
import { ChildReading, RootReading, type NodeReading, type ReadingHost } from './NodeReading';
import { ChildSeat, RootSeat, type ChildSeatHost, type NodeSeat } from './NodeSeat';
import { runsSealed } from './PlanChangeCheck';
import type { PlanStore } from './PlanStore';
import type { SubplannerBrief } from './PlanPrompts';
import type { PlannerToolHandler } from './mcp';
import { NODE_REPORTED } from './plannerTools';
import { providerForRunner } from './ProviderRegistry';
import { childLease, processLeaseHost, UNLEASED, type LeaseHost, type SessionHeld, type SessionLease } from './sessionLease';
import type { SessionNotice } from './SessionMessage';
import { RUN_SETTINGS_DEFAULTS } from './SettingsService';
import type { SlotPool } from './SlotPool';
import { refuseUsersCheckout } from './stateRoot';
import type { TaskOrchestratorOptions } from './TaskOrchestrator';
import type { NodeBudget } from './TreeLedger';
import { hasTreeEventLog } from '../utils/treeEventLog';
import { loadChildSession, saveChildSession, saveSession } from '../utils/sessionStore';
import type { TaskLogLocation } from '../utils/taskLogStore';
import { mintSessionId } from '../utils/sessionId';

/** A session built under a parent's attempt: what {@link NodePosition.openChild} seats and carves, and what the parent hands it. */
export interface ChildSpec {
  task: Task;
  cwd: string;
  placement: ChildPlacement;
  authority: NodeAuthority;
  brief: SubplannerBrief;
  link: SubplannerLink;
}

/** A child Session as its parent's position drives it while opening it: `createSession` built it, and nothing else of it is reached. */
export interface BuiltChild {
  /** Adopt the plan it saved, under the id it was seated by (ADR-0055 D17). */
  load(plan: LegacyPlanState, goal: string): void;
  asNode(task: Task, mandate: Mandate, pins: readonly string[]): ChildNode;
  destroy(): void;
}

/** The parts of a seat's host only the Session has; the position adds where the node sits and what it may start. */
export type SeatHost = Omit<ChildSeatHost, 'link' | 'depth' | 'directory' | 'pool' | 'funds' | 'nodeRefusal' | 'withdrawn'>;

/** The parts of a reading's host only the Session has; the position adds the ledger and the state root. */
export type ReadingParts = Omit<ReadingHost, 'funds' | 'delegationOffered' | 'stateRoot'>;

/** What a position reads of the Session it places, afresh each time, once that Session has bound it. */
export interface NodeHost {
  /** Its level: 0 at the root. */
  readonly depth: number;
  mandate(): Mandate;
  /** The id it saves under now; a root's is its tree's. */
  sessionId(): string;
  /** Its code root, which a load may move. */
  workspace(): string;
  /** Destroyed: nothing opens under it any more. */
  closed(): boolean;
  readonly delegationOffered: boolean;
  /** Its run's worktree seats, which a child is seated in and discarded from (ADR-0055 D12, D15, D17). */
  runs(): Pick<IsolationRunController, 'requireChildSeat' | 'childSession' | 'hostChild' | 'childIsolation' | 'discardChild'>;
  /** The tree's slots, which its children share (ADR-0055 D18). */
  pool(): SlotPool;
  store(): Pick<PlanStore, 'get' | 'setTaskRunnerSessionId' | 'resolveTaskRunner'>;
  /** The plan changed: save it as the Session saves after a change. */
  saved(): void;
  heldElsewhere(): SessionHeld | null;
  /** The tree's token limit as the user keeps it, read at each carve and raise. */
  delegationLimit(): number;
  notice(level: SessionNotice['level'], message: string): void;
  childrenStopped(): Promise<unknown>;
  stopSubtree(): Promise<void>;
  /** A raise took: what its room lets start is the run's to start (ADR-0056 M5). */
  raised(): void;
  /** Its subplanner is told, once, that nothing ready can start (ADR-0056 M5). */
  refusedStart(why: string): void;
  /** A child Session from `createSession`, the only place one is built (ADR-0055 D3, D12). */
  child(spec: ChildSpec): BuiltChild;
  readonly seat: SeatHost;
  readonly reading: ReadingParts;
}

/** What a node's run is composed with at its place: a child runs inside its root's state, slots and isolation (ADR-0055 D11, D18). */
export type PlacedRun = Pick<TaskOrchestratorOptions, 'stateRoot' | 'pool' | 'budget' | 'planNode' | 'decided' | 'nodeRefusal'>;

/** What a parent hands the node it opens, besides its seat: each is absent at the root. */
export interface NodeGiven {
  /** What it may do, held under every level above it (ADR-0056 M1). */
  authority?: NodeAuthority;
  /** What its planner is told of the delegated task it plans (ADR-0055 D5). */
  brief?: SubplannerBrief;
}

/** The planner tools a node's own planner is offered beyond the root's: what its grants withhold, and a subplanner's token and setup. */
export type PlacedPlannerTools = Pick<PlannerToolsOffer, 'withheld' | 'subplanner' | 'noSubagents' | 'runnerConfig'>;

interface Bound {
  host: NodeHost;
  funds: NodeFunding;
  seat: NodeSeat;
  reading: NodeReading;
}

/**
 * A Session's place in its tree, root or child, chosen once where
 * `createSession` builds it: where its state sits, what it saves and leases
 * through, which funding, seat and reading it holds, what refuses a start at
 * it, and how it seats, opens and discards a child. The Session binds it once
 * its own state exists, so it never asks its depth for any of these.
 */
export abstract class NodePosition {
  private bound: Bound | undefined;
  /** The subplanner was told a start was refused; a raise makes it news again (ADR-0056 M5). */
  private toldStartRefused = false;

  private readonly given: NodeAuthority | undefined;
  /** What its planner is told of the delegated task it plans; none at the root. */
  readonly brief: SubplannerBrief | undefined;

  /** `link` is how this node answers to its parent's attempt (ADR-0055 D5); none at the root, or for a child seated without one. */
  protected constructor(protected readonly link: SubplannerLink | undefined, { authority, brief }: NodeGiven) {
    this.given = authority;
    this.brief = brief;
  }

  /** Where this session's own files live (ADR-0055 D11): its workspace, unless it is a child, whose code root goes with a worktree. */
  abstract stateRoot(workspace: string): string;
  /** The root Session's id, under which a tree's state sits (ADR-0055 D11). */
  abstract rootSessionId(own: string): string;
  /** Where its structured task logs are saved (ADR-0018, P1). */
  abstract logLocation(workspace: string, sessionId: string): TaskLogLocation;
  /** The id it is opened under, if it is given one. */
  abstract sessionId(given: string | undefined): string | undefined;
  readonly abstract save: SaveSession;
  /** One live host per tree (ADR-0049, ADR-0055 D13). */
  abstract lease(onLost: (held: SessionHeld) => void, runLive: () => boolean): SessionLease;
  /** What is charged here, telling the parent's attempt of each record (ADR-0055 D20). */
  readonly abstract budget: NodeBudget | undefined;
  readonly abstract isolation: IWorktreeIsolation | undefined;
  abstract run(): PlacedRun;
  /** Where its tasks run, read once for the whole tree. */
  abstract containers(settings: () => SessionRuntimeSettings): SessionRuntimeSettings['containers'];
  /** A plan's code root may not be the user's checkout below the root (ADR-0055 D12). */
  abstract refuseCheckout(workspace: string): void;
  /** The tree's plans as a surface reaches them, one directory at every depth (ADR-0055 D20). */
  abstract get children(): ChildDirectory;

  protected abstract funding(host: NodeHost, base: FundingHost): NodeFunding;
  protected abstract seating(host: NodeHost, funds: NodeFunding): NodeSeat;
  protected abstract reader(host: NodeHost, base: ReadingHost): NodeReading;

  /** Once, by the Session it places, as its constructor ends: everything below reads that Session through `host`. */
  bind(host: NodeHost): void {
    if (this.bound) throw new Error('A position places one Session.');
    const funds = this.funding(host, {
      mandate: () => host.mandate(),
      level: host.depth,
      seats: () => host.runs(),
      planHas: (taskId) => host.store().get(taskId) !== undefined,
    });
    const reading = this.reader(host, {
      ...host.reading,
      funds,
      delegationOffered: host.delegationOffered,
      stateRoot: () => this.stateRoot(host.workspace()),
    });
    this.bound = { host, funds, reading, seat: this.seating(host, funds) };
  }

  protected get host(): NodeHost { return this.placed().host; }
  /** This node's side of the tree's ledger (ADR-0056 M5). */
  get funds(): NodeFunding { return this.placed().funds; }
  /** Where this node sits under its parent (ADR-0055 D20). */
  get seat(): NodeSeat { return this.placed().seat; }
  /** What this node reads of its plan, the plans below it and its board (ADR-0057 R1, R8). */
  get reading(): NodeReading { return this.placed().reading; }

  private placed(): Bound {
    if (!this.bound) throw new Error('This position has no Session yet.');
    return this.bound;
  }

  /** A raise took: the start it refused is news to its subplanner again. */
  protected raised(): void {
    this.toldStartRefused = false;
    this.host.raised();
  }

  /** What this node may do, read at each check: what its parent gave it, or the root's settings at the level each caller names (ADR-0056 M1). */
  authority(rootSettings: () => Omit<RootSettings, 'level'>): NodeAuthority {
    return this.given ?? rootAuthority(rootSettings);
  }

  /** What a change below the root is held to, a commit included (ADR-0056 M6); undefined at the root, whose person approves. */
  heldAuthority(): NodeAuthority | undefined {
    return this.given;
  }

  /** Whether its runners take their autonomous modes (ADR-0056 M6): below the root its mandate's `autonomy` says, and at it the global setting, which the root's mandate reads too. */
  autonomous(setting: boolean): boolean {
    return this.given ? this.given.mandate('off').autonomy === 'full' : setting;
  }

  /** The runners and models its catalog is held to; undefined at the root, whose catalog is the user's (ADR-0056 M1). */
  heldLimits(): Pick<MandateLimits, 'runners' | 'models'> | undefined {
    return this.given?.mandate('off').limits;
  }

  /** What no landing here may touch, set above it (ADR-0056 M1); nothing beyond the user's own rules at the root. */
  inheritedProtectedPaths(): readonly string[] {
    return this.given?.mandate('off').exclusions.protectedPaths ?? [];
  }

  /** Why a script of this node's may not land what it does unsealed, as the rules stand now: an effect withdrawn since it landed goes with them (ADR-0056 M9). Never at the root. */
  unsealedRefusal(task: Readonly<Task>): string | null {
    const given = this.given;
    return given && runsSealed(given.mandate('off'), task) ? `Level ${given.depth} refused Task "${task.title}": ${SCRIPT_PAST_THE_RULES}.` : null;
  }

  /** At the root the user's setting is the consent, at any level (ADR-0029); `merge` is what a child's asks (ADR-0056 M6). */
  mayMergeUnasked(): boolean {
    return !this.given || this.given.mandate('off').grants.has('merge');
  }

  /** Whether a runner's request may wait on a person: nobody below the root may allow one, and absent is denial (ADR-0056 M8). */
  get mayAskAPerson(): boolean {
    return this.given === undefined;
  }

  /** Who its own planner speaks as at the seam, on every call it makes: below the root, the subplanner at its depth; the turn decides at the root. */
  plannerActor(): ExecutionActor | undefined {
    return this.given ? { kind: 'subplanner', depth: this.given.depth } : undefined;
  }

  /** What its planner is offered beyond the root's tools: its grants' withholdings, and a subplanner's token and process setup (ADR-0056 M6, ADR-0057 R11). */
  plannerTools(runnerConfig: TaskRunnerConfig | undefined): PlacedPlannerTools {
    const mandate = this.given?.mandate('off');
    return {
      ...(mandate ? { withheld: withheldPlannerTools(mandate) } : {}),
      ...(this.link ? { subplanner: true } : {}),
      // Nothing refuses what a harness's own subagents spend, so they come only with `research`.
      ...(mandate && !mandate.grants.has('research') ? { noSubagents: true } : {}),
      ...(this.link ? { runnerConfig: runnerConfig ?? 'minimal' } : {}),
    };
  }

  /** Its planner's tools, and for a subplanner the two its parent's attempt answers (ADR-0055 D5). */
  offeredTools(handler: PlannerToolHandler): PlannerToolHandler {
    const link = this.link;
    if (!link) return handler;
    return { ...handler, taskComplete: (report) => link.taskComplete(report), checkpoint: ({ question }) => Promise.resolve(link.checkpoint(question)) };
  }

  /** Its planner answers to its parent's attempt, not to a person: it reads its inbox, presses no control and is woken as a subplanner (ADR-0055 D5). */
  get answersToParent(): boolean {
    return this.link !== undefined;
  }

  /** Where its run's merge lands, as its planner is told. */
  mergeTarget(): string {
    return this.link ? 'the delegated task\'s branch' : 'the user\'s branch';
  }

  /** Its parent's attempt hears something changed that a verdict or the completion reminder may read; nobody above the root does. */
  changed(): void {
    this.link?.changed();
  }

  /** What a child below it spent, rolled up to its parent's attempt (ADR-0055 D20). */
  passUsageUp(record: UsageRecord): void {
    this.link?.usage(record);
  }

  /**
   * A child's planner turn takes one of its tree's slots, and between turns its
   * row is parked with no process; the limit it meets is its account's, and so
   * the tree's (ADR-0055 D18). A root's turn holds no slot.
   */
  abstract readonly turnsTakeTreeSlots: boolean;

  /** Why nothing may start here, what is in flight finishing first (ADR-0056 M10). */
  withdrawn(): string | null {
    return this.host.mandate().grants.has('control') ? null : 'what it may do was withdrawn above it';
  }

  /** A Stop stands at this node or above it, or its budget has stopped it (ADR-0055 D16, ADR-0056 M5). */
  get underStop(): boolean {
    return this.link?.stopped() === true || this.funds.stoppedFor() !== null;
  }

  /** Why no claim and no planner turn may start at this node, read at every start as its own Stop generation is (ADR-0055 D16). */
  nodeRefusal(): string | null {
    if (!this.link) return null;
    if (this.underStop) return this.funds.stoppedFor() ?? 'A Stop stands at or above this node, so nothing starts here.';
    return this.withdrawn();
  }

  /** Its report is what its verdict and landing go by: work behind it would land past both (ADR-0055 D7). */
  get reported(): boolean {
    return this.link?.reported() === true;
  }

  /** Why its plan takes no more changes, from any turn: the report describes it as it is (ADR-0055 D7). */
  changeRefusal(): string | null {
    return this.reported ? NODE_REPORTED : null;
  }

  /** {@link nodeRefusal}, and a report: a turn can still read a person's message, but no task may start from it. */
  startRefusal(): string | null {
    return this.nodeRefusal() ?? this.changeRefusal();
  }

  /**
   * What is ready cannot start and nothing live will free room for it, so
   * nothing ticks this again (ADR-0056 M5). A subplanner is woken, once, so it
   * can ask; {@link ChildPlanSession} ends it if nothing comes of that. A node
   * with no planner to wake stops.
   */
  startRefused(why: string): void {
    if (!this.link) {
      this.funds.stop(why);
      return;
    }
    if (this.toldStartRefused) return;
    this.toldStartRefused = true;
    this.host.refusedStart(why);
  }

  /**
   * Seat a child session in a task's worktree: what `createSession` builds it
   * with, its code root being that worktree. The task's record names it, so a
   * reopen does not prune the worktree from under it (ADR-0055 D17), and asking
   * again finds the same child. Every depth shares the root's state root,
   * lease and isolation (D11, D13). Throws for a task with no worktree (D12).
   */
  hostChild(taskId: string): ChildPlacement {
    const host = this.host;
    const sessionId = host.runs().hostChild(taskId, mintSessionId);
    const budget = this.funds.tree?.nodeOf(sessionId);
    return {
      sessionId,
      stateRoot: this.stateRoot(host.workspace()),
      rootSessionId: this.rootSessionId(host.sessionId()),
      held: () => host.heldElsewhere(),
      isolation: host.runs().childIsolation,
      pool: host.pool(),
      directory: this.children,
      ...(budget ? { budget } : {}),
    };
  }

  /**
   * A child plan's start (ADR-0055 D3): its mandate and budget carved from what
   * its delegated task has left, then a Session built in `cwd`, the task's
   * worktree, that holds both. A Continue (D17) is the same carve for the child
   * it names, whose plan loads: nothing of that child's file is read before
   * this. Its node closed as it ended, or a crash left it open and this closes
   * it: either way it stays charged what it spent, so no attempt mints budget
   * (ADR-0056 M10). Rejects with the level that refused.
   */
  async openChild(task: Task, cwd: string, link: SubplannerLink, reopening?: string): Promise<ChildNode> {
    const host = this.host;
    // Before the ledger: a tree closing waits for its children, and this one would wait for the ledger.
    if (host.closed() || link.stopped()) throw new Error(`Task "${task.title}" was stopped before its child opened.`);
    if (!host.delegationOffered) throw new Error(`Task "${task.title}" is a delegated task, and delegation is off here.`);
    const carved = await this.funds.carveFor(task, reopening);
    if (!carved.ok) throw new Error(mandateRefusalText(carved.refusal));
    const { mandate, budget } = carved;
    // A change at any level above reaches the subtree at its next check (ADR-0056 M1).
    const authority: NodeAuthority = { depth: host.depth + 1, mandate: () => heldMandate(mandate, [host.mandate()]) };
    const brief: SubplannerBrief = { protectedPaths: mandate.exclusions.protectedPaths, readOnly: task.readOnly === true, runner: task.assignedRunner };
    const placement = this.hostChild(task.id);
    // Saved as it is seated: what a crash from here on leaves to reopen it by, or discard it (D17).
    host.store().setTaskRunnerSessionId(task.id, placement.sessionId, host.store().resolveTaskRunner(task));
    host.saved();
    const saved = reopening ? loadChildSession({ baseDir: placement.stateRoot, rootSessionId: placement.rootSessionId, sessionId: reopening }) : null;
    let child: BuiltChild | undefined;
    try {
      // Its run is tied to this path: moved, it would mint a new one and leave what it had landed behind, with its tasks still reading as done.
      if (saved?.plan.isolation && saved.plan.isolation.run.workspaceRoot !== cwd) throw new Error(`Task "${task.title}" cannot reopen its child: its worktree has moved. Retry it fresh, which starts a new child.`);
      child = host.child({ task, cwd, placement, authority, brief, link });
      if (saved) child.load(pickedUp(saved.plan), saved.meta.goal);
      return child.asNode(task, mandate, (await this.reading.board())?.pins() ?? []);
    } catch (err) {
      // A built child joined the tree's slot pool as it was made, and only its destroy leaves it: left, it counts as a sibling and is ticked for good.
      try { child?.destroy(); } catch { /* the refusal that sent us here is the one to report */ }
      budget.tree.close(budget.path);
      throw err;
    }
  }

  /** A delegated task's next attempt is fresh: the child its last one left goes, whatever became of it (ADR-0055 D15). Its state stays under the root; what git could not let go throws, naming it, and the task still names the child. */
  async discardChild({ id, runnerSessionId }: Readonly<Task>): Promise<void> {
    const host = this.host;
    // As the plan holds it now; a task an edit took out is only what it was.
    const sessionId = host.store().get(id)?.runnerSessionId ?? runnerSessionId;
    if (!sessionId) return;
    await this.funds.closeChild(sessionId);
    const { refused } = await host.runs().discardChild({ baseDir: this.stateRoot(host.workspace()), rootSessionId: this.rootSessionId(host.sessionId()), sessionId });
    if (refused.length > 0) throw new Error(`The child run of its last attempt could not be discarded: ${refused.map(({ worktree, reason }) => `${worktree} (${reason})`).join(', ')}`);
    if (host.store().get(id)?.runnerSessionId === sessionId) host.store().setTaskRunnerSessionId(id, undefined);
  }
}

/** What a root is placed from: the seams a host or a test may fill. */
export interface RootPositionDeps {
  saveSession?: SaveSession;
  /** Only a test gives a root an authority from above, to hold a node to a child's mandate with no seat. */
  authority?: NodeAuthority;
  leaseHost?: LeaseHost;
  /** Where its tree keeps its log (ADR-0058 S3). */
  eventLog: (rootSessionId: string, stateRoot: string) => EventStore;
}

/** The root: its workspace is both its code root and its state root, it holds the tree's lease, and it opens the tree's ledger. */
export class RootPosition extends NodePosition {
  readonly save: SaveSession;
  readonly budget = undefined;
  readonly isolation = undefined;
  readonly turnsTakeTreeSlots = false;
  private directory: ChildDirectory | undefined;

  constructor(private readonly deps: RootPositionDeps) {
    super(undefined, deps.authority ? { authority: deps.authority } : {});
    this.save = deps.saveSession ?? saveSession;
  }

  stateRoot(workspace: string): string { return workspace; }
  rootSessionId(own: string): string { return own; }
  logLocation(workspace: string, sessionId: string): TaskLogLocation { return { baseDir: workspace, sessionId }; }
  sessionId(given: string | undefined): string | undefined { return given; }

  lease(onLost: (held: SessionHeld) => void, runLive: () => boolean): SessionLease {
    // A caller that swaps the saves keeps the process's lease files untouched too, unless it hands a host.
    const host = this.deps.leaseHost ?? (this.deps.saveSession ? undefined : processLeaseHost());
    return host ? host.lease(onLost, runLive) : UNLEASED;
  }

  run(): PlacedRun { return {}; }
  containers(settings: () => SessionRuntimeSettings): SessionRuntimeSettings['containers'] { return settings().containers; }
  refuseCheckout(): void {}

  get children(): ChildDirectory {
    const host = this.host;
    const rootSessionId = () => host.sessionId();
    this.directory ??= new ChildDirectory({
      rootSessionId,
      // A read opens no tree of its own: that would fix the root's limit before its run does.
      // The log answers for a tree whose every child was let go, so no task names one.
      ledger: async () => (this.funds.tree || hasTreeEventLog(rootSessionId(), host.workspace()) ? this.funds.ledger() : null),
      rootTask: (taskId) => host.store().get(taskId),
      saved: (sessionId) => loadChildSession({ baseDir: host.workspace(), rootSessionId: rootSessionId(), sessionId }),
      logLocation: (sessionId) => ({ baseDir: host.workspace(), sessionId, rootSessionId: rootSessionId() }),
    });
    return this.directory;
  }

  protected funding(host: NodeHost, base: FundingHost): NodeFunding {
    return new RootFunding({
      ...base,
      sessionId: () => host.sessionId(),
      openLog: (sessionId) => this.deps.eventLog(sessionId, host.workspace()),
      limit: () => host.delegationLimit(),
      warn: (message) => host.notice('warn', message),
      childrenStopped: () => host.childrenStopped(),
    });
  }

  protected seating(): NodeSeat { return new RootSeat(); }

  protected reader(host: NodeHost, base: ReadingHost): NodeReading {
    return new RootReading({ ...base, sessionId: () => host.sessionId() });
  }
}

/** What a child is placed from: the place its parent seated it in, and the attempt it answers to. */
export interface ChildPositionDeps extends NodeGiven {
  placement: ChildPlacement;
  /** Absent only for a child a test seats without an attempt: it holds a root's seat and refuses nothing. */
  link?: SubplannerLink;
  /** Its code root, the task's worktree. */
  workspace: string;
  saveSession?: SaveSession;
}

/** A child, under its parent's delegated task: its state, lease, isolation and slots are its root's, and it holds what its parent carved. */
export class ChildPosition extends NodePosition {
  readonly save: SaveSession;
  readonly budget: NodeBudget | undefined;
  readonly turnsTakeTreeSlots = true;
  private readonly placement: ChildPlacement;

  constructor({ placement, link, workspace, saveSession: save, ...given }: ChildPositionDeps) {
    super(link, given);
    // Where a child is built, so no merge below can reach the user's branch (ADR-0055 D12).
    refuseUsersCheckout(workspace, placement.stateRoot);
    this.placement = placement;
    this.save = save ?? saveUnder(placement);
    this.budget = placement.budget && reportingUp(placement.budget, link);
  }

  get isolation(): IWorktreeIsolation { return this.placement.isolation; }
  stateRoot(): string { return this.placement.stateRoot; }
  rootSessionId(): string { return this.placement.rootSessionId; }
  logLocation(_workspace: string, sessionId: string): TaskLogLocation {
    return { baseDir: this.placement.stateRoot, sessionId, rootSessionId: this.placement.rootSessionId };
  }
  sessionId(): string { return this.placement.sessionId; }
  /** A child holds no lease file: the tree's lease is its root's (ADR-0055 D13). */
  lease(): SessionLease { return childLease(this.placement.held); }

  run(): PlacedRun {
    const { stateRoot, pool, budget } = this.placement;
    const link = this.link;
    return {
      stateRoot,
      pool,
      ...(this.budget ? { budget: this.budget } : {}),
      ...(budget ? { planNode: () => budget.path } : {}),
      ...(link ? { decided: () => link.changed(), nodeRefusal: () => this.startRefusal() } : {}),
    };
  }

  /** Its root read the setting and its children take what that decided: read again, a change would put them on this host. */
  containers(): undefined { return undefined; }
  refuseCheckout(workspace: string): void { refuseUsersCheckout(workspace, this.placement.stateRoot); }
  get children(): ChildDirectory { return this.placement.directory; }

  protected funding(host: NodeHost, base: FundingHost): NodeFunding {
    return new ChildFunding({
      ...base,
      budget: this.placement.budget,
      // The node stops, as a Stop does: nothing can recall what is in flight, so this is what bounds it (ADR-0056 M5).
      stopped: (why) => {
        if (host.closed()) return;
        host.notice('warn', why);
        void host.stopSubtree();
      },
      raised: () => this.raised(),
    });
  }

  protected seating(host: NodeHost, funds: NodeFunding): NodeSeat {
    if (!this.link) return new RootSeat();
    return new ChildSeat({
      ...host.seat,
      link: this.link,
      depth: host.depth,
      directory: this.placement.directory,
      pool: this.placement.pool,
      funds,
      nodeRefusal: () => this.nodeRefusal(),
      withdrawn: () => this.withdrawn(),
    });
  }

  protected reader(_host: NodeHost, base: ReadingHost): NodeReading {
    return new ChildReading({ ...base, rootSessionId: this.placement.rootSessionId });
  }
}

/** The position `deps` place a Session at: a child where its parent gave it a placement, the root otherwise. */
export function nodePosition(deps: Pick<SessionDeps, 'placement' | 'subplanner' | 'child' | 'brief' | 'saveSession' | 'leaseHost' | 'workspaceRoot'> & Omit<RootPositionDeps, 'authority'>): NodePosition {
  const { placement, subplanner, child: authority, brief, saveSession: save, leaseHost, eventLog } = deps;
  const given = authority ? { authority } : {};
  if (placement) return new ChildPosition({ placement, workspace: deps.workspaceRoot(), ...given, ...(brief ? { brief } : {}), ...(subplanner ? { link: subplanner } : {}), ...(save ? { saveSession: save } : {}) });
  return new RootPosition({ eventLog, ...given, ...(save ? { saveSession: save } : {}), ...(leaseHost ? { leaseHost } : {}) });
}

/** A subplanner a guard lowered or that failed its restart is Act again on a Continue, which is the plan above picking it up (ADR-0056 M8). */
function pickedUp(plan: LegacyPlanState): LegacyPlanState {
  if (!plan.runSettings) return plan;
  const settings = { ...plan.runSettings, supervisorLevel: 'act' as const };
  delete settings.unsupervised;
  return { ...plan, runSettings: settings };
}

/** A child's saves, which go under its root by the id they are saved under. */
function saveUnder({ rootSessionId }: ChildPlacement): SaveSession {
  return (plan, goal, baseDir, sessionId) => { saveChildSession(plan, goal, { baseDir, rootSessionId, sessionId }); };
}

/** A node's budget that tells its parent's attempt of each record it is charged. */
function reportingUp(budget: NodeBudget, link: SubplannerLink | undefined): NodeBudget {
  if (!link) return budget;
  return {
    ...budget,
    spent: (record, on) => {
      budget.spent(record, on);
      link.usage(record);
    },
    turnSpent: (record) => {
      budget.turnSpent(record);
      link.usage(record);
    },
  };
}

const SILENT: INotification = { info() {}, warn() {}, error() {}, confirm: async () => undefined };

/**
 * The planner a child runs is the runner its delegated task names (ADR-0055
 * D5): an API planner is none, and has no Ordewell token. Its approvals go by
 * the allowlist, so what would ask runs sealed: nobody is there (ADR-0056 M8).
 */
function subplannerConfig(config: IConfig, task: Task): IConfig {
  const provider = providerForRunner(task.assignedRunner);
  if (!provider) throw new Error(`Task "${task.title}" names runner "${task.assignedRunner}", and a subplanner is a harness planner: no planner runs on it.`);
  // `allowlist` is only the setting's spelling. A policy reads it as neither allow nor deny, and asks.
  const approvalMode: ApprovalModeSetting = 'deny';
  return Object.create(config, {
    aiProvider: { value: provider, enumerable: true },
    orchestratorModel: { value: task.assignedModel?.modelId ?? '', enumerable: true },
    plannerThinkingEffort: { value: task.assignedModel?.thinkingEffort, enumerable: true },
    approvalMode: { value: approvalMode, enumerable: true },
    notifyCommand: { value: [], enumerable: true },
  }) as IConfig;
}

/**
 * A subplanner is Act with autorun, inside its mandate (ADR-0056 M7), and it
 * merges its own subtree (ADR-0055 D10). Its runners and its own process load
 * what they need unless the settings file says otherwise: a subtree multiplies
 * what each attempt's context carries, and each of a subplanner's calls is
 * charged all of it (ADR-0057 R2, R11).
 */
function subplannerSettings(settings: SessionRuntimeSettings): SessionRuntimeSettings {
  return { ...settings, taskRunnerConfig: settings.taskRunnerConfig ?? 'minimal', run: { ...RUN_SETTINGS_DEFAULTS, ...settings.run, supervisorLevel: 'act', autorun: true, mergeAtGatesAutomatically: true } };
}

/**
 * What a child is built from: what its tree shares, and what is its own. It
 * takes its parent's isolation through its placement and never one of its own
 * (ADR-0055 D11), a broadcast only a surface that selected it hears (D20), and
 * a runner view that stops only what it started.
 */
export function childSessionDeps(deps: SessionDeps, { task, cwd, placement, authority, brief, link }: ChildSpec): SessionDeps {
  const given = deps.childDeps?.(task) ?? {};
  const fsAdapter = given.fsAdapter ?? deps.fsAdapter.rootedAt?.(cwd);
  if (!fsAdapter) throw new Error('This host cannot root a planner in a task\'s worktree, so it cannot run a child plan.');
  return {
    registry: deps.registry,
    modelResolver: deps.modelResolver,
    ...(deps.openTaskLog ? { openTaskLog: deps.openTaskLog } : {}),
    ...(deps.mcpServer ? { mcpServer: deps.mcpServer } : {}),
    ...(deps.web ? { web: deps.web } : {}),
    ...(deps.execution ? { execution: deps.execution } : {}),
    ...(deps.delegationOffered !== undefined ? { delegationOffered: deps.delegationOffered } : {}),
    ...(deps.childDeps ? { childDeps: deps.childDeps } : {}),
    config: subplannerConfig(deps.config, task),
    notifications: SILENT,
    broadcast: (message) => {
      link.changed();
      placement.directory.publish(placement.sessionId, message);
    },
    onNotice: (notice) => {
      link.changed();
      placement.directory.publish(placement.sessionId, notice);
    },
    runner: ownedRunner(deps.runner),
    ...(deps.scriptRunner ? { scriptRunner: ownedRunner(deps.scriptRunner) } : {}),
    workspaceRoot: () => cwd,
    settings: () => subplannerSettings(deps.settings()),
    placement,
    child: authority,
    subplanner: link,
    brief,
    ...given,
    fsAdapter,
  };
}
