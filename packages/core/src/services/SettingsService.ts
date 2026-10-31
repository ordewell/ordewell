import * as fs from 'fs';
import * as path from 'path';
import { globalDataDir, migrateOldConfigDir } from '../utils/globalDataDir';
import { withFileLock } from '../utils/fileLock';
import type { SupervisorLevel } from '../models/Execution';
import { DEFAULT_SUPERVISOR_RETRY_LIMIT } from './LoopGuards';
import { DEFAULT_WAKE_UP_READ_BUDGET } from './Supervisor';
import { parseAutonomyFlag } from './ModeResolver';
import type { TaskRunnerConfig } from './harness/AgentAdapter';

/** How a run is started, watched and merged: the user's, not a plan's (ADR-0030). */
export interface GlobalRunSettings {
  supervisorLevel: SupervisorLevel;
  mergeAtGatesAutomatically: boolean;
  /** End the commits Ordewell writes with a `Planned-with: Ordewell` trailer (ADR-0013). */
  plannedWithTrailer: boolean;
  /** Start a plan when the planner submits it, approved as if the user had pressed Execute. */
  autorun: boolean;
  /** Retries an Act supervisor may make of one task in a run (a loop guard). */
  supervisorRetryLimit: number;
  /** Reads a wake-up turn may make, in place of a user message's caps. */
  wakeUpReadBudget: number;
}

export const RUN_SETTINGS_DEFAULTS: Readonly<GlobalRunSettings> = {
  supervisorLevel: 'watch',
  mergeAtGatesAutomatically: false,
  plannedWithTrailer: true,
  autorun: false,
  supervisorRetryLimit: DEFAULT_SUPERVISOR_RETRY_LIMIT,
  wakeUpReadBudget: DEFAULT_WAKE_UP_READ_BUDGET,
};

export class RunSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunSettingsError';
  }
}

const SUPERVISOR_LEVELS: readonly SupervisorLevel[] = ['off', 'watch', 'act'];

/** Each value's own check, so a hand-edited file and a refused update agree on what is usable. */
const RUN_SETTING_CHECKS: { [K in keyof GlobalRunSettings]: { valid: (v: unknown) => v is GlobalRunSettings[K]; refusal: string } } = {
  supervisorLevel: {
    valid: (v): v is SupervisorLevel => typeof v === 'string' && (SUPERVISOR_LEVELS as readonly string[]).includes(v),
    refusal: 'The supervisor level must be off, watch or act.',
  },
  mergeAtGatesAutomatically: {
    valid: (v): v is boolean => typeof v === 'boolean',
    refusal: 'Merge at gates automatically must be on or off.',
  },
  plannedWithTrailer: {
    valid: (v): v is boolean => typeof v === 'boolean',
    refusal: 'The Planned-with line must be on or off.',
  },
  autorun: {
    valid: (v): v is boolean => typeof v === 'boolean',
    refusal: 'Autorun must be on or off.',
  },
  supervisorRetryLimit: {
    valid: (v): v is number => Number.isInteger(v) && (v as number) >= 0,
    refusal: 'The retry limit must be a whole number of retries, 0 or more.',
  },
  wakeUpReadBudget: {
    valid: (v): v is number => Number.isInteger(v) && (v as number) >= 1,
    refusal: 'The wake-up read budget must be a whole number of reads, 1 or more.',
  },
};

const RUN_SETTING_KEYS = Object.keys(RUN_SETTING_CHECKS) as (keyof GlobalRunSettings)[];

