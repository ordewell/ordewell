import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { draftPlan, liveDaemon, type LiveDaemon } from './liveDaemon';

/**
 * A request answered in a joined desktop window is no longer outstanding: the
 * daemon refuses the second answer and says why. The TUI shows that, not a
 * claim that the task is still waiting.
 */
describe('an approval answer the daemon refuses', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  const failures = (tui: ReturnType<LiveDaemon['tui']>): string[] =>
    tui.actions.flatMap((action) => (action.type === 'failed' ? [action.message] : []));

  it.each([
    ['a task\'s', { type: 'answerTaskApproval' as const, answer: { decision: 'allow' as const } }],
    ['the planner\'s', { type: 'respondApproval' as const, granted: true }],
  ])('shows the daemon\'s word on %s request', async (_who, effect) => {
    daemon.save(draftPlan(), 's');
    const tui = daemon.tui();
    await tui.run({ type: 'loadSession', sessionId: 's' });

    await tui.run({ ...effect, sessionId: 's', approvalId: 'gone' });

    const said = failures(tui);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('no longer outstanding');
    expect(said[0]).not.toContain('still waiting');
  });
});
