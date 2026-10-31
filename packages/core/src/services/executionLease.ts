import type { PreviousWork } from '../interfaces/IWorktreeIsolation';
import type { RunnerId, Task } from '../models/Task';
import type { AttemptIntent } from './IsolationRunController';

/*
 * The execution lease (ADR-0059): where a session runs, behind one seam. This
 * is the interface as far as `LocalWorktreeLease` needs it; what only a
 * container needs comes with the first backend that does (ADR-0059 L5).
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

export interface OpenLease {
  workspace: {
    cwd: string;
    /** The task workspace holding its worktrees, when it has any. */
    writable?: string;
    /** Whether it runs in a worktree prepared for it rather than at the root. */
    worktree: boolean;
    /** What became of the previous attempt's work, where a restore was asked for. */
    previousWork?: PreviousWork;
  };
  guarantees: GuaranteeReport;
  exportResult(session: LeaseSessionState): LeaseResult;
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
}
