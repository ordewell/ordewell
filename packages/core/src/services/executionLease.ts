import type { PreviousWork } from '../interfaces/IWorktreeIsolation';
import type { RunnerId, Task } from '../models/Task';
import type { AttemptIntent } from './IsolationRunController';

/*
 * The execution lease (ADR-0059): where a session runs, behind one seam, as
 * `LocalWorktreeLease` and the Docker backend need it. What only the egress
 * sidecar and the model gateway need comes with them (ADR-0059 L7).
 */

/** What a backend can be asked to prove (ADR-0059 L3). */
export type Guarantee = 'fs.hostHidden' | 'fs.writeScope' | 'net.allowlist' | 'net.noMetadata' | 'cred.unreadable' | 'kernel.separate' | 'limits.memory';

export const GUARANTEES: readonly Guarantee[] = ['fs.hostHidden', 'fs.writeScope', 'net.allowlist', 'net.noMetadata', 'cred.unreadable', 'kernel.separate', 'limits.memory'];

/** What a probe found: how, and when. Never declared, so an unproven entry relaxes nothing (L3). */
export interface GuaranteeProof {
  proven: boolean;
  by: string;
  at: string;
}

export type GuaranteeReport = Record<Guarantee, GuaranteeProof>;

/** An open that required a guarantee its backend's probe could not prove. */
export class LeaseGuaranteeError extends Error {
  constructor(readonly unproven: readonly Guarantee[]) {
    super(`This session requires ${unproven.join(', ')}, which its execution backend could not prove.`);
    this.name = 'LeaseGuaranteeError';
  }
}

/**
 * Work its backend would not bring back, which stays where it is and waits on
 * the user (L2): an attempt that meets it fails, and lets go of nothing.
 */
export class KeptWorkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeptWorkError';
  }
}

/** L3's one rule: an open fails on a required entry its probe did not prove, whatever the backend. */
export function refuseUnproven(required: readonly Guarantee[], report: GuaranteeReport): void {
  const unproven = required.filter((guarantee) => !report[guarantee].proven);
  if (unproven.length > 0) throw new LeaseGuaranteeError(unproven);
}

/**
 * Who asks, and in what role, which is policy input: a role is resolved to a
 * {@link LeaseSpec} before a backend sees one. `child-plan` reserves a node
 * and no slot (ADR-0055 D18). So does `merge`: it starts no session, and it
 * reaches a checkout, so a backend hears of it.
 */
export interface LeaseRequest {
  node: { sessionId: string; taskId?: string };
  role: 'planner' | 'task' | 'script' | 'child-plan' | 'merge';
  runner?: RunnerId;
}

/** Where a lease puts its session. */
export type LeaseWorkspace = { kind: 'checkout' } | { kind: 'worktree'; intent: AttemptIntent };

export interface LeaseSpec {
  /** The attempt's task, as the claim read it; a planner's lease has none. */
  task?: Task;
  workspace: LeaseWorkspace;
  /** Open fails if one of these cannot be proven. */
  required: readonly Guarantee[];
}

/** A runner's session, which is what a Continue resumes: the id on the host today, and more behind a container (L2). */
export interface LeaseSessionState {
  runner: string;
  nativeSessionId: string | null;
}

/**
 * What outlives a lease (L2): a branch is not the whole result. A synchronous
 * read: the attempt that ends saves the session before anything can read it.
 */
export interface LeaseResult {
  /** Each repo's branch, by repo path; empty for work with no worktree. */
  refs: Record<string, string>;
  sessionState: LeaseSessionState;
}

/** How a lease's session ended where the host could not watch it (L3); `expired` comes with the first backend that has a time limit. */
export type LeaseExit = 'oom' | 'killed';

/** A runner's launch, as its adapter wrote it for this host. */
export interface RunnerLaunch {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  /** Paths on this host, named in `args`, that the process reads, the one holding its token among them. */
  files: readonly string[];
}

/** What this host launches instead. */
export interface PlacedLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** End the process where it runs: killing what this host launched does not reach it. */
  stop(): void;
  /** The process has ended. */
  ended(): void;
}

/**
 * Where a lease that does not run its session on this host puts its runner. A
 * runner is still handed a cwd and nothing more (ADR-0013): only {@link RunnerProcess}
 * reads this, and an adapter writes the launch it always wrote.
 */
