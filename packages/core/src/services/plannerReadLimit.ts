import { DEFAULT_PLANNER_READ_LIMIT } from './runSettingsDefaults';

/** How much the planner may read itself in one turn: calls, and the bytes their results held. */
export interface ReadLimit {
  calls: number;
  bytes: number;
}

export type ReadAdmission = { allowed: true } | { allowed: false; reason: string };

export interface PlannerReadLimitOptions {
  /** Read per call, so a settings change applies at once; undefined is off. */
  limit: () => ReadLimit | undefined;
  /** The planner turn in progress; a new one starts the count over. */
  turn: () => string | undefined;
}

const ALLOWED: ReadAdmission = { allowed: true };
const KB = 1024;

function kb(bytes: number): string {
  return `${Math.round(bytes / KB)} KB`;
}

/**
 * The planner's own workspace reads and commands in one turn, counted and,
 * past the limit, refused (ADR-0068). It narrows the exploration envelope
 * (ADR-0008) and never widens it: a read it admits is still decided there.
 * What a research agent or task reads is never charged here, and web reads
 * and task reads have budgets of their own. The refusal is written for the
 * planner: the prompt alone did not stop a model from reading areas it had
 * already delegated, so the refusal says where the rest of the reading goes.
 */
export class PlannerReadLimit {
  private spent = { turn: undefined as string | undefined, calls: 0, bytes: 0 };

  constructor(private readonly opts: PlannerReadLimitOptions) {}

  /** Whether the limit is on now; a harness asks this when it decides which of its native reads must ask. */
  get enabled(): boolean {
    return this.opts.limit() !== undefined;
  }

  /** Counts one read before it runs, or refuses it once the turn has reached either limit. */
  admit(): ReadAdmission {
    const limit = this.opts.limit();
    if (!limit) return ALLOWED;
    const spent = this.current();
    if (spent.calls >= limit.calls || spent.bytes >= limit.bytes) {
      return {
        allowed: false,
        reason: `Read limit reached: you have made ${spent.calls} ${spent.calls === 1 ? 'read' : 'reads'} this turn (${kb(spent.bytes)}), so this one did not run. `
          + 'Do not read further yourself: delegate what is left to a research agent or a research task, naming the area it should cover.',
      };
    }
    spent.calls++;
    return ALLOWED;
  }

  /** Gives back a call admitted and then refused by the envelope, which read nothing. */
  refund(): void {
    const spent = this.current();
    if (spent.calls > 0) spent.calls--;
  }

  /** The bytes an admitted read's result held, before any truncation for the log or the model. */
  charge(bytes: number): void {
    if (!this.opts.limit()) return;
    this.current().bytes += bytes;
  }

  /** The planner's budget-block line, or nothing while the limit is off. */
  line(): string | undefined {
    const limit = this.opts.limit();
    if (!limit) return undefined;
    const spent = this.current();
    const calls = Math.max(0, limit.calls - spent.calls);
    const bytes = Math.max(0, limit.bytes - spent.bytes);
    return `Own reads left this turn: ${calls} calls or ${kb(bytes)}, whichever runs out first; then delegate.`;
  }

  private current(): { calls: number; bytes: number } {
    const turn = this.opts.turn();
    if (this.spent.turn !== turn) this.spent = { turn, calls: 0, bytes: 0 };
    return this.spent;
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function limitOf(calls: number | undefined, kbs: number | undefined): ReadLimit {
  return { calls: calls ?? DEFAULT_PLANNER_READ_LIMIT.calls, bytes: (kbs ?? DEFAULT_PLANNER_READ_LIMIT.kb) * KB };
}

/** The settings file's `plannerReadLimit`, as written: `true`, or `{ calls?, kb? }`; anything else is off. */
export function readLimitSetting(raw: unknown): true | { calls?: number; kb?: number } | undefined {
  if (raw === true) return true;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { calls, kb: kbs } = raw as Record<string, unknown>;
  return { ...(positiveInt(calls) ? { calls: positiveInt(calls) } : {}), ...(positiveInt(kbs) ? { kb: positiveInt(kbs) } : {}) };
}

/** `on`, `off`, or `<calls>,<kb>`; undefined for anything else, which leaves the file's word standing. */
function envLimit(raw: string | undefined): ReadLimit | null | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'off' || value === '0' || value === 'false') return null;
  if (value === 'on' || value === '1' || value === 'true') return limitOf(undefined, undefined);
  const match = /^(\d+)\s*,\s*(\d+)$/.exec(value);
  if (!match) return undefined;
  const [calls, kbs] = [Number(match[1]), Number(match[2])];
  return calls > 0 && kbs > 0 ? limitOf(calls, kbs) : undefined;
}

/**
 * The limit in force: `ORDEWELL_PLANNER_READ_LIMIT` when it says something,
 * as the web-read budget's variable does, else the settings file. Off unless
 * one of them turns it on.
 */
export function plannerReadLimitOf(file: unknown, env: string | undefined): ReadLimit | undefined {
  const fromEnv = envLimit(env);
  if (fromEnv !== undefined) return fromEnv ?? undefined;
  const setting = readLimitSetting(file);
  if (setting === undefined) return undefined;
  return setting === true ? limitOf(undefined, undefined) : limitOf(setting.calls, setting.kb);
}
