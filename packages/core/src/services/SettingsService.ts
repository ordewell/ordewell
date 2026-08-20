import * as fs from 'fs';
import * as path from 'path';
import { globalDataDir, migrateOldConfigDir } from '../utils/globalDataDir';

export interface UserSettings {
  tdd: { enabled: boolean };
  verification: { enabled: boolean };
  modelAllowlist?: Record<string, string[]>;
  /** Last model (and its thinking effort) the user chose for each planner backend, keyed by AiProvider id. */
  plannerModels?: Record<string, { model: string; effort?: string }>;
  /**
   * Runners the user picked for planning. Absent — not empty — is what falls
   * back to the environment's defaults; `[]` is a deliberate "none of them".
   */
  enabledRunners?: string[];
}

const DEFAULTS: UserSettings = {
  tdd: { enabled: true },
  verification: { enabled: false },
};

/**
 * Where the user's toggles live. `ORDEWELL_SETTINGS_PATH` overrides it so several
 * Ordewell processes on one machine can hold *different* settings at the same
 * time. Without it the file is a single shared mutable global: the benchmark
 * harness runs parallel lanes that each pin the mode toggles, and because
 * `getAll()` re-reads whenever the mtime moves, a lane needing a toggle
 * `true` would silently plan with `false` the moment another lane pinned its
 * own — turning an A/B of that toggle into a comparison of one condition
 * against itself.
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
      ? { model, effort }
      : { model };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class SettingsService {
  private filePath: string;
  private cache: UserSettings | null = null;
  private cachedMtimeMs: number | null = null;

  constructor(filePath: string = getSettingsPath()) {
    this.filePath = filePath;
  }

  // Several processes share the settings file (VS Code extension host, web
  // server, CLI), so the cache is keyed on the file's mtime: a write from any
  // other process invalidates it. A stale cache here previously meant an
  // allowlist set in one surface never reached another's planner.
  getAll(): UserSettings {
    const mtime = this.fileMtimeMs();
    if (this.cache && mtime === this.cachedMtimeMs) return this.cache;
    this.cache = this.load();
    this.cachedMtimeMs = mtime;
    return this.cache;
  }

  private fileMtimeMs(): number | null {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  getTdd(): boolean {
    return this.getAll().tdd.enabled;
  }

  setTdd(enabled: boolean): void {
    this.getAll();
    this.cache!.tdd.enabled = enabled;
    this.persist();
  }

  getVerification(): boolean {
    return this.getAll().verification.enabled;
  }

  setVerification(enabled: boolean): void {
    this.getAll();
    this.cache!.verification.enabled = enabled;
    this.persist();
  }

  getModelAllowlist(runner: string): string[] | undefined {
    return this.getAll().modelAllowlist?.[runner];
  }

  setModelAllowlist(runner: string, ids: string[] | undefined): void {
    this.getAll();
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
    this.persist();
  }

  getPlannerModel(provider: string): { model: string; effort?: string } | undefined {
    return this.getAll().plannerModels?.[provider];
  }

  setPlannerModel(provider: string, entry: { model: string; effort?: string } | undefined): void {
    this.getAll();
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
    this.persist();
  }

  getEnabledRunners(): string[] | undefined {
    return this.getAll().enabledRunners;
  }

  setEnabledRunners(ids: string[]): void {
    this.getAll();
    this.cache!.enabledRunners = [...ids];
    this.persist();
  }

  private load(): UserSettings {
    // A pre-`.ordewell` install keeps its toggles in the old config dir; lift
    // them once before reading so the first read already sees the moved file.
    migrateOldConfigDir();
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        const settings: UserSettings = {
          tdd: { enabled: raw.tdd?.enabled ?? DEFAULTS.tdd.enabled },
          verification: { enabled: raw.verification?.enabled ?? DEFAULTS.verification.enabled },
        };
        if (raw.modelAllowlist !== undefined) {
          settings.modelAllowlist = raw.modelAllowlist;
        }
        const plannerModels = readPlannerModels(raw.plannerModels);
        if (plannerModels) {
          settings.plannerModels = plannerModels;
        }
        if (Array.isArray(raw.enabledRunners)) {
          settings.enabledRunners = raw.enabledRunners.map(String);
        }
        return settings;
      }
    } catch {
      // corrupted file — use defaults
    }
    return { ...DEFAULTS, tdd: { ...DEFAULTS.tdd }, verification: { ...DEFAULTS.verification } };
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
    this.cachedMtimeMs = this.fileMtimeMs();
  }
}
