import { describe, it, expect, vi } from 'vitest';
import { makeSession } from './sessionTestKit';
import { BaseFileSystem } from '../BaseFileSystem';
import { fakeConfig } from '../../testing';
import type { SessionMessage } from '../SessionMessage';
import type { ConversationRequest } from '../AiService';
import type { GrepOptions, ReadFileOpts, ToolOutcome } from '../../interfaces/IFileSystem';

/**
 * The approval round-trip as every surface sees it: research asks, the Session
 * broadcasts, a surface answers through `resolveApproval`, research unblocks.
 * Tested through the broadcast seam and the filesystem's public methods, so it
 * holds regardless of which UI is on the other end.
 */
class ProbeFileSystem extends BaseFileSystem {
  bashCalls: string[] = [];
  getWorkspaceRoot(): string { return '/repo'; }
  protected async readFileImpl(absPath: string, _opts?: ReadFileOpts): Promise<ToolOutcome> {
    return { success: true, output: `body of ${absPath}`, truncated: false };
  }
  protected async globImpl(): Promise<ToolOutcome> { return { success: true, output: '', truncated: false }; }
  protected async grepImpl(_p: string, _r: string, _o: GrepOptions): Promise<ToolOutcome> {
    return { success: true, output: '', truncated: false };
  }
  protected async listDirImpl(): Promise<ToolOutcome> { return { success: true, output: '', truncated: false }; }
  protected async execBashImpl(command: string): Promise<ToolOutcome> {
    this.bashCalls.push(command);
    return { success: true, output: 'ran', truncated: false };
  }
}

function sessionWithProbe(configOverrides: Parameters<typeof fakeConfig>[0] = {}) {
  const messages: SessionMessage[] = [];
  const fsAdapter = new ProbeFileSystem();
  const session = makeSession({
    fsAdapter,
    config: fakeConfig(configOverrides),
    broadcast: (msg) => { messages.push(msg); },
  });
  return { session, fsAdapter, messages };
}

const approvalRequests = (messages: SessionMessage[]) =>
  messages.filter((m): m is Extract<SessionMessage, { type: 'approval_request' }> => m.type === 'approval_request');

const approvalDecisions = (messages: SessionMessage[]) =>
  messages.filter((m): m is Extract<SessionMessage, { type: 'approval_decided' }> => m.type === 'approval_decided');

