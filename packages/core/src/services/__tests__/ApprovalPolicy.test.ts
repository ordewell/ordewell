import { describe, it, expect, vi } from 'vitest';
import { ApprovalPolicy, effectiveApprovalMode, parseApprovalModeSetting, type ApprovalMode } from '../ApprovalPolicy';
import { DEFAULT_PLANNER_ALLOWLIST } from '../plannerAllowlist';
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

// One command can need its own approval and an outside path at once. It asks
// once for both, and each scope is remembered on its own.
describe('ApprovalPolicy — one request covering several scopes', () => {
  const both = (): ApprovalRequest => req({ subject: 'npm --prefix /opt/app test', scope: 'npm', scopes: ['npm', '/opt/*'] });

  it('asks once, then remembers every scope it granted', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const policy = new ApprovalPolicy({ ask });

    expect(await policy.request(both())).toBe(true);
    expect(await policy.request(req({ kind: 'external_path', subject: '/opt/x', scope: '/opt/*' }))).toBe(true);
    expect(await policy.request(req({ subject: 'npm ci', scope: 'npm' }))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks only about the scopes not already granted', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const policy = new ApprovalPolicy({ ask, preApproved: ['/opt/*'] });

    expect(await policy.request(both())).toBe(true);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ scope: 'npm' }));
    expect(ask.mock.calls[0][0].scopes).toBeUndefined();
  });

  it('does not ask when every scope is already granted', async () => {
    const ask = vi.fn();
    const policy = new ApprovalPolicy({ ask, preApproved: ['npm', '/opt/*'] });

    expect(await policy.request(both())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('denies without asking when one of its scopes was refused before', async () => {
    const ask = vi.fn().mockResolvedValueOnce(false);
    const policy = new ApprovalPolicy({ ask });

    expect(await policy.request(req({ kind: 'external_path', subject: '/opt/x', scope: '/opt/*' }))).toBe(false);
    expect(await policy.request(both())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  // A "no" to the pair may have been about either half, so it does not refuse
  // each half on its own — but the same pair is not asked twice.
  it('remembers a denial for the pair, not for each scope in it', async () => {
    const ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const policy = new ApprovalPolicy({ ask });

    expect(await policy.request(both())).toBe(false);
    expect(await policy.request(both())).toBe(false);
    expect(await policy.request(req({ subject: 'npm ci', scope: 'npm' }))).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('lists every scope it granted', async () => {
    const policy = new ApprovalPolicy({ ask: vi.fn().mockResolvedValue(true) });
    await policy.request(both());
    expect(policy.grantedScopes()).toEqual(['npm', '/opt/*']);
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
    expect(onSettled).toHaveBeenCalledWith(expect.any(String), false, { request: req(), decision: { decision: 'deny' } });
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

describe('PendingApprovals decisions (ADR-0018, A1)', () => {
  const runnerReq = (overrides: Partial<ApprovalRequest> = {}) =>
    req({ kind: 'runner_tool', subject: 'Write(/repo/a.txt)', scope: 'Write', taskId: 't1', allowForTask: true, ...overrides });

  it('carries the whole answer: allow, allow for this task, deny with a note', async () => {
    const pending = new PendingApprovals();
    const allowed = pending.decide(runnerReq(), { id: 'a' });
    const forTask = pending.decide(runnerReq(), { id: 'b' });
    const denied = pending.decide(runnerReq(), { id: 'c' });

    pending.resolve('a', { decision: 'allow' });
    pending.resolve('b', { decision: 'allowForTask' });
    pending.resolve('c', { decision: 'deny', note: 'use notes/ instead' });
    expect(await allowed).toEqual({ decision: 'allow' });
    expect(await forTask).toEqual({ decision: 'allowForTask' });
    expect(await denied).toEqual({ decision: 'deny', note: 'use notes/ instead' });
  });

  it('still takes a planner surface\'s yes or no', async () => {
    const pending = new PendingApprovals();
    const yes = pending.decide(req(), { id: 'y' });
    const no = pending.ask(req(), { id: 'n' });
    pending.resolve('y', true);
    pending.resolve('n', false);
    expect(await yes).toEqual({ decision: 'allow' });
    expect(await no).toBe(false);
  });

  it('makes allow for this task a plain allow when the request never offered it', async () => {
    const pending = new PendingApprovals();
    const answer = pending.decide(runnerReq({ allowForTask: false }), { id: 'a' });
    pending.resolve('a', { decision: 'allowForTask' });
    expect(await answer).toEqual({ decision: 'allow' });
  });

  it('waits for a runner\'s answer with no timeout, while the planner\'s still expires', async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingApprovals({ timeoutMs: 1000 });
      const runner = pending.decide(runnerReq(), { id: 'r', noTimeout: true });
      const planner = pending.ask(req());
      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(await planner).toBe(false);
      expect(pending.outstanding().map((p) => p.id)).toEqual(['r']);
      pending.resolve('r', { decision: 'allow' });
      expect(await runner).toEqual({ decision: 'allow' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the answer to onDecision before anything awaiting it runs', () => {
    const pending = new PendingApprovals();
    const seen: string[] = [];
    void pending.decide(runnerReq(), { id: 'r', onDecision: (d) => seen.push(d.decision) });
    pending.resolve('r', { decision: 'deny' });
    expect(seen).toEqual(['deny']);
  });

  it('refuses an id already in use rather than overwriting its request', async () => {
    const pending = new PendingApprovals();
    const first = pending.decide(runnerReq(), { id: 'r' });
    expect(await pending.decide(runnerReq({ subject: 'Bash(rm -rf /)' }), { id: 'r' })).toEqual({ decision: 'deny' });
    expect(pending.outstanding()).toHaveLength(1);
    expect(pending.outstanding()[0].request.subject).toBe('Write(/repo/a.txt)');
    pending.resolve('r', true);
    await first;
  });

  it('clears only the requests it is told to', async () => {
    const pending = new PendingApprovals();
    const runner = pending.decide(runnerReq(), { id: 'r', noTimeout: true });
    const planner = pending.ask(req());
    pending.clear((r) => r.kind !== 'runner_tool');
    expect(await planner).toBe(false);
    expect(pending.outstanding().map((p) => p.id)).toEqual(['r']);
    pending.clear();
    expect(await runner).toEqual({ decision: 'deny' });
  });
});

describe('ApprovalPolicy — the planner allowlist (ADR-0026)', () => {
  const tool = (name: string): ApprovalRequest => ({ kind: 'mcp_tool', subject: name, scope: `mcp__todoist__${name}`, tool: name });

  it('runs an MCP tool that reads without asking, and asks about one that writes', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const policy = new ApprovalPolicy({ ask, preApproved: DEFAULT_PLANNER_ALLOWLIST });

    expect(await policy.request(tool('find-tasks'))).toBe(true);
    expect(await policy.request(tool('add-tasks'))).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('takes a command the classifier found covered as pre-approved, but never the outside directory it touches', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const policy = new ApprovalPolicy({ ask, preApproved: [] });

    expect(await policy.request({ kind: 'shell_command', subject: 'gh issue list', scope: 'gh issue list', allowedBy: 'gh issue list' })).toBe(true);
    expect(await policy.request({ kind: 'shell_command', subject: 'gh issue view -R x /opt/a', scope: 'gh issue view', scopes: ['gh issue view', '/opt/*'], allowedBy: 'gh issue view' })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('reads the mode and the entries afresh on every request', async () => {
    let mode: ApprovalMode = 'deny';
    let entries: string[] = [];
    const policy = new ApprovalPolicy({ mode: () => mode, preApproved: () => entries });

    expect(await policy.request(req())).toBe(false);
    entries = ['npm test'];
    expect(await policy.request(req({ scope: 'npm test', subject: 'npm test --silent' }))).toBe(true);
    mode = 'allow';
    expect(await policy.request(req({ scope: 'az vm list', subject: 'az vm list' }))).toBe(true);
  });
});

describe('the configured approval mode', () => {
  it('follows the autonomy level when it is auto, and is otherwise what it says', () => {
    expect(effectiveApprovalMode('auto', true)).toBe('deny');
    expect(effectiveApprovalMode('auto', false)).toBe('ask');
    expect(effectiveApprovalMode('ask', true)).toBe('ask');
    expect(effectiveApprovalMode('allow', false)).toBe('allow');
  });

  it('reads allowlist as deny, and anything unknown as auto', () => {
    expect(parseApprovalModeSetting('allowlist')).toBe('deny');
    expect(parseApprovalModeSetting(' Ask ')).toBe('ask');
    expect(parseApprovalModeSetting(undefined)).toBe('auto');
    expect(parseApprovalModeSetting('whatever')).toBe('auto');
  });
});
