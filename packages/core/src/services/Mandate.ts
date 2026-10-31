import type { ExecutionCommandName, SupervisorLevel } from '../models/Execution';
import type { RunnerId } from '../models/Task';
import type { EffectRules } from './effectAllowlist';

/**
 * The mandate (ADR-0056): what a node may do without a person, and within what
 * limits. The root's is derived on each read from today's settings and never
 * saved; a child's is one pure function of its parent's and its request, which
 * can only narrow what the parent may hand on. Authority only: capability stays
 * at the boundary a session runs in, and a prompt enforces nothing.
 */

export const GRANTS = ['observe', 'steer', 'control', 'replan', 'approve', 'delegate', 'effect', 'research', 'merge'] as const;

/** Each is a set of things a node may do unasked (M2). */
export type Grant = (typeof GRANTS)[number];

/** What a mandate could not finish without: a child holds these unasked, and `narrow` refuses one that would lack any (M2). */
export const FLOOR_GRANTS: readonly Grant[] = ['observe', 'steer', 'control', 'replan', 'approve', 'merge'];

/** The shape of a tree, by ADR-0055 D19: refused past the hard cap, never dropped. */
export const SHAPE_LIMITS = {
  depth: { default: 2, hard: 4 },
  delegatedTasks: { default: 8, hard: 30 },
  tasksPerPlan: { default: 30, hard: 100 },
} as const;

/** What a child is given to run in when its task states no time (M3). */
export const DEFAULT_CHILD_WALL_CLOCK_MS = 24 * 60 * 60 * 1000;

export interface MandateLimits {
  /** The node's token budget; the root's is the tree's, from the delegation setting (M3, M5). */
  tokens: number;
  /** Null: no limit, which only the root has. */
  wallClockMs: number | null;
  /** How many levels may still open below this node. */
  depth: number;
  delegatedTasks: number;
  tasksPerPlan: number;
  runners: readonly RunnerId[];
  /** The models a runner is held to; a runner not named may use any it offers, as the user's allowlist reads. */
  models: Readonly<Record<RunnerId, readonly string[]>>;
}

export interface MandateExclusions {
  protectedPaths: readonly string[];
}

export interface Mandate {
  /** What this node may do. */
  grants: ReadonlySet<Grant>;
  /** What it may hand a child. */
  grantable: ReadonlySet<Grant>;
  /** Read in place of the global level. */
  autonomy: 'full' | 'guarded';
  limits: MandateLimits;
  /** These only accumulate. */
  exclusions: MandateExclusions;
  /** One per level, each with its own `!` rules: a command must match at every level (M4). */
  effectRules: readonly EffectRules[];
}

/** What the root's mandate is read from, each where it lives today (M1). */
export interface RootSettings {
  /** The run's own copy: where a guard or a failure lowers it, and the user's change lands. */
  level: SupervisorLevel;
  autorun: boolean;
  autonomous: boolean;
  /** The tree's budget; 0 is delegation off (ADR-0055 D21). */
  delegationTokens: number;
  /** The effect allowlist, absent where nothing was read. */
  effects?: EffectRules;
  runners: readonly RunnerId[];
  models: Readonly<Record<RunnerId, readonly string[]>>;
}

/** What a delegated task asks of the mandate it is given. `grants` names what it asks for past the floor; absent asks for nothing. */
export interface MandateRequest {
  /** The level of the node narrowing, the root being 0: the one a refusal names. */
  level: number;
  grants?: readonly Grant[];
  autonomy?: Mandate['autonomy'];
  /** A delegated task must carry one (M5). */
  tokens?: number;
  wallClockMs?: number;
  depth?: number;
  delegatedTasks?: number;
  tasksPerPlan?: number;
  runners?: readonly RunnerId[];
  models?: Readonly<Record<RunnerId, readonly string[]>>;
  protectedPaths?: readonly string[];
  effectRules?: EffectRules;
}

export interface MandateRefusal {
  level: number;
  field: string;
  asked: string;
  there: string;
}

export type Narrowed = { ok: true; mandate: Mandate } | { ok: false; refusal: MandateRefusal };

export function mandateRefusalText({ level, field, asked, there }: MandateRefusal): string {
  return `Level ${level} refused ${field}: asked ${asked}, and there is ${there}.`;
}

/** By the level alone: autorun, autonomy, the effect allowlist and delegation are settings of their own (M2). */
const LEVEL_GRANTS: Record<SupervisorLevel, readonly Grant[]> = {
  off: ['research'],
  watch: ['observe', 'research'],
  act: ['observe', 'steer', 'control', 'replan', 'research', 'merge'],
};

/** What delegation on lets a subplanner hold, whatever the root's level: the level is what the root planner does in its own turns (M2). */
const DELEGATED_GRANTS: readonly Grant[] = [...FLOOR_GRANTS, 'research', 'delegate'];

/**
 * The root's mandate, as it stands now (M1): built afresh on each read, so an
 * Act that a guard lowered reads Watch at the next check, and nothing saved
 * could disagree with the settings.
 */
