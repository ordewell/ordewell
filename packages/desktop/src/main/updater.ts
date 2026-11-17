import type { UpdaterStatus } from '../shared/bridge';

/**
 * Set by tsup from the signing plan scripts/package.mjs made (tsup.config.ts).
 * Undeclared in a build that did not set it, such as the tests.
 */
declare const __ORDEWELL_AUTO_UPDATE__: boolean | undefined;

/**
 * Whether the app may update itself. Decided when the app is built and baked
 * into it, not a setting or an environment variable: an installer that is not
 * signed must not be able to be told to fetch and run another one, so nothing a
 * user or a page can set reaches this. It is true only in a build that is
 * signed, and notarized on macOS, where the platform holds an update to the
 * installed app's signer (ADR-0063 H9). Anything else, including a build that
 * never decided, is false.
 */
export const AUTO_UPDATE_ENABLED: boolean =
  typeof __ORDEWELL_AUTO_UPDATE__ === 'boolean' ? __ORDEWELL_AUTO_UPDATE__ : false;

/** The part of electron-updater's `autoUpdater` this app drives. */
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
}

export interface UpdaterDeps {
  enabled: boolean;
  /** An unpackaged app has no app-update.yml, so there is no feed to ask. */
  packaged: boolean;
  /** Loaded only once the gate is open, so a disabled build never evaluates electron-updater. */
  load: () => UpdaterPort | Promise<UpdaterPort>;
  log: (message: string) => void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Drives electron-updater against the GitHub provider that electron-builder.yml
 * records in app-update.yml, and only when the person asks: it never checks on
 * its own, so the version check stays the one request the app makes unasked
 * (ADR-0048, ADR-0063 H9). While the gate is closed it does nothing at all: no
 * module load, no network request.
 */
export class UpdateController {
  private current: UpdaterStatus = { phase: 'idle' };
  private updater: Promise<UpdaterPort> | undefined;
  private readonly listeners = new Set<(status: UpdaterStatus) => void>();

  constructor(private readonly deps: UpdaterDeps) {}

  /** Whether this build updates itself; without it, updating is a download the person makes. */
  get enabled(): boolean {
    return this.deps.enabled && this.deps.packaged;
  }

  status(): UpdaterStatus {
    return this.current;
  }

  onChange(listener: (status: UpdaterStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Ask the release feed once. Nothing is downloaded until {@link download}. */
  async check(): Promise<UpdaterStatus> {
    if (!this.enabled || this.busy()) return this.current;
    this.set({ phase: 'checking' });
    try {
      const result = await (await this.port()).checkForUpdates();
      this.set(result?.isUpdateAvailable ? { phase: 'available', version: result.updateInfo.version } : { phase: 'up-to-date' });
    } catch (error) {
      this.deps.log(`Update check failed: ${messageOf(error)}`);
      this.set({ phase: 'error', message: messageOf(error) });
    }
    return this.current;
  }

  /** Fetch the newer release, checking first when no check has found one, reporting progress as it goes. */
  async download(): Promise<void> {
    if (!this.enabled || this.busy()) return;
    const found = this.current.phase === 'available' ? this.current : await this.check();
    if (found.phase !== 'available') return;
    const { version } = found;
    this.set({ phase: 'downloading', version, percent: 0 });
    try {
      const updater = await this.port();
      await updater.downloadUpdate();
      // Downloaded at the person's word, so quitting installs it even without the restart.
      updater.autoInstallOnAppQuit = true;
      this.set({ phase: 'ready', version });
    } catch (error) {
      this.deps.log(`Update download failed: ${messageOf(error)}`);
      this.set({ phase: 'error', message: messageOf(error) });
    }
  }

  /** Quit, install the downloaded release and start it. False when nothing is downloaded. */
  async install(): Promise<boolean> {
    if (this.current.phase !== 'ready') return false;
    // Silent, and started again after: the person asked to restart, not to walk through an installer.
    (await this.port()).quitAndInstall(true, true);
    return true;
  }

  private busy(): boolean {
    return this.current.phase === 'checking' || this.current.phase === 'downloading' || this.current.phase === 'ready';
  }

  private port(): Promise<UpdaterPort> {
    if (!this.updater) {
      const loading = Promise.resolve(this.deps.load()).then((updater) => {
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowDowngrade = false;
        updater.allowPrerelease = false;
        updater.on('download-progress', (progress) => {
          if (this.current.phase !== 'downloading') return;
          this.set({ ...this.current, percent: Math.max(0, Math.min(100, Math.floor(progress.percent))) });
        });
        return updater;
      });
      // A load that failed is tried again on the next ask.
      loading.catch(() => { if (this.updater === loading) this.updater = undefined; });
      this.updater = loading;
    }
    return this.updater;
  }

  private set(status: UpdaterStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }
}
