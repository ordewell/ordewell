import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface UserSettings {
  grillMe: { enabled: boolean };
  tdd: { enabled: boolean };
  prd: { enabled: boolean };
  review: { enabled: boolean };
  verification: { enabled: boolean };
  researchSubagents: { enabled: boolean };
  modelAllowlist?: Record<string, string[]>;
  /**
   * Runners the user picked for planning. Absent — not empty — is what falls
   * back to the environment's defaults; `[]` is a deliberate "none of them".
   */
  enabledRunners?: string[];
}

const DEFAULTS: UserSettings = {
  grillMe: { enabled: false },
  tdd: { enabled: true },
  prd: { enabled: false },
  review: { enabled: false },
  verification: { enabled: false },
  researchSubagents: { enabled: false },
};

/**
 * Where the user's toggles live. `ORDEWELL_SETTINGS_PATH` overrides it so several
 * Ordewell processes on one machine can hold *different* settings at the same
 * time. Without it the file is a single shared mutable global: the benchmark
 * harness runs parallel lanes that each pin the mode toggles, and because
 * `getAll()` re-reads whenever the mtime moves, a lane needing
 * `researchSubagents: true` would silently plan with `false` the moment another
 * lane pinned its own — turning an A/B of that toggle into a comparison of one
 * condition against itself.
 */
export function getSettingsPath(): string {
  const override = process.env.ORDEWELL_SETTINGS_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'ordewell', 'settings.json');
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

  getGrillMe(): boolean {
    return this.getAll().grillMe.enabled;
  }

  getTdd(): boolean {
    return this.getAll().tdd.enabled;
  }

  getPrd(): boolean {
    return this.getAll().prd.enabled;
  }

  setGrillMe(enabled: boolean): void {
    this.getAll();
    this.cache!.grillMe.enabled = enabled;
    this.persist();
  }

  setTdd(enabled: boolean): void {
    this.getAll();
    this.cache!.tdd.enabled = enabled;
    this.persist();
  }

  setPrd(enabled: boolean): void {
    this.getAll();
    this.cache!.prd.enabled = enabled;
    this.persist();
  }

  getReview(): boolean {
    return this.getAll().review.enabled;
  }

  setReview(enabled: boolean): void {
    this.getAll();
    this.cache!.review.enabled = enabled;
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

  getResearchSubagents(): boolean {
    return this.getAll().researchSubagents.enabled;
  }

  setResearchSubagents(enabled: boolean): void {
    this.getAll();
    this.cache!.researchSubagents.enabled = enabled;
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

  getEnabledRunners(): string[] | undefined {
    return this.getAll().enabledRunners;
  }

  setEnabledRunners(ids: string[]): void {
    this.getAll();
    this.cache!.enabledRunners = [...ids];
    this.persist();
  }

  private load(): UserSettings {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        const settings: UserSettings = {
          grillMe: { enabled: raw.grillMe?.enabled ?? DEFAULTS.grillMe.enabled },
          tdd: { enabled: raw.tdd?.enabled ?? DEFAULTS.tdd.enabled },
          prd: { enabled: raw.prd?.enabled ?? DEFAULTS.prd.enabled },
          // `verify` is the legacy key for review mode; keep reading it so old settings files survive the rename.
          // The evidence-based verification mode uses the distinct `verification` key to avoid colliding with it.
          review: { enabled: raw.review?.enabled ?? raw.verify?.enabled ?? DEFAULTS.review.enabled },
          verification: { enabled: raw.verification?.enabled ?? DEFAULTS.verification.enabled },
          researchSubagents: { enabled: raw.researchSubagents?.enabled ?? DEFAULTS.researchSubagents.enabled },
        };
        if (raw.modelAllowlist !== undefined) {
          settings.modelAllowlist = raw.modelAllowlist;
        }
        if (Array.isArray(raw.enabledRunners)) {
          settings.enabledRunners = raw.enabledRunners.map(String);
        }
        return settings;
      }
    } catch {
      // corrupted file — use defaults
    }
    return { ...DEFAULTS, grillMe: { ...DEFAULTS.grillMe }, tdd: { ...DEFAULTS.tdd }, prd: { ...DEFAULTS.prd }, review: { ...DEFAULTS.review }, verification: { ...DEFAULTS.verification }, researchSubagents: { ...DEFAULTS.researchSubagents } };
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
