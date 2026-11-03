import type { ActionResult, NotificationRequest } from '../shared/bridge';

/** What main can do with the OS: show one notification, and set the attention badge. */
export interface NotificationPort {
  /** The user's mute preference, read at the moment of the notification. */
  muted(): boolean;
  present(title: string, body: string, onClick: () => void): void;
  /** The count on the Dock, the launcher or the taskbar; 0 clears it. */
  badge(count: number): void;
}

/**
 * The desktop's one attention notifier. It keeps the ids it has shown so a
 * view that re-reads the same list cannot ring twice, and leaves whether the
 * user wants to be told to {@link NotificationPort.muted}, which main reads
 * from the app's own preferences.
 */
export class AttentionNotifier {
  private readonly shown = new Set<string>();

  constructor(private readonly port: NotificationPort) {}

  /** Show a new notification, or nothing for one already shown. A muted app still counts as having seen it. */
  show(request: NotificationRequest, onClick: () => void): ActionResult {
    if (this.shown.has(request.id)) return { ok: true };
    this.shown.add(request.id);
    if (this.port.muted()) return { ok: true };
    try {
      this.port.present(request.title, request.body, onClick);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The badge is not a notification: muting the banners does not hide the count. */
  setBadge(count: number): void {
    this.port.badge(Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)));
  }

  /** Tests and a settings change: a later notification with the same id is a new one. */
  forget(): void {
    this.shown.clear();
  }
}
