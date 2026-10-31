import { describe, it, expect } from 'vitest';
import type { ExecutionCommandName, SupervisorLevel } from '../../models/Execution';
import { parseEffectAllowlist, type EffectRules } from '../effectAllowlist';
import {
  COMMAND_GRANTS, FLOOR_GRANTS, GRANTS, SHAPE_LIMITS, heldMandate, mandateRefusalText, narrow, rootMandate, withheldPlannerTools,
  type Grant, type Mandate, type MandateLimits, type MandateRequest, type RootSettings,
} from '../Mandate';
import { PLANNER_TOOLS } from '../mcp';

const RULES = parseEffectAllowlist(['git push origin *']);
const NO_RULES = parseEffectAllowlist([]);

const root = (over: Partial<RootSettings> = {}): Mandate => rootMandate({
  level: 'watch', autorun: false, autonomous: false, delegationTokens: 0, effects: NO_RULES, runners: ['claude-code', 'codex'], models: { codex: ['gpt-5'] }, ...over,
});

const names = (grants: ReadonlySet<Grant>) => [...grants].sort();

describe('the root\'s mandate is derived from today\'s settings (ADR-0056 M1, M2)', () => {
  const LEVELS: [SupervisorLevel, Grant[]][] = [
    ['off', ['research']],
    ['watch', ['observe', 'research']],
    ['act', ['control', 'merge', 'observe', 'replan', 'research', 'steer']],
  ];

  for (const [level, grants] of LEVELS) {
    it(`gives a supervisor at ${level} what the table says, and nothing to hand on`, () => {
      const mandate = root({ level });
      expect(names(mandate.grants)).toEqual(grants);
      expect(names(mandate.grantable)).toEqual([]);
    });
  }

  it('reads autorun as `approve`', () => {
    expect(root({ autorun: true }).grants.has('approve')).toBe(true);
    expect(root({ autorun: false }).grants.has('approve')).toBe(false);
  });

  it('reads Full and Guarded as `autonomy`', () => {
    expect(root({ autonomous: true }).autonomy).toBe('full');
    expect(root({ autonomous: false }).autonomy).toBe('guarded');
  });

  it('reads the effect allowlist as `effect`, its rules the first level of `effectRules`', () => {
    expect(root({ effects: NO_RULES }).grants.has('effect')).toBe(false);
    const covered = root({ effects: RULES });
    expect(covered.grants.has('effect')).toBe(true);
    expect(covered.effectRules).toEqual([RULES]);
  });

  it('holds what SessionCatalog allows, and no limit on time', () => {
    const { limits } = root();
    expect(limits.runners).toEqual(['claude-code', 'codex']);
    expect(limits.models).toEqual({ codex: ['gpt-5'] });
    expect(limits.wallClockMs).toBeNull();
  });

  it('takes the shape limits at their defaults (ADR-0055 D19)', () => {
    const { limits } = root();
    expect([limits.depth, limits.delegatedTasks, limits.tasksPerPlan]).toEqual([2, 8, 30]);
  });

  it('has no token budget with delegation off', () => {
    expect(root().limits.tokens).toBe(0);
    expect(root().grants.has('delegate')).toBe(false);
  });

  it('with delegation on, holds `delegate`, takes the tree\'s budget, and fills `grantable` whatever the level', () => {
    for (const level of ['off', 'watch', 'act'] as const) {
      const mandate = root({ level, delegationTokens: 5_000_000 });
      expect(mandate.grants.has('delegate')).toBe(true);
      expect(mandate.limits.tokens).toBe(5_000_000);
      expect(names(mandate.grantable)).toEqual(['approve', 'control', 'delegate', 'merge', 'observe', 'replan', 'research', 'steer']);
    }
  });

  it('hands on `effect` only while the root holds it', () => {
    expect(root({ delegationTokens: 1, effects: RULES }).grantable.has('effect')).toBe(true);
    expect(root({ delegationTokens: 1, effects: NO_RULES }).grantable.has('effect')).toBe(false);
  });

  it('is built afresh from what it is given, so a guard\'s lowering reads at the next check', () => {
    const settings: RootSettings = { level: 'act', autorun: false, autonomous: false, delegationTokens: 0, effects: NO_RULES, runners: [], models: {} };
    expect(rootMandate(settings).grants.has('control')).toBe(true);
    settings.level = 'watch';
    expect(rootMandate(settings).grants.has('control')).toBe(false);
  });
});