export interface UserSettings {
  modelAllowlist?: Record<string, string[]>;
  /** Last model (and its thinking effort) the user chose for each planner backend, keyed by planner backend id. */
  plannerModels?: Record<string, { model: string; effort?: string }>;
  /**
   * Runners the user picked for planning. Absent — not empty — is what falls
   * back to the environment's defaults; `[]` is a deliberate "none of them".
   */
  enabledRunners?: string[];
  /** Full (true) or Guarded (false), ADR-0001; Guarded until the user chooses. */
  autonomousMode?: boolean;
  supervisorLevel?: SupervisorLevel;
  mergeAtGatesAutomatically?: boolean;
  plannedWithTrailer?: boolean;
  autorun?: boolean;
  supervisorRetryLimit?: number;
  wakeUpReadBudget?: number;
  /**
   * Whether an API planner prunes its own context ahead of a call that would
   * pass 90% of its model's window. Absent means on. Set in the file only:
   * no surface offers it.
   */
  plannerAutoCompaction?: boolean;
  /**
   * What a task runner loads of the user's own setup: all of it (`user`) or
   * what a task needs (`minimal`). Absent means `user`. Set in the file only:
   * no surface offers it.
   */
  taskRunnerConfig?: TaskRunnerConfig;
}

/**
 * The model allowlist, remembered planner models and enabled runners are shared
 * across processes by default. `ORDEWELL_SETTINGS_PATH` lets independent runs
 * use separate files: otherwise a write in one run would change another's
 * settings when `getAll()` detects the new mtime.
 */
export function getSettingsPath(): string {
  const override = process.env.ORDEWELL_SETTINGS_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(globalDataDir(), 'settings.json');
}

/**
 * A remembered planner model is spawned verbatim by whichever agent becomes the
 * planner, so a hand-edited or older file is read entry by entry rather than
 * trusted: an entry without a real id would restore a planner that cannot start.
 * An unusable *effort* only loses the level, never the model that carried it.
 */