export function rootMandate(settings: RootSettings): Mandate {
  const effect = (settings.effects?.rules.length ?? 0) > 0;
  const delegation = settings.delegationTokens > 0;
  return {
    grants: new Set<Grant>([
      ...LEVEL_GRANTS[settings.level],
      ...(settings.autorun ? ['approve' as const] : []),
      ...(effect ? ['effect' as const] : []),
      ...(delegation ? ['delegate' as const] : []),
    ]),
    grantable: new Set<Grant>(delegation ? [...DELEGATED_GRANTS, ...(effect ? ['effect' as const] : [])] : []),
    autonomy: settings.autonomous ? 'full' : 'guarded',
    limits: {
      tokens: settings.delegationTokens,
      wallClockMs: null,
      depth: SHAPE_LIMITS.depth.default,
      delegatedTasks: SHAPE_LIMITS.delegatedTasks.default,
      tasksPerPlan: SHAPE_LIMITS.tasksPerPlan.default,
      runners: settings.runners,
      models: settings.models,
    },
    exclusions: { protectedPaths: [] },
    effectRules: settings.effects ? [settings.effects] : [],
  };
}

/**
 * What holds at a node now (M1): its saved mandate within every ancestor's
 * `grantable` as it stands, so a change at the root reaches the subtree at the
 * next check. This reading intersects and refuses nothing: the floor binds
 * {@link narrow}, which writes a new child, not this.
 */
export function heldMandate(saved: Mandate, ancestors: readonly Mandate[]): Mandate {
  const within = (grants: ReadonlySet<Grant>) => new Set([...grants].filter((grant) => ancestors.every((ancestor) => ancestor.grantable.has(grant))));
  return { ...saved, grants: within(saved.grants), grantable: within(saved.grantable) };
}

type Ruled<T> = { value: T } | { refused: Omit<MandateRefusal, 'level'> };

type Rules<Of, From> = { [K in keyof Of]-?: (parent: From, request: MandateRequest) => Ruled<Of[K]> };

const listed = (grants: Iterable<Grant>): string => [...grants].sort().join(', ') || 'nothing';

const lesser = (limit: 'delegatedTasks' | 'tasksPerPlan') => (parent: MandateLimits, request: MandateRequest): Ruled<number> => {
  const { hard } = SHAPE_LIMITS[limit];
  const asked = request[limit];
  if (asked !== undefined && asked > hard) return { refused: { field: `limits.${limit}`, asked: String(asked), there: `a hard limit of ${hard}` } };
  return { value: Math.min(parent[limit], asked ?? parent[limit]) };
};

function intersectModels(parent: MandateLimits['models'], asked: MandateLimits['models'] = {}): MandateLimits['models'] {
  const models: Record<RunnerId, readonly string[]> = { ...asked, ...parent };
  for (const runner of Object.keys(parent)) {
    if (asked[runner]) models[runner] = parent[runner].filter((model) => asked[runner].includes(model));
  }
  return models;
}

const LIMIT_RULES: Rules<MandateLimits, MandateLimits> = {
  tokens: ({ tokens }, { tokens: asked }) => {
    if (asked === undefined || asked <= 0 || asked > tokens) return { refused: { field: 'limits.tokens', asked: asked === undefined ? 'none' : String(asked), there: String(tokens) } };
    return { value: asked };
  },
  wallClockMs: ({ wallClockMs: left }, { wallClockMs: asked }) => {
    if (asked === undefined) return { value: left === null ? DEFAULT_CHILD_WALL_CLOCK_MS : Math.min(left, DEFAULT_CHILD_WALL_CLOCK_MS) };
    if (asked <= 0 || (left !== null && asked > left)) return { refused: { field: 'limits.wallClockMs', asked: String(asked), there: left === null ? 'no limit' : String(left) } };
    return { value: asked };
  },
  depth: ({ depth }, { depth: asked }) => {
    if (depth <= 0) return { refused: { field: 'limits.depth', asked: 'a child', there: 'no depth left' } };
    const { hard } = SHAPE_LIMITS.depth;
    if (asked !== undefined && asked > hard) return { refused: { field: 'limits.depth', asked: String(asked), there: `a hard limit of ${hard}` } };
    return { value: Math.min(depth - 1, asked ?? depth - 1) };
  },
  delegatedTasks: lesser('delegatedTasks'),
  tasksPerPlan: lesser('tasksPerPlan'),
  runners: ({ runners }, { runners: asked }) => ({ value: asked ? runners.filter((runner) => asked.includes(runner)) : runners }),
  models: ({ models }, { models: asked }) => ({ value: intersectModels(models, asked) }),
};

/** Both `grants` and `grantable`: a child hands on what it holds. `research`, `delegate` and `effect` come only by name (M2). */
function handedOn(parent: Mandate, request: MandateRequest): Ruled<ReadonlySet<Grant>> {
  const asked = new Set<Grant>([...FLOOR_GRANTS, ...(request.grants ?? [])]);
  const lost = FLOOR_GRANTS.some((grant) => !parent.grantable.has(grant));
  if (lost) return { refused: { field: 'grants', asked: listed(asked), there: listed(parent.grantable) } };
  return { value: new Set([...asked].filter((grant) => parent.grantable.has(grant))) };
}

