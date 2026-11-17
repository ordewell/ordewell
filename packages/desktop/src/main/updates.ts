import { startVersionCheck, type PingFetch, type VersionCheck } from '@ordewell/core';
import type { UpdateCheckOutcome, UpdateState } from '../shared/bridge';
import type { UpdateController } from './updater';

export interface UpdateServiceDeps {
  version: string;
  updater: UpdateController;
  /** Settings' "Check for new versions" as it stands at launch; on unless the person turned it off. */
  versionCheck: boolean;
  env?: Record<string, string | undefined>;
  /** Where core keeps `version-check.json`; the machine's shared one by default. */
  stateDir?: string;
  fetch?: PingFetch;
  now?: () => number;
}

/** Added to core's notice, which names only the variable: here the person also has a switch to click. */
const SETTINGS_SWITCH = 'In this app: Settings → Check for new versions.';

/**
 * Core reads these itself and then does nothing at all, with nothing to say
 * why; the same reading here lets "Check for updates…" tell the person it is
 * off and where (ADR-0048).
 */
const offByEnvironment = (env: Record<string, string | undefined>): boolean =>
  ['ORDEWELL_NO_VERSION_CHECK', 'DO_NOT_TRACK'].some((name) => /^(1|true|yes)$/i.test(env[name]?.trim() ?? ''));

/**
 * What the app knows about a newer version and how the person gets it, for
 * every window at once. Two sources feed it: core's daily version check, the
 * one request the app makes unasked, sharing `version-check.json` and its
 * ping with the CLI, the TUI and VS Code; and, on a signed build, the
 * updater, which reaches GitHub Releases only when the person asks
 * (ADR-0048, ADR-0063 H9).
 *
 * The desktop shows the version on every start (core's `every-start`), so the
 * once-a-day `updateShownAt` another surface keeps never hides it here.
 */
export class UpdateService {
  private check_: VersionCheck | undefined;
  private enabled: boolean;
  /** The version the daily check last named in this process. */
  private pinged: string | undefined;
  private notice: string | undefined;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private readonly offUpdater: () => void;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.enabled = deps.versionCheck;
    this.offUpdater = deps.updater.onChange(() => this.emit());
  }

  start(): void {
    this.check_?.stop();
    this.check_ = startVersionCheck({
      version: this.deps.version,
      telemetryEnabled: this.enabled,
      // Never the once-a-day line: a dismissal elsewhere must not hide that a version is out here.
      updateLine: 'every-start',
      onNotice: (text) => {
        this.notice = `${text} ${SETTINGS_SWITCH}`;
        this.emit();
      },
      onUpdate: (_line, latest) => {
        this.pinged = latest;
        this.emit();
      },
      ...(this.deps.env ? { env: this.deps.env } : {}),
      ...(this.deps.stateDir ? { stateDir: this.deps.stateDir } : {}),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
  }

  stop(): void {
    this.check_?.stop();
    this.check_ = undefined;
    this.offUpdater();
  }

  /** The Settings toggle changed. Off stops the check and forgets what it named; on starts it again. */
  setVersionCheck(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.pinged = undefined;
    if (!on) this.notice = undefined;
    this.start();
    this.emit();
  }

  state(): UpdateState {
    const updater = this.deps.updater.status();
    const found = 'version' in updater ? updater.version : undefined;
    const latest = found ?? this.pinged;
    return {
      current: this.deps.version,
      method: this.deps.updater.enabled ? 'install' : 'download',
      ...(latest !== undefined ? { latest } : {}),
      updater,
      ...(this.notice !== undefined ? { notice: this.notice } : {}),
    };
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * "Check for updates…". A signed build asks the updater, whatever the toggle
   * says: the person asked, and it is GitHub that is asked, not the ping. A
   * download build runs the version check once more, which pings only if the
   * machine's day is up: core keeps one clock for every surface.
   */
  async check(): Promise<UpdateCheckOutcome> {
    if (this.deps.updater.enabled) {
      const status = await this.deps.updater.check();
      if (status.phase === 'error') return { kind: 'failed', message: status.message };
      if ('version' in status) return { kind: 'available', latest: status.version };
      return { kind: 'up-to-date' };
    }
    if (offByEnvironment(this.deps.env ?? process.env)) return { kind: 'off', reason: 'environment' };
    if (!this.enabled) return { kind: 'off', reason: 'setting' };
    // A ping still out has already moved the shared clock on: a fresh check
    // started beside it would skip its own ping and miss that answer.
    await this.check_?.settled();
    this.start();
    await this.check_?.settled();
    return this.pinged !== undefined ? { kind: 'available', latest: this.pinged } : { kind: 'up-to-date' };
  }

  /** [Update] on a signed build. */
  download(): Promise<void> {
    return this.deps.updater.download();
  }

  /** [Restart to update]; the caller has already asked about live work. */
  install(): Promise<boolean> {
    return this.deps.updater.install();
  }

  dismissNotice(): void {
    if (this.notice === undefined) return;
    this.notice = undefined;
    this.emit();
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}