describe('what a command needs (ADR-0056 M2)', () => {
  const USERS_OWN: ExecutionCommandName[] = ['force_start', 'mark_complete', 'mark_not_done', 'revert_task', 'interrupt_task', 'force_send_queued', 'remove_queued', 'cancel_resume', 'approve_review'];

  it('reads the grants table: `control`, `steer` and `merge`, and no grant for what is the user\'s own', () => {
    expect(COMMAND_GRANTS).toEqual({
      run_plan: 'control', run_task: 'control', run_script: 'control', retry_task: 'control', stop_task: 'control', stop_run: 'control', skip_task: 'control',
      message_task: 'steer', answer_checkpoint: 'steer', answer_approval: 'steer',
      merge_all: 'merge',
      ...Object.fromEntries(USERS_OWN.map((command) => [command, null])),
    });
  });
});

/** A small deterministic generator (mulberry32), so a failure is a seed anyone can run again. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const chance = (p = 0.5) => next() < p;
  const some = <T>(from: readonly T[]): T[] => from.filter(() => chance());
  return { int, chance, some };
}

type Random = ReturnType<typeof random>;

const RUNNERS = ['claude-code', 'codex', 'opencode'];
const MODELS = ['m1', 'm2', 'm3'];
const PATHS = ['src/a', 'src/b', 'secrets/'];
const EFFECTS: readonly EffectRules[] = [parseEffectAllowlist(['git push origin *']), parseEffectAllowlist(['gh release create *', '!git push'])];

function someModels(r: Random): Record<string, readonly string[]> {
  return Object.fromEntries(r.some(RUNNERS).map((runner) => [runner, r.some(MODELS)]));
}

function someMandate(r: Random): Mandate {
  const limits: MandateLimits = {
    tokens: r.int(0, 1000),
    wallClockMs: r.chance(0.3) ? null : r.int(1, 1000),
    depth: r.int(0, SHAPE_LIMITS.depth.hard),
    delegatedTasks: r.int(0, SHAPE_LIMITS.delegatedTasks.hard),
    tasksPerPlan: r.int(0, SHAPE_LIMITS.tasksPerPlan.hard),
    runners: r.some(RUNNERS),
    models: someModels(r),
  };
  // Mostly enough to hand on, or almost nothing would get past the floor.
  const grantable = new Set<Grant>(r.chance(0.8) ? [...FLOOR_GRANTS, ...r.some<Grant>(GRANTS)] : r.some<Grant>(GRANTS));
  return {
    grants: new Set(r.some<Grant>(GRANTS)),
    grantable,
    autonomy: r.chance() ? 'full' : 'guarded',
    limits,
    exclusions: { protectedPaths: r.some(PATHS) },
    effectRules: r.some(EFFECTS),
  };
}

function someRequest(r: Random, parent: Mandate): MandateRequest {
  const maybe = <T>(value: () => T): T | undefined => (r.chance() ? value() : undefined);
  return {
    level: r.int(0, 3),
    grants: maybe(() => r.some<Grant>(GRANTS)),
    autonomy: maybe(() => (r.chance() ? 'full' as const : 'guarded' as const)),
    // Past the parent's as often as under it: a request is free to ask.
    tokens: maybe(() => r.int(1, Math.max(1, parent.limits.tokens * 2))),
    wallClockMs: maybe(() => r.int(1, 2000)),
    depth: maybe(() => r.int(0, SHAPE_LIMITS.depth.hard + 1)),
    delegatedTasks: maybe(() => r.int(0, SHAPE_LIMITS.delegatedTasks.hard + 1)),
    tasksPerPlan: maybe(() => r.int(0, SHAPE_LIMITS.tasksPerPlan.hard + 1)),
    runners: maybe(() => r.some(RUNNERS)),
    models: maybe(() => someModels(r)),
    protectedPaths: maybe(() => r.some(PATHS)),
    effectRules: maybe(() => EFFECTS[r.int(0, EFFECTS.length - 1)]),
  };
}

const within = <T>(child: Iterable<T>, parent: Iterable<T>) => {
  const allowed = new Set(parent);
  return [...child].every((item) => allowed.has(item));
};

const NOT_WIDER_LIMIT: { [K in keyof MandateLimits]: (child: MandateLimits, parent: MandateLimits) => boolean } = {
  tokens: (c, p) => c.tokens <= p.tokens,
  wallClockMs: (c, p) => p.wallClockMs === null || (c.wallClockMs !== null && c.wallClockMs <= p.wallClockMs),
  depth: (c, p) => c.depth <= p.depth - 1,
  delegatedTasks: (c, p) => c.delegatedTasks <= p.delegatedTasks,
  tasksPerPlan: (c, p) => c.tasksPerPlan <= p.tasksPerPlan,
  runners: (c, p) => within(c.runners, p.runners),
  models: (c, p) => Object.entries(p.models).every(([runner, models]) => c.models[runner] !== undefined && within(c.models[runner], models)),
};

/** Keyed as the type is, so a new field fails to compile here too until it says what wider means for it. */
const NOT_WIDER: { [K in keyof Mandate]: (child: Mandate, parent: Mandate) => boolean } = {
  grants: (c, p) => within(c.grants, p.grantable),
  grantable: (c, p) => within(c.grantable, p.grantable),
  autonomy: (c, p) => p.autonomy === 'full' || c.autonomy === 'guarded',
  limits: (c, p) => Object.values(NOT_WIDER_LIMIT).every((notWider) => notWider(c.limits, p.limits)),
  exclusions: (c, p) => within(p.exclusions.protectedPaths, c.exclusions.protectedPaths),
  effectRules: (c, p) => p.effectRules.every((rules, level) => c.effectRules[level] === rules),
};

