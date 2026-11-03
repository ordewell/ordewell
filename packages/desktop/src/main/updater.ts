/**
 * Whether the app may update itself. A build-time constant, not a setting or an
 * environment variable: an installer that is not signed must not be able to be
 * told to fetch and run another one, so nothing a user or a page can set
 * reaches this. It stays false until the release flow signs (and, on macOS,
 * notarizes) every installer; flipping it is that change's own commit.
 * ADR-0060 keeps auto-update out of scope until then.
 */
export const AUTO_UPDATE_ENABLED: boolean = false;

/** The part of electron-updater's `autoUpdater` this app drives. */
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
}

export interface UpdaterDeps {
  enabled: boolean;
  /** An unpackaged app has no app-update.yml, so there is no feed to ask. */
  packaged: boolean;
  /** Loaded only once the gate is open, so a disabled build never evaluates electron-updater. */
  load: () => UpdaterPort | Promise<UpdaterPort>;
  log: (message: string) => void;
}

export type UpdaterState = 'disabled' | 'checking';

/**
 * Wires electron-updater against the GitHub provider that electron-builder.yml
 * records in app-update.yml. While `enabled` is false it does nothing at all:
 * no module load, no network request.
 */
export class UpdateController {
  private current: UpdaterState = 'disabled';

  constructor(private readonly deps: UpdaterDeps) {}

  state(): UpdaterState {
    return this.current;
  }

  /** Check once for a newer release. The download and the restart stay the person's to start. */
  async start(): Promise<void> {
    if (!this.deps.enabled || !this.deps.packaged) return;
    try {
      const updater = await this.deps.load();
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowDowngrade = false;
      updater.allowPrerelease = false;
      this.current = 'checking';
      await updater.checkForUpdates();
    } catch (error) {
      this.deps.log(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.current === 'checking') this.current = 'disabled';
    }
  }
}