function readPlannerModels(raw: unknown): Record<string, { model: string; effort?: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, { model: string; effort?: string }> = {};
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { model, effort } = entry as { model?: unknown; effort?: unknown };
    if (typeof model !== 'string' || !model.trim()) continue;
    out[provider] = typeof effort === 'string' && effort.trim()
      ? { model: model.trim(), effort: effort.trim() }
      : { model: model.trim() };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The allowlist is read entry by entry like the planner models above: the
 * obvious single-model hand edit is `{"claude-code": "opus"}`, and handing
 * that string on makes every planner turn throw on `allowlist.filter` (or, where
 * the catalog is not filtered, match model ids by substring). A runner whose
 * entry is not a list of real ids is left out, so no restriction stands.
 */
function readModelAllowlist(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [runner, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const usable = ids
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .map((id) => id.trim());
    if (usable.length > 0) out[runner] = usable;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The run settings `settings` holds, each one it leaves out at its default. */
export function runSettingsOf(settings: UserSettings): GlobalRunSettings {
  const out = { ...RUN_SETTINGS_DEFAULTS };
  for (const key of RUN_SETTING_KEYS) {
    if (settings[key] !== undefined) (out as Record<keyof GlobalRunSettings, unknown>)[key] = settings[key];
  }
  return out;
}

/** How many times a save is made afresh when another process keeps saving under it. */
const SAVE_TRIES = 5;

/** A file that cannot be read is reported once per process, not on every look. */
const warnedSettingsProblems = new Set<string>();

export class SettingsService {
  private filePath: string;
  private cache: UserSettings | null = null;
  private cachedStamp: string | null = null;
  /** A read failed for a reason other than a missing file; saving would overwrite bytes we never saw. */
  private unreadable = false;

  constructor(filePath: string = getSettingsPath()) {
    this.filePath = filePath;
  }

  // Several processes share the settings file (VS Code extension host, web
  // server, CLI), so the cache is keyed on the file's identity: a write from any
  // other process invalidates it. A stale cache here previously meant an
  // allowlist set in one surface never reached another's planner.
  getAll(): UserSettings {
    const stamp = this.fileStamp();
    if (this.cache && stamp === this.cachedStamp) return this.cache;
    this.cache = this.load();
    this.cachedStamp = stamp;
    return this.cache;
  }

  /**
   * Every write replaces the file, so its inode changes with it; the mtime
   * alone cannot tell two writes apart on a filesystem whose timestamps are
   * coarse, and a write that shares the last one's tick stayed unseen.
   */
  private fileStamp(file: string = this.filePath): string | null {
    try {
      const stat = fs.statSync(file);
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  /**
   * What a change is applied to: the file as it is now, never a copy held since
   * an earlier read. Another process may have saved in between, and writing
   * the whole file back would silently undo it.
   */
  private current(): UserSettings {
    this.cache = null;
    return this.getAll();
  }

  /**
   * Calls `listener` when another process (or this one) saves the file. The
   * directory is watched, not the file: a write that swaps the file in leaves
   * a watch on the old one pointing at nothing.
   */
  watch(listener: () => void): { dispose(): void } {
    const dir = path.dirname(this.filePath);
    const name = path.basename(this.filePath);
    let seen = this.fileStamp();
    let timer: NodeJS.Timeout | undefined;
    let dead = false;
    let watcher: fs.FSWatcher;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, changed) => {
        if (dead) return;
        // macOS can name the watched directory rather than the replaced file.
        if (changed && changed !== name && changed !== path.basename(dir)) return;
        // One save is several events; the stamp tells whether the file really moved.
        clearTimeout(timer);
        timer = setTimeout(() => {
          const stamp = this.fileStamp();
          if (stamp === seen) return;
          seen = stamp;
          listener();
        }, 50);
      });
    } catch {
      return { dispose() {} };
    }
    // fs.watch reports a watch it can no longer keep asynchronously (ENOSPC,
    // EMFILE, the directory being removed), and an 'error' with no listener
    // takes the whole process down. A lost notification channel is not worth
    // the user's terminal or extension host: say so once and stop watching.
    const die = (reason: unknown): void => {
      if (dead) return;
      dead = true;
      clearTimeout(timer);
      try {
        watcher.close();
      } catch {
        // Already unusable; the failure above is the one worth reporting.
      }
      console.warn(`[SettingsService] stopped watching ${dir} for settings changes: ${String(reason)}`);
    };
    watcher.on('error', die);
    return { dispose: () => { dead = true; clearTimeout(timer); watcher.close(); } };
  }

  getModelAllowlist(runner: string): string[] | undefined {
    return this.getAll().modelAllowlist?.[runner];
  }

  setModelAllowlist(runner: string, ids: string[] | undefined): void {
    this.save(() => {
      if (ids === undefined) {
        if (this.cache!.modelAllowlist) {
          delete this.cache!.modelAllowlist[runner];
          if (Object.keys(this.cache!.modelAllowlist).length === 0) {
            this.cache!.modelAllowlist = undefined;
          }
        }
      } else {
        if (!this.cache!.modelAllowlist) {
          this.cache!.modelAllowlist = {};
        }
        this.cache!.modelAllowlist[runner] = ids;
      }
    });
  }

  getPlannerModel(provider: string): { model: string; effort?: string } | undefined {
    return this.getAll().plannerModels?.[provider];
  }

  setPlannerModel(provider: string, entry: { model: string; effort?: string } | undefined): void {
    this.save(() => {
      if (entry === undefined) {
        if (this.cache!.plannerModels) {
          delete this.cache!.plannerModels[provider];
          if (Object.keys(this.cache!.plannerModels).length === 0) {
            this.cache!.plannerModels = undefined;
          }
        }
      } else {
        if (!this.cache!.plannerModels) {
          this.cache!.plannerModels = {};
        }
        this.cache!.plannerModels[provider] = entry.effort
          ? { model: entry.model, effort: entry.effort }
          : { model: entry.model };
      }
    });
  }

  getEnabledRunners(): string[] | undefined {
    return this.getAll().enabledRunners;
  }

  setEnabledRunners(ids: string[]): void {
    this.save(() => {
      this.cache!.enabledRunners = [...ids];
    });
  }

  /**
   * Change the list from what the file holds at this moment: the change is
   * handed the saved list (undefined when the user never chose) and its result
   * is saved in the same call. A list worked out from an earlier read would
   * save over what another surface set since. It may be handed the list again,
   * when another process saved before this one could (see {@link save}).
   */
  updateEnabledRunners(change: (saved: string[] | undefined) => string[]): string[] {
    return this.save(() => {
      const next = [...change(this.cache!.enabledRunners)];
      this.cache!.enabledRunners = next;
      return next;
    });
  }

  /** Save `ids` as the user's choice unless one is saved already, judged on the file as it is now. */
  setEnabledRunnersIfUnset(ids: string[]): boolean {
    return this.save(() => {
      if (this.cache!.enabledRunners !== undefined) return false;
      this.cache!.enabledRunners = [...ids];
      return true;
    });
  }

  /**
   * Full or Guarded (ADR-0001), as saved here (ADR-0030). A value set in the
   * environment wins, so a script or CI run can fix its own without touching
   * the user's file. A fresh install starts Guarded: its first plan runs each
   * runner's safe mode and asks before risky effects.
   */
  autonomousMode(): boolean {
    const override = this.autonomyOverride();
    return override ?? this.getAll().autonomousMode ?? false;
  }

  /** Whether `ORDEWELL_AUTONOMOUS_MODE` decides the level, whatever this file says. */
  autonomousModeOverridden(): boolean {
    return this.autonomyOverride() !== undefined;
  }

  /**
   * The level `ORDEWELL_AUTONOMOUS_MODE` names, or undefined when it names
   * none. It shares {@link parseAutonomyFlag} with the `.env` migration, so a
   * value is read the same way whether it is still in `.env` or set in the
   * shell. Anything else is not an override at all rather than Full: a typo,
   * `off` in a shell that spells Guarded that way, or a lower-case `false`
   * must never raise the user's autonomy.
   */
  private autonomyOverride(): boolean | undefined {
    return parseAutonomyFlag(process.env.ORDEWELL_AUTONOMOUS_MODE);
  }

  setAutonomousMode(enabled: boolean): void {
    this.save(() => {
      this.cache!.autonomousMode = enabled;
    });
  }

  getRunSettings(): GlobalRunSettings {
    return runSettingsOf(this.getAll());
  }

  /** Checks every value before writing any, so a refused change saves nothing. */
  updateRunSettings(changes: Partial<GlobalRunSettings>): GlobalRunSettings {
    for (const key of RUN_SETTING_KEYS) {
      if (changes[key] !== undefined && !RUN_SETTING_CHECKS[key].valid(changes[key])) {
        throw new RunSettingsError(RUN_SETTING_CHECKS[key].refusal);
      }
    }
    this.save(() => {
      for (const key of RUN_SETTING_KEYS) {
        if (changes[key] !== undefined) (this.cache as Record<keyof GlobalRunSettings, unknown>)[key] = changes[key];
      }
    });
    return this.getRunSettings();
  }

  private load(): UserSettings {
    // A pre-`.ordewell` install keeps its settings in the old config dir; lift
    // them once before reading so the first read already sees the moved file.
    migrateOldConfigDir();
    this.unreadable = false;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err: unknown) {
      // A missing file is simply defaults. Any other read failure (EACCES,
      // EMFILE, EISDIR) says nothing about the content, so the next save must
      // refuse rather than replace what was never read.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unreadable = true;
        this.warnProblem(`could not be read; changes will not be saved over it: ${String(err)}`);
      }
      return {};
    }
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      raw = parsed as Record<string, unknown>;
    } catch {
      this.moveAsideCorrupt();
      return {};
    }
    // Only known keys are lifted, so the removed `tdd` (now a task skill)
    // and `verification` toggles and the `runnerTransport` setting of older
    // files are dropped on the next write.
    const settings: UserSettings = {};
    const modelAllowlist = readModelAllowlist(raw.modelAllowlist);
    if (modelAllowlist) {
      settings.modelAllowlist = modelAllowlist;
    }
    const plannerModels = readPlannerModels(raw.plannerModels);
    if (plannerModels) {
      settings.plannerModels = plannerModels;
    }
    if (Array.isArray(raw.enabledRunners)) {
      settings.enabledRunners = raw.enabledRunners.map(String);
    }
    if (typeof raw.autonomousMode === 'boolean') {
      settings.autonomousMode = raw.autonomousMode;
    } else if (typeof raw.autonomousMode === 'string') {
      // A hand-typed level name is read the way the flag and `.env` read it;
      // "guarded" must not fall through to Full. An unknown word still does.
      const level = parseAutonomyFlag(raw.autonomousMode);
      if (level !== undefined) settings.autonomousMode = level;
    }
    if (typeof raw.plannerAutoCompaction === 'boolean') {
      settings.plannerAutoCompaction = raw.plannerAutoCompaction;
    }
    if (raw.taskRunnerConfig === 'user' || raw.taskRunnerConfig === 'minimal') {
      settings.taskRunnerConfig = raw.taskRunnerConfig;
    }
    // A value it cannot use is left out, so its default stands.
    for (const key of RUN_SETTING_KEYS) {
      if (RUN_SETTING_CHECKS[key].valid(raw[key])) (settings as Record<keyof GlobalRunSettings, unknown>)[key] = raw[key];
    }
    return settings;
  }

  /** Keep the bytes of a hand-edited file we cannot parse, and say so, instead of resetting it on the next save. */
  private moveAsideCorrupt(): void {
    const aside = `${this.filePath}.${Date.now()}.corrupt`;
    try {
      fs.renameSync(this.filePath, aside);
      this.warnProblem(`is not valid JSON; kept it as ${aside} and started from defaults`);
    } catch (err: unknown) {
      this.unreadable = true;
      this.warnProblem(`is not valid JSON and could not be moved aside; changes will not be saved over it: ${String(err)}`);
    }
  }

  private warnProblem(problem: string): void {
    if (warnedSettingsProblems.has(this.filePath)) return;
    warnedSettingsProblems.add(this.filePath);
    console.warn(`[SettingsService] ${this.filePath} ${problem}`);
  }

  /**
   * Makes `change` to the file as it is now, and saves it. Another process can
   * save between that read and this write; the file is looked at again just
   * before ours replaces it, and when it moved the change is made afresh from
   * what that process saved, so neither save undoes the other. A file that
   * keeps moving is written over after {@link SAVE_TRIES} tries rather than
   * never. The look and the swap are one step under the file's lock
   * ({@link withFileLock}). A change that changes nothing writes nothing.
   */
  private save<T>(change: () => T): T {
    for (let tries = 1; ; tries++) {
      const before = JSON.stringify(this.current());
      const read = this.cachedStamp;
      const result = change();
      if (JSON.stringify(this.cache) === before || this.persist(tries < SAVE_TRIES ? read : undefined)) return result;
    }
  }

  /** False, saving nothing, when the file is no longer the one stamped `expected`. */
  private persist(expected?: string | null): boolean {
    // The bytes on disk were never read, so replacing them would be a silent
    // reset to whatever defaults this process happens to hold.
    if (this.unreadable) {
      throw new Error(`Cannot save settings: ${this.filePath} could not be read, so it will not be overwritten. Fix or remove it and try again.`);
    }
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Written beside the file and renamed over it, so a process reading at that
    // moment sees the old file or the new one, never an empty one.
    const staging = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(this.cache, null, 2));
    // Stamped before the swap, which keeps all three: a save by another process
    // right after ours is then a different stamp, not mistaken for our own.
    const stamp = this.fileStamp(staging);
    const swapped = withFileLock(this.filePath, () => {
      if (expected !== undefined && this.fileStamp() !== expected) return false;
      fs.renameSync(staging, this.filePath);
      return true;
    }, 'save the settings file');
    if (!swapped) {
      fs.rmSync(staging, { force: true });
      return false;
    }
    this.cachedStamp = stamp;
    return true;
  }
}