describe('narrow is one pure function that cannot widen (ADR-0056 M4)', () => {
  const RUNS = 5000;

  it('no generated result is wider than its parent, field by field', () => {
    let narrowed = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = random(seed);
      const parent = someMandate(r);
      const request = someRequest(r, parent);
      const result = narrow(parent, request);
      if (!result.ok) continue;
      narrowed++;
      for (const [field, notWider] of Object.entries(NOT_WIDER)) {
        expect(notWider(result.mandate, parent), `${field}, seed ${seed}`).toBe(true);
      }
      for (const [limit, notWider] of Object.entries(NOT_WIDER_LIMIT)) {
        expect(notWider(result.mandate.limits, parent.limits), `limits.${limit}, seed ${seed}`).toBe(true);
      }
    }
    // A property nothing reached proves nothing.
    expect(narrowed).toBeGreaterThan(RUNS / 10);
  });

  it('every refusal names the level, the field, what was asked and what is there', () => {
    let refused = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = random(seed);
      const parent = someMandate(r);
      const request = someRequest(r, parent);
      const result = narrow(parent, request);
      if (result.ok) continue;
      refused++;
      expect(result.refusal.level).toBe(request.level);
      expect(result.refusal.field).not.toBe('');
      expect(result.refusal.asked).not.toBe('');
      expect(result.refusal.there).not.toBe('');
    }
    expect(refused).toBeGreaterThan(RUNS / 10);
  });

  it('leaves what it was given as it was', () => {
    const parent = root({ delegationTokens: 100, effects: RULES });
    const before = JSON.stringify({ ...parent, grants: [...parent.grants], grantable: [...parent.grantable] });
    narrow(parent, { level: 0, tokens: 10, runners: ['codex'], protectedPaths: ['src/'], effectRules: EFFECTS[1] });
    expect(JSON.stringify({ ...parent, grants: [...parent.grants], grantable: [...parent.grantable] })).toBe(before);
  });
});

