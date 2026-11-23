import { FIRST_RUN_FEEDBACK } from '@ordewell/core/plan-utils';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost } from '../../session/DaemonHost';

const ID = 'feedback.firstRun';

/**
 * The first-run feedback notice (ADR-0075): once per machine, when a run's
 * end stands with every task passed, a banner asks how it went. A banner
 * takes no focus and holds nothing up, and its title is said once by the
 * window's polite live region. Main decides whether this machine still owes
 * it, and records it before the banner shows, so neither this window nor any
 * other surface shows it again, whichever button is pressed or none.
 */
export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  let hide: (() => void) | undefined;
  const close = (): void => {
    hide?.();
    hide = undefined;
  };
  const open = async (url: string): Promise<void> => {
    close();
    await window.ordewell.shell.openExternal(url);
  };

  const offPassed = host.onRunPassed((summary) => {
    // A test's bridge, or an older preload, has no feedback channel.
    void window.ordewell.feedback?.claim(summary).then((shown) => {
      if (!shown) return;
      hide = api.showBanner({
        id: ID,
        tone: 'info',
        title: FIRST_RUN_FEEDBACK.title,
        body: FIRST_RUN_FEEDBACK.text,
        actions: [
          ...FIRST_RUN_FEEDBACK.actions.map((action) => ({ label: action.label, run: () => open(action.url) })),
          { label: 'Dismiss', run: close },
        ],
      });
    }, () => {});
  });

  return () => {
    offPassed();
    close();
  };
}