describe('Session approval flow', () => {
  it('broadcasts a request when research reaches outside the workspace', async () => {
    const { fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));

    const [request] = approvalRequests(messages);
    expect(request.kind).toBe('external_path');
    expect(request.subject).toBe('/tmp/dump/a.log');
    expect(request.scope).toBe('/tmp/dump/*');
    expect(request.detail).toContain('outside the workspace');

    // Leave nothing pending for the next test's timers.
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    expect(await Promise.race([pending, Promise.resolve('still-blocked')])).toBe('still-blocked');
  });

  it('ties a request raised during a planner turn to that turn', async () => {
    const messages: SessionMessage[] = [];
    const fsAdapter = new ProbeFileSystem();
    const session = makeSession({
      fsAdapter,
      broadcast: (msg) => { messages.push(msg); },
      aiService: {
        startConversation: vi.fn(async (req: ConversationRequest) => {
          await req.fs.readFile('/tmp/dump/a.log');
          return { kind: 'message' as const, text: 'Read it.', researchLog: [] };
        }),
        hasActiveConversation: () => true,
      },
    });

    const planning = session.startPlanning('summarize the dump', ['claude-code']);
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    session.resolveApproval(approvalRequests(messages)[0].id, true);
    await planning;

    const started = messages.find((m) => m.type === 'planner_turn_started');
    expect(approvalRequests(messages)[0].turnId).toBe(started && 'turnId' in started ? started.turnId : 'no turn');
  });

  it('unblocks the waiting research call when a surface grants it', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));

    expect(session.resolveApproval(approvalRequests(messages)[0].id, true)).toBe(true);

    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.output).toBe('body of /tmp/dump/a.log');
  });

  it('returns an actionable denial when a surface refuses', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    session.resolveApproval(approvalRequests(messages)[0].id, false);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.output).toContain('not approved');
  });

  it('broadcasts settlement so every connected surface retires its prompt', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    const { id } = approvalRequests(messages)[0];
    session.resolveApproval(id, true);
    await pending;

    expect(messages).toContainEqual({ type: 'approval_settled', id, granted: true });
  });

  it('gates an ask-tier shell command through the same channel', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.bash('npm test');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));

    expect(approvalRequests(messages)[0]).toMatchObject({ kind: 'shell_command', scope: 'npm test' });
    session.resolveApproval(approvalRequests(messages)[0].id, true);

    await pending;
    expect(fsAdapter.bashCalls).toEqual(['npm test']);
  });

  it('never asks for an auto-tier command or an in-workspace read', async () => {
    const { fsAdapter, messages } = sessionWithProbe();

    await fsAdapter.bash('git log --oneline');
    await fsAdapter.readFile('src/index.ts');

    expect(approvalRequests(messages)).toHaveLength(0);
  });

  it('surfaces outstanding requests so a surface joining mid-prompt can render them', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));

    expect(session.outstandingApprovals()).toHaveLength(1);
    expect(session.outstandingApprovals()[0].request.subject).toBe('/tmp/dump/a.log');

    session.resolveApproval(session.outstandingApprovals()[0].id, false);
    await pending;
    expect(session.outstandingApprovals()).toHaveLength(0);
  });

  it('remembers a granted scope for the session and reports it', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const first = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    session.resolveApproval(approvalRequests(messages)[0].id, true);
    await first;

    const second = await fsAdapter.readFile('/tmp/dump/b.log');

    expect(second.success).toBe(true);
    expect(approvalRequests(messages)).toHaveLength(1);
    expect(session.approvedScopes()).toEqual(['/tmp/dump/*']);
  });

  it('drops grants on reset, because session boundaries are hard', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const first = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    session.resolveApproval(approvalRequests(messages)[0].id, true);
    await first;

    session.reset();
    expect(session.approvedScopes()).toEqual([]);

    const second = fsAdapter.readFile('/tmp/dump/b.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(2));
    session.resolveApproval(approvalRequests(messages)[1].id, false);
    await second;
  });

  // T7: a reset while an approval is still in flight must not let the dying
  // prompt's denial bleed into the next session as a remembered refusal.
  it('reset mid-prompt does not remember the abandoned denial for the next session', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const first = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    // Reset WITHOUT answering — the pending prompt is abandoned.
    session.reset();
    await first;

    // A new request on the same scope must prompt again, not silently deny.
    const second = fsAdapter.readFile('/tmp/dump/a.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(2));
    session.resolveApproval(approvalRequests(messages)[1].id, true);
    const result = await second;
    expect(result.success).toBe(true);
  });

  // T1: a single bash command touching two external directories prompts once
  // per distinct scope — approving the first does not carry the grant to the
  // second.
  it('asks once about every distinct external path in one bash command', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const pending = fsAdapter.bash('cat /etc/passwd /tmp/dump/secret.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    expect(approvalRequests(messages)[0].scope).toBe('/etc/*, /tmp/dump/*');
    session.resolveApproval(approvalRequests(messages)[0].id, true);

    const result = await pending;
    expect(result.success).toBe(true);
    expect(approvalRequests(messages)).toHaveLength(1);
    expect(fsAdapter.bashCalls).toEqual(['cat /etc/passwd /tmp/dump/secret.log']);
  });

  it('asks only about the path not granted yet, so one grant never covers another', async () => {
    const { session, fsAdapter, messages } = sessionWithProbe();

    const first = fsAdapter.bash('cat /etc/passwd');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
    session.resolveApproval(approvalRequests(messages)[0].id, true);
    await first;

    const pending = fsAdapter.bash('cat /etc/passwd /tmp/dump/secret.log');
    await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(2));
    expect(approvalRequests(messages)[1].scope).toBe('/tmp/dump/*');
    session.resolveApproval(approvalRequests(messages)[1].id, false);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.output).toContain('not approved');
    expect(fsAdapter.bashCalls).toEqual(['cat /etc/passwd']);
  });

  it('denies without asking when the operator configured deny mode', async () => {
    const { fsAdapter, messages } = sessionWithProbe({ approvalMode: 'deny' });

    const result = await fsAdapter.bash('npm test');

    expect(result.success).toBe(false);
    expect(approvalRequests(messages)).toHaveLength(0);
  });

  it('honors a pre-approved scope from config without prompting', async () => {
    const { fsAdapter, messages } = sessionWithProbe({ approvalPreApproved: ['npm test'] });

    const result = await fsAdapter.bash('npm test');

    expect(result.success).toBe(true);
    expect(fsAdapter.bashCalls).toEqual(['npm test']);
    expect(approvalRequests(messages)).toHaveLength(0);
  });

  // The approval mode follows the autonomy level unless one is set (ADR-0026).
  describe('under the default allowlist', () => {
    const withDefaults = (autonomousMode: boolean) => sessionWithProbe({ approvalMode: 'auto', approvalDefaults: true, autonomousMode });

    it('runs an allowlisted read without asking, at either level, and says it was pre-approved', async () => {
      for (const autonomousMode of [true, false]) {
        const { fsAdapter, messages } = withDefaults(autonomousMode);

        expect((await fsAdapter.bash('gh issue list --state open')).success).toBe(true);
        expect(fsAdapter.bashCalls).toEqual(['gh issue list --state open']);
        expect(approvalRequests(messages)).toHaveLength(0);
        expect(approvalDecisions(messages)).toEqual([expect.objectContaining({ granted: true, source: 'pre-approved' })]);
      }
    });

    it('refuses anything else without asking under Full, and points the planner at an ops task', async () => {
      const { fsAdapter, messages } = withDefaults(true);

      const result = await fsAdapter.bash('gh issue close 12');

      expect(result.success).toBe(false);
      expect(result.output).toContain('ops task');
      expect(fsAdapter.bashCalls).toEqual([]);
      expect(approvalRequests(messages)).toHaveLength(0);
    });

    it('asks about anything else under Guarded', async () => {
      const { session, fsAdapter, messages } = withDefaults(false);

      const pending = fsAdapter.bash('gh issue close 12');
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
      session.resolveApproval(approvalRequests(messages)[0].id, true);

      expect((await pending).success).toBe(true);
      expect(fsAdapter.bashCalls).toEqual(['gh issue close 12']);
    });

    it('still refuses a write, whatever the allowlist and the level', async () => {
      const { fsAdapter, messages } = sessionWithProbe({ approvalMode: 'allow', approvalDefaults: true, approvalPreApproved: ['touch'] });

      expect((await fsAdapter.bash('touch notes.txt')).output).toContain('Command refused');
      expect(fsAdapter.bashCalls).toEqual([]);
      expect(approvalRequests(messages)).toHaveLength(0);
    });
  });

  /**
   * The stop path, from the user's side: they pressed ESC while an approval
   * prompt was on screen. Nothing else denies the parked request, so without a
   * listener on the planning signal the turn sits out the five-minute timeout
   * and then carries on researching — which is exactly what "ESC did nothing"
   * looked like in practice.
   */
  describe('aborting a planning turn parked on an approval', () => {
    function sessionParkedOnApproval() {
      const messages: SessionMessage[] = [];
      const fsAdapter = new ProbeFileSystem();
      const controller = new AbortController();
      const bash: { outcome?: ToolOutcome } = {};

      const session = makeSession({
        fsAdapter,
        broadcast: (msg) => { messages.push(msg); },
        aiService: {
          hasActiveConversation: () => true,
          startConversation: async ({ signal }) => {
            bash.outcome = await fsAdapter.bash('npm test');
            return {
              kind: 'message' as const,
              text: signal?.aborted ? 'Stopped.' : 'Ran the suite.',
              researchLog: [],
            };
          },
        },
      });

      return { session, fsAdapter, messages, controller, bash };
    }

    it('denies the request the moment the abort fires, rather than waiting out the timeout', async () => {
      const { session, messages, controller, bash } = sessionParkedOnApproval();

      const planning = session.startPlanning('goal', ['claude-code'], { signal: controller.signal });
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));

      controller.abort();
      await planning;

      expect(bash.outcome?.success).toBe(false);
      expect(bash.outcome?.output).toContain('not approved');
      expect(session.outstandingApprovals()).toEqual([]);
    });

    it('denies it just the same when the stop comes through the session rather than a caller signal', async () => {
      const { session, messages, bash } = sessionParkedOnApproval();

      const planning = session.startPlanning('goal', ['claude-code']);
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));

      expect(session.abortPlannerTurn()).toBe(true);
      await planning;

      expect(bash.outcome?.output).toContain('not approved');
      expect(session.outstandingApprovals()).toEqual([]);
    });

    it('lands the stopped turn as a message, so the transcript shows where research ended', async () => {
      const { session, messages, controller } = sessionParkedOnApproval();

      const planning = session.startPlanning('goal', ['claude-code'], { signal: controller.signal });
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
      controller.abort();
      const plan = await planning;

      expect(plan.conversationHistory?.at(-1)).toMatchObject({ role: 'assistant', content: 'Stopped.' });
    });

    it('drops the listener when the turn settles, so a reused signal cannot deny the next turn', async () => {
      const { session, fsAdapter, messages, controller } = sessionParkedOnApproval();

      const planning = session.startPlanning('goal', ['claude-code'], { signal: controller.signal });
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
      session.resolveApproval(approvalRequests(messages)[0].id, true);
      await planning;

      // The turn is over; this prompt belongs to whatever comes next.
      const orphan = fsAdapter.readFile('/tmp/dump/a.log');
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(2));
      controller.abort();

      expect(await Promise.race([orphan, Promise.resolve('still-blocked')])).toBe('still-blocked');
      session.resolveApproval(approvalRequests(messages)[1].id, false);
      await orphan;
    });
  });

  // A silent decision (pre-approved, remembered, or the operator's mode floor)
  // previously had no broadcast at all — indistinguishable, on every surface,
  // from the model never having needed approval in the first place.
  describe('approval_decided — visibility for decisions that never prompted', () => {
    it('broadcasts a pre-approved grant', async () => {
      const { fsAdapter, messages } = sessionWithProbe({ approvalPreApproved: ['npm test'] });

      await fsAdapter.bash('npm test');

      expect(approvalDecisions(messages)).toEqual([
        expect.objectContaining({ kind: 'shell_command', scope: 'npm test', granted: true, source: 'pre-approved' }),
      ]);
    });

    it('broadcasts a mode-floor denial', async () => {
      const { fsAdapter, messages } = sessionWithProbe({ approvalMode: 'deny' });

      await fsAdapter.bash('npm test');

      expect(approvalDecisions(messages)).toEqual([
        expect.objectContaining({ scope: 'npm test', granted: false, source: 'mode' }),
      ]);
    });

    it('broadcasts a remembered grant on the second call, not the first', async () => {
      const { session, fsAdapter, messages } = sessionWithProbe();

      const first = fsAdapter.readFile('/tmp/dump/a.log');
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
      session.resolveApproval(approvalRequests(messages)[0].id, true);
      await first;
      expect(approvalDecisions(messages)).toHaveLength(0);

      await fsAdapter.readFile('/tmp/dump/b.log');

      expect(approvalDecisions(messages)).toEqual([
        expect.objectContaining({ subject: '/tmp/dump/b.log', granted: true, source: 'remembered' }),
      ]);
    });

    it('does not broadcast a decision for the interactive path — approval_request/settled already cover it', async () => {
      const { session, fsAdapter, messages } = sessionWithProbe();

      const pending = fsAdapter.readFile('/tmp/dump/a.log');
      await vi.waitFor(() => expect(approvalRequests(messages)).toHaveLength(1));
      session.resolveApproval(approvalRequests(messages)[0].id, true);
      await pending;

      expect(approvalDecisions(messages)).toHaveLength(0);
    });

    it('does not broadcast anything for a refuse-tier command — it never reaches the approval policy at all', async () => {
      const { fsAdapter, messages } = sessionWithProbe();

      await fsAdapter.bash('rm -rf /tmp/x');

      expect(approvalDecisions(messages)).toHaveLength(0);
      expect(approvalRequests(messages)).toHaveLength(0);
    });
  });
});