describe('narrow, each rule on its own (ADR-0056 M4)', () => {
  const delegating = root({ delegationTokens: 1000, effects: RULES, runners: ['claude-code', 'codex'], models: { 'claude-code': ['m1', 'm2'] } });
  const child = (request: Partial<MandateRequest> = {}) => {
    const result = narrow(delegating, { level: 0, tokens: 100, ...request });
    if (!result.ok) throw new Error(mandateRefusalText(result.refusal));
    return result.mandate;
  };
  const refusal = (parent: Mandate, request: Partial<MandateRequest>) => {
    const result = narrow(parent, { level: 1, tokens: 100, ...request });
    if (result.ok) throw new Error('it was not refused');
    return result.refusal;
  };

  it('holds the floor without asking, at a root whose level holds none of it', () => {
    expect(names(child().grants)).toEqual(['approve', 'control', 'merge', 'observe', 'replan', 'steer']);
  });

  it('gives `research`, `delegate` and `effect` only by name', () => {
    expect(names(child({ grants: ['research', 'effect'] }).grants)).toEqual(['approve', 'control', 'effect', 'merge', 'observe', 'replan', 'research', 'steer']);
  });

  it('hands on what it holds', () => {
    const mandate = child({ grants: ['delegate'] });
    expect(names(mandate.grantable)).toEqual(names(mandate.grants));
  });

  it('drops a name past the floor that the parent cannot hand on', () => {
    const withoutEffect = root({ delegationTokens: 1000, effects: NO_RULES });
    const result = narrow(withoutEffect, { level: 0, tokens: 100, grants: ['effect'] });
    expect(result.ok && result.mandate.grants.has('effect')).toBe(false);
  });

  it('refuses a mandate that would lose a floor grant', () => {
    const noDelegation = root();
    expect(refusal(noDelegation, {})).toEqual({ level: 1, field: 'grants', asked: 'approve, control, merge, observe, replan, steer', there: 'nothing' });
  });

  it('takes the lower autonomy', () => {
    expect(child({ autonomy: 'full' }).autonomy).toBe('guarded');
    const full = root({ delegationTokens: 1000, autonomous: true });
    const result = narrow(full, { level: 0, tokens: 1, autonomy: 'guarded' });
    expect(result.ok && result.mandate.autonomy).toBe('guarded');
  });

  it('must carry a token budget, carved from what the parent has', () => {
    expect(child({ tokens: 1000 }).limits.tokens).toBe(1000);
    expect(refusal(delegating, { tokens: 1001 })).toEqual({ level: 1, field: 'limits.tokens', asked: '1001', there: '1000' });
    expect(refusal(delegating, { tokens: undefined })).toEqual({ level: 1, field: 'limits.tokens', asked: 'none', there: '1000' });
    expect(refusal(delegating, { tokens: 0 })).toEqual({ level: 1, field: 'limits.tokens', asked: '0', there: '1000' });
  });

  it('gives a day when the task states no time, and never more than the parent has', () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(child().limits.wallClockMs).toBe(DAY);
    const hour = { ...delegating, limits: { ...delegating.limits, wallClockMs: 3_600_000 } };
    const result = narrow(hour, { level: 1, tokens: 1 });
    expect(result.ok && result.mandate.limits.wallClockMs).toBe(3_600_000);
    expect(refusal(hour, { wallClockMs: 3_600_001 })).toEqual({ level: 1, field: 'limits.wallClockMs', asked: '3600001', there: '3600000' });
  });

  it('takes one off the depth, and refuses at 0', () => {
    expect(child().limits.depth).toBe(1);
    const bottom = { ...delegating, limits: { ...delegating.limits, depth: 0 } };
    expect(refusal(bottom, {})).toEqual({ level: 1, field: 'limits.depth', asked: 'a child', there: 'no depth left' });
  });

  it('takes the lesser of the shape limits, and refuses past a hard cap (ADR-0055 D19)', () => {
    expect(child({ delegatedTasks: 2 }).limits.delegatedTasks).toBe(2);
    expect(child({ delegatedTasks: 20 }).limits.delegatedTasks).toBe(8);
    expect(child({ tasksPerPlan: 40 }).limits.tasksPerPlan).toBe(30);
    expect(refusal(delegating, { depth: 5 })).toEqual({ level: 1, field: 'limits.depth', asked: '5', there: 'a hard limit of 4' });
    expect(refusal(delegating, { delegatedTasks: 31 })).toEqual({ level: 1, field: 'limits.delegatedTasks', asked: '31', there: 'a hard limit of 30' });
    expect(refusal(delegating, { tasksPerPlan: 101 })).toEqual({ level: 1, field: 'limits.tasksPerPlan', asked: '101', there: 'a hard limit of 100' });
  });

  it('intersects runners and models', () => {
    expect(child({ runners: ['codex', 'opencode'] }).limits.runners).toEqual(['codex']);
    expect(child({ models: { 'claude-code': ['m2', 'm3'], codex: ['g1'] } }).limits.models).toEqual({ 'claude-code': ['m2'], codex: ['g1'] });
    expect(child().limits.models).toEqual({ 'claude-code': ['m1', 'm2'] });
  });

  it('accumulates exclusions', () => {
    const once = child({ protectedPaths: ['src/a'] });
    const twice = narrow(once, { level: 1, tokens: 1, protectedPaths: ['src/b', 'src/a'] });
    expect(twice.ok && twice.mandate.exclusions.protectedPaths).toEqual(['src/a', 'src/b']);
  });

  it('appends effect rules one level at a time, intersecting none as text', () => {
    expect(child().effectRules).toEqual([RULES]);
    expect(child({ effectRules: EFFECTS[1] }).effectRules).toEqual([RULES, EFFECTS[1]]);
  });

  it('words a refusal for the planner that hears it', () => {
    expect(mandateRefusalText({ level: 2, field: 'limits.tokens', asked: '1001', there: '1000' })).toBe('Level 2 refused limits.tokens: asked 1001, and there is 1000.');
  });
});

