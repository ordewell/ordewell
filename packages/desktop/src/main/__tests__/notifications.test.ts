import { describe, expect, it, vi } from 'vitest';
import { AttentionNotifier, type NotificationPort } from '../notifications';

function port(overrides: Partial<NotificationPort> = {}): NotificationPort {
  return { muted: () => false, present: vi.fn(), badge: vi.fn(), ...overrides };
}

const request = { id: 'approval:t1:1:a1', title: 'Needs you', body: 't1 asks for an approval', taskId: 't1' };

describe('AttentionNotifier', () => {
  it('shows one notification for an id, however often a view re-reads the list', () => {
    const p = port();
    const notifier = new AttentionNotifier(p);
    const click = vi.fn();

    expect(notifier.show(request, click)).toEqual({ ok: true });
    expect(notifier.show(request, click)).toEqual({ ok: true });

    expect(p.present).toHaveBeenCalledTimes(1);
    expect(p.present).toHaveBeenCalledWith(request.title, request.body, click);
  });

  it('rings nothing while the user has muted notifications, and remembers the id', () => {
    let muted = true;
    const p = port({ muted: () => muted });
    const notifier = new AttentionNotifier(p);

    expect(notifier.show(request, vi.fn())).toEqual({ ok: true });
    muted = false;
    expect(notifier.show(request, vi.fn())).toEqual({ ok: true });

    expect(p.present).not.toHaveBeenCalled();
  });

  it('badges the count regardless of the mute, and refuses a nonsense one', () => {
    const p = port({ muted: () => true });
    const notifier = new AttentionNotifier(p);

    notifier.setBadge(3);
    notifier.setBadge(-2);
    notifier.setBadge(Number.NaN);

    expect(vi.mocked(p.badge).mock.calls).toEqual([[3], [0], [0]]);
  });

  it('says why a platform that refused the notification did', () => {
    const p = port({ present: vi.fn(() => { throw new Error('notifications are unavailable'); }) });
    expect(new AttentionNotifier(p).show(request, vi.fn())).toEqual({ ok: false, message: 'notifications are unavailable' });
  });

  it('forgets what it showed so a later wait with the same id is a new notification', () => {
    const p = port();
    const notifier = new AttentionNotifier(p);
    notifier.show(request, vi.fn());
    notifier.forget();
    notifier.show(request, vi.fn());
    expect(p.present).toHaveBeenCalledTimes(2);
  });
});