/** Each field's rule. Mapped over the keys, so a new field or limit fails to compile until it has one. */
const MANDATE_RULES: Rules<Mandate, Mandate> = {
  grants: handedOn,
  grantable: handedOn,
  autonomy: ({ autonomy }, { autonomy: asked }) => ({ value: autonomy === 'guarded' || asked === 'guarded' ? 'guarded' : 'full' }),
  limits: ({ limits }, request) => applyRules<MandateLimits, MandateLimits>(LIMIT_RULES, limits, request),
  exclusions: ({ exclusions }, { protectedPaths }) => ({ value: { protectedPaths: [...new Set([...exclusions.protectedPaths, ...(protectedPaths ?? [])])] } }),
  effectRules: ({ effectRules }, { effectRules: asked }) => ({ value: asked ? [...effectRules, asked] : effectRules }),
};

function applyRules<Of extends object, From>(rules: Rules<Of, From>, parent: From, request: MandateRequest): Ruled<Of> {
  const value = {} as Of;
  for (const key of Object.keys(rules) as (keyof Of)[]) {
    const ruled = rules[key](parent, request);
    if ('refused' in ruled) return ruled;
    value[key] = ruled.value;
  }
  return { value };
}

/**
 * A child's mandate (M4), or the refusal that names the level that refused,
 * the field, what was asked and what is there. Pure, and written to be proved:
 * no result is wider than its parent. `parent.limits.tokens` and `wallClockMs`
 * are what the parent has left, which is the caller's to read.
 */
export function narrow(parent: Mandate, request: MandateRequest): Narrowed {
  const ruled = applyRules<Mandate, Mandate>(MANDATE_RULES, parent, request);
  return 'refused' in ruled
    ? { ok: false, refusal: { level: request.level, ...ruled.refused } }
    : { ok: true, mandate: ruled.value };
}

/** The grant each command needs (M2); null for the user's own controls, which no grant reaches. */
export const COMMAND_GRANTS: Readonly<Record<ExecutionCommandName, Grant | null>> = {
  run_plan: 'control',
  run_task: 'control',
  stop_task: 'control',
  stop_run: 'control',
  retry_task: 'control',
  message_task: 'steer',
  answer_approval: 'steer',
  merge_all: 'merge',
  skip_task: 'control',
  force_start: null,
  mark_complete: null,
  mark_not_done: null,
  revert_task: null,
  interrupt_task: null,
  force_send_queued: null,
  remove_queued: null,
  cancel_resume: null,
  answer_checkpoint: 'steer',
  approve_review: null,
  run_script: 'control',
};

/** Whether a mandate lets a node run `command` unasked. */
export function allowsCommand(mandate: Mandate, command: ExecutionCommandName): boolean {
  const grant = COMMAND_GRANTS[command];
  return grant !== null && mandate.grants.has(grant);
}

/** Why a node refuses what its mandate leaves out, naming the level that refused (M4). */
export function missingGrant(depth: number, mandate: Mandate, needed: string): string {
  return `Level ${depth} refused this: it needs the ${needed} grant, and this node holds ${listed(mandate.grants)}.`;
}

/** A planner tool no grant reaches is a read, offered to every node. */
const TOOL_GRANTS: readonly (readonly [string, Grant])[] = [
  ...Object.entries(COMMAND_GRANTS).flatMap(([tool, grant]) => (grant ? [[tool, grant] as const] : [])),
  ['submit_plan', 'replan'],
  ['edit_plan', 'replan'],
];

/**
 * The planner tools a child's token leaves out (M6), in one order so the list
 * it is served is the same list on every start: a changed list breaks the
 * prompt cache. A courtesy, read as its session starts: what stops a call is
 * the seam, so a grant lost mid-session is refused with the list unchanged.
 */
export function withheldPlannerTools(mandate: Mandate): string[] {
  return TOOL_GRANTS.filter(([, grant]) => !mandate.grants.has(grant)).map(([tool]) => tool);
}

/** What a node reads of its own authority, at each check (M1). */
export interface NodeAuthority {
  /** How far below the root, which is 0 and where a person remains. */
  readonly depth: number;
  /** The mandate that holds now. `level` is what the root's is read at; a child's does not depend on it. */
  mandate(level: SupervisorLevel): Mandate;
}

/**
 * Whether a node's runners take their autonomous modes (M6): a child reads its
 * `autonomy`, and the root the global level, which `rootMandate` reads too.
 */
export function autonomousAt(child: NodeAuthority | undefined, global: boolean): boolean {
  return child ? child.mandate('off').autonomy === 'full' : global;
}

/** The root: its settings read as each check asks, the level included, which each caller names. */
export function rootAuthority(settings: () => Omit<RootSettings, 'level'>): NodeAuthority {
  return { depth: 0, mandate: (level) => rootMandate({ ...settings(), level }) };
}
