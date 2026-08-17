import { describe, it, expect, vi } from 'vitest';
import { ApprovalPolicy } from '../ApprovalPolicy';
import { PendingApprovals } from '../PendingApprovals';
import { classifyCommand } from '../commandPolicy';
import type { ApprovalRequest } from '../../interfaces/IApproval';

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { kind: 'shell_command', subject: 'npm test', scope: 'npm test', ...overrides };
}

describe('ApprovalPolicy', () => {
  it('denies when no human channel is wired — the safe default for headless and web', async () => {
    const policy = new ApprovalPolicy();
    expect(await policy.request(req())).toBe(false);
  });

  it('remembers a grant by scope, so a second call on the same scope never re-prompts', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const policy = new ApprovalPolicy({ ask });

    expect(await policy.request(req({ subject: 'npm test' }))).toBe(true);
    expect(await policy.request(req({ subject: 'npm test -- --watch' }))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /**
   * The two halves of the grant boundary have to agree, so these run the real
   * classifier into the real matcher rather than asserting scope strings on
   * their own. The classifier can narrow a scope all it likes; if a remembered
   * grant still matched the narrower one, nothing would have changed.
   */
  describe('a grant does not stretch to a command that scopes differently', () => {
    const shell = (command: string): ApprovalRequest => ({
      kind: 'shell_command',
      subject: command,
      scope: classifyCommand(command).scope,
    });

    it.each([
      ['npm run test', 'npm run postinstall'],
      ['az group list', 'az group delete --name rg1'],
      ['aws s3 ls', 'aws s3 rm s3://bucket/key'],
      ['git ls-remote origin', 'git ls-remote https://attacker.example/r'],
    ])('approving %s does not authorise %s', async (approved, other) => {
      const ask = vi.fn().mockResolvedValue(true);
      const policy = new ApprovalPolicy({ ask });

      expect(await policy.request(shell(approved))).toBe(true);
      expect(await policy.request(shell(other))).toBe(true);
      expect(ask).toHaveBeenCalledTimes(2);
    });

    // A session that outlives the change, or a pre-approved scope written
    // against the old rule, must not carry the old grant onto the new one.
    it.each([
      ['npm run', 'npm run postinstall'],
      ['az group', 'az group delete --name rg1'],
      ['aws s3', 'aws s3 rm s3://bucket/key'],
      ['git ls-remote', 'git ls-remote https://attacker.example/r'],
    ])('a grant remembered as "%s" does not satisfy %s', async (coarse, command) => {
      const ask = vi.fn().mockResolvedValue(false);
      const policy = new ApprovalPolicy({ ask, preApproved: [coarse] });

      expect(await policy.request({ kind: 'shell_command', subject: coarse, scope: coarse })).toBe(true);
      expect(await policy.request(shell(command))).toBe(false);
      expect(ask).toHaveBeenCalledTimes(1);
    });
  });

  it('remembers a denial too, so a retrying model burns a tool round instead of the user', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const policy = new ApprovalPolicy({ ask });

    expect(await policy.request(req())).toBe(false);
    expect(await policy.request(req())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent asks for one scope into a single prompt', async () => {
    let resolveAsk: (v: boolean) => void = () => {};
    const ask = vi.fn().mockImplementation(() => new Promise<boolean>((r) => { resolveAsk = r; }));
    const policy = new ApprovalPolicy({ ask });

    const both = Promise.all([policy.request(req()), policy.request(req())]);
    resolveAsk(true);

    expect(await both).toEqual([true, true]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('honors pre-approved scopes without asking', async () => {
    const ask = vi.fn();
    const policy = new ApprovalPolicy({ ask, preApproved: ['npm test'] });

    expect(await policy.request(req())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('matches a pre-approved scope by prefix when it ends in *', async () => {
    const policy = new ApprovalPolicy({ preApproved: ['/tmp/fixtures/*'] });
    expect(await policy.request(req({ kind: 'external_path', scope: '/tmp/fixtures/deep/*' }))).toBe(true);
    expect(await policy.request(req({ kind: 'external_path', scope: '/etc/*' }))).toBe(false);
  });

  it('honors pre-approved scopes even under deny mode, since they are an explicit operator decision', async () => {
    const policy = new ApprovalPolicy({ mode: 'deny', preApproved: ['az group'] });
    expect(await policy.request(req({ scope: 'az group' }))).toBe(true);
    expect(await policy.request(req({ scope: 'az vm' }))).toBe(false);
  });

  it('allow mode grants without a channel; deny mode refuses despite one', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    expect(await new ApprovalPolicy({ mode: 'allow' }).request(req())).toBe(true);
    expect(await new ApprovalPolicy({ mode: 'deny', ask }).request(req())).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('treats an asker that throws as a denial rather than failing the research turn', async () => {
    const policy = new ApprovalPolicy({ ask: vi.fn().mockRejectedValue(new Error('socket closed')) });
    expect(await policy.request(req())).toBe(false);
  });

  it('reset drops session grants, so one session cannot inherit another approval', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const policy = new ApprovalPolicy({ ask });

    await policy.request(req());
    expect(policy.grantedScopes()).toEqual(['npm test']);

    policy.reset();
    expect(policy.grantedScopes()).toEqual([]);

    await policy.request(req());
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('reset also drops remembered denials, so a blocked scope re-prompts after reset', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const policy = new ApprovalPolicy({ ask });

    expect(await policy.request(req())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);

    policy.reset();

    expect(await policy.request(req())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('reset mid-ask does not let the in-flight answer re-populate granted/refused', async () => {
    let resolveAsk: (v: boolean) => void = () => {};
    const ask = vi.fn().mockImplementation(() => new Promise<boolean>((r) => { resolveAsk = r; }));
    const policy = new ApprovalPolicy({ ask });

    const pending = policy.request(req());
    policy.reset();
    resolveAsk(true);
    await pending;

    expect(policy.grantedScopes()).toEqual([]);
    // A fresh request after reset re-prompts rather than reusing the stale grant.
    const second = policy.request(req());
    resolveAsk(false);
    await second;
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('reports the decision source so a surface can explain why nothing was asked', async () => {
    const onDecision = vi.fn();
    const policy = new ApprovalPolicy({ preApproved: ['npm test'], onDecision });
    await policy.request(req());
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ scope: 'npm test' }), true, 'pre-approved');
  });
});

describe('PendingApprovals', () => {
  it('announces a request and resolves it when a surface answers', async () => {
    const onRequest = vi.fn();
    const pending = new PendingApprovals({ onRequest });

    const answer = pending.ask(req());
    const announced = onRequest.mock.calls[0][0];

    expect(pending.outstanding()).toHaveLength(1);
    expect(pending.resolve(announced.id, true)).toBe(true);
    expect(await answer).toBe(true);
    expect(pending.outstanding()).toHaveLength(0);
  });

  it('reports settlement so every connected surface can retire its prompt', async () => {
    const onSettled = vi.fn();
    const onRequest = vi.fn();
    const pending = new PendingApprovals({ onRequest, onSettled });

    const answer = pending.ask(req());
    pending.resolve(onRequest.mock.calls[0][0].id, false);

    expect(await answer).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('ignores an unknown or already-settled id', async () => {
    const onRequest = vi.fn();
    const pending = new PendingApprovals({ onRequest });
    const answer = pending.ask(req());
    const { id } = onRequest.mock.calls[0][0];

    expect(pending.resolve('nope', true)).toBe(false);
    expect(pending.resolve(id, true)).toBe(true);
    expect(pending.resolve(id, true)).toBe(false);
    await answer;
  });

  it('denies on timeout, so an unanswered prompt cannot hang the research loop forever', async () => {
    vi.useFakeTimers();
    const pending = new PendingApprovals({ timeoutMs: 1000 });
    const answer = pending.ask(req());

    await vi.advanceTimersByTimeAsync(1001);
    expect(await answer).toBe(false);
    vi.useRealTimers();
  });

  // T5: after the timeout has already denied a prompt, a late answer from any
  // surface must be a no-op — it must neither resurrect the entry nor report a
  // second resolution, or the planner could see two decisions for one ask.
  it('a late answer after timeout is a no-op and does not resurrect the entry', async () => {
    vi.useFakeTimers();
    const onRequest = vi.fn();
    const onSettled = vi.fn();
    const pending = new PendingApprovals({ timeoutMs: 1000, onRequest, onSettled });
    const answer = pending.ask(req());
    const { id } = onRequest.mock.calls[0][0];

    await vi.advanceTimersByTimeAsync(1001);
    await answer;

    expect(pending.resolve(id, true)).toBe(false);
    expect(pending.outstanding()).toHaveLength(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('clear denies everything in flight', async () => {
    const pending = new PendingApprovals();
    const answer = pending.ask(req());
    pending.clear();
    expect(await answer).toBe(false);
  });
});