export interface RunnerPlacement {
  place(launch: RunnerLaunch): Promise<PlacedLaunch>;
  /** Make a listener on this host's loopback reachable from there, and answer the URL to reach it by (`endpoints.mcp`). */
  reach(url: string): Promise<string>;
  /** The blob a file holds there, as git would name it, read where the attempt's work is; undefined for what cannot be read. */
  blob(file: string): Promise<string | undefined>;
}

/** What a copy of a checkout is on where a backend keeps it: no ref of the user's is at stake, and it stands on HEAD as it is. */
export const CHECKOUT_BRANCH = 'ordewell/checkout';

/** One repository of an attempt's worktree, for a backend that keeps a copy of it elsewhere. */
export interface LeaseRepo {
  /** Relative to the workspace; `.` for a lone repository. */
  path: string;
  /** The repository on this host. */
  root: string;
  /** Its worktree for this task. */
  worktree: string;
  branch: string;
  integrationBranch: string;
  /** What Ordewell linked into the worktree, which is no attempt's work. */
  linked: readonly string[];
}

export interface OpenLease {
  workspace: {
    cwd: string;
    /** The task workspace holding its worktrees, when it has any. */
    writable?: string;
    /** Whether it runs in a worktree prepared for it rather than at the root. */
    worktree: boolean;
    /** What became of the previous attempt's work, where a restore was asked for. */
    previousWork?: PreviousWork;
    /** Each repository of its worktree, plural as a repo group's are (ADR-0014). */
    repos?: readonly LeaseRepo[];
  };
  guarantees: GuaranteeReport;
  exportResult(session: LeaseSessionState): LeaseResult;
  /** Set where the runner does not run on this host. */
  placement?: RunnerPlacement;
  /** How its session ended, once it has, where the backend can tell (L3). */
  ended?(): Promise<LeaseExit | null>;
}

/**
 * Taken in the claim's synchronous step (L1). What it reserves is given back at
 * {@link release}; the workspace it opened need not go with it: a worktree
 * outlives the lease that made it, for a repair or a continue, so what becomes
 * of it is {@link ExecutionBackend.letGo}.
 */
export interface ReservedLease {
  readonly id: string;
  /** Whether this lease holds a slot: a delegated task's and a merge's do not. */
  readonly holdsSlot: boolean;
  /** Runs after the claim, where the workspace is made. Rejects without making one once `signal` has aborted. */
  open(spec: LeaseSpec, signal: AbortSignal): Promise<OpenLease>;
  /** Idempotent and synchronous: an attempt's end frees its slot before anything awaits (ADR-0029). */
  release(reason: string): void;
}

/** One task's workspace, as a restart finds it. */
export interface LeaseRecord {
  taskId: string;
  status: string;
  worktrees: readonly string[];
}

export interface ExecutionBackend {
  /** What it can prove now. */
  probe(): Promise<GuaranteeReport>;
  /** Why this may not be reserved now, or null. Synchronous, and changes nothing: it is also asked with no claim to follow. */
  refusal(request: LeaseRequest): string | null;
  /** Synchronous, inside the claim. A refusal keeps the Session that asked, for what frees next. */
  reserve(request: LeaseRequest): { lease: ReservedLease } | { refused: string };
  /** What becomes of a task's workspace, with no lease needed: a kept worktree outlives the one that opened it. */
  letGo(taskId: string, how: { keep: boolean; landing?: Promise<unknown> | null; reason: string }): Promise<void>;
  /** What a restart finds. Starts nothing (ADR-0044). */
  list(): Promise<readonly LeaseRecord[]>;
  /**
   * Bring a task's work to its worktree, for a backend that keeps it elsewhere:
   * the half of a result that takes time and can be refused (L2). By task, since
   * a landing can come after its attempt, as a Mark complete does. Absent, the
   * work is there already. Rejects with why it must not land.
   */
  collect?(taskId: string): Promise<void>;
  /**
   * Everything it has running has gone and what was on its way has arrived, as
   * the Session around it closes. Absent, nothing outlives an attempt's runner.
   * What a next attempt comes back to stays, and it never rejects.
   */
  settle?(): Promise<void>;
  /** The workspace root's repositories, where a run knows them: a repo group's root is no repository to ask. */
  checkoutRepos?(): readonly LeaseRepo[];
  /**
   * Let go of what its tree left where only it can reach, as a Clean up gives the
   * run up. Absent, there is nothing but the worktrees. Reports what it could not
   * clear, and never rejects: it is no reason for a clean-up to fail.
   */
  reclaim?(): Promise<void>;
}