describe('what holds at a node is its saved mandate within every ancestor\'s (ADR-0056 M1)', () => {
  const saved = (): Mandate => {
    const result = narrow(root({ delegationTokens: 1000 }), { level: 0, tokens: 100, grants: ['research'] });
    if (!result.ok) throw new Error('refused');
    return result.mandate;
  };

  it('keeps what every ancestor can still hand on', () => {
    expect(names(heldMandate(saved(), [root({ delegationTokens: 1000 })]).grants)).toEqual(names(saved().grants));
  });

  it('holds nothing once the root\'s `grantable` is emptied, the floor included, and refuses nothing', () => {
    const held = heldMandate(saved(), [root({ delegationTokens: 0 })]);
    expect(names(held.grants)).toEqual([]);
    expect(names(held.grantable)).toEqual([]);
  });

  it('reads each ancestor, not only the nearest', () => {
    const narrower = { ...root({ delegationTokens: 1000 }), grantable: new Set<Grant>(['observe']) };
    expect(names(heldMandate(saved(), [root({ delegationTokens: 1000 }), narrower]).grants)).toEqual(['observe']);
  });

  it('leaves the limits as the child was given them', () => {
    expect(heldMandate(saved(), [root()]).limits).toEqual(saved().limits);
  });
});

describe('the tool list a child is served (ADR-0056 M6)', () => {
  const withGrants = (...grants: Grant[]): Mandate => ({ ...root(), grants: new Set(grants) });
  const toolNames = PLANNER_TOOLS.map((tool) => tool.name);

  it('withholds what no grant lets it call, in a stable order', () => {
    expect(withheldPlannerTools(withGrants('observe', 'steer'))).toEqual(['run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'merge_all', 'skip_task', 'run_script', 'submit_plan', 'edit_plan']);
  });

  it('withholds nothing from a mandate that holds the floor', () => {
    expect(withheldPlannerTools(withGrants(...FLOOR_GRANTS))).toEqual([]);
  });

  it('names only tools the planner is served', () => {
    expect(toolNames).toEqual(expect.arrayContaining(withheldPlannerTools(withGrants())));
  });
});
