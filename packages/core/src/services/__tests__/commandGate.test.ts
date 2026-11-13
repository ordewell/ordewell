import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPolicy } from '../ApprovalPolicy';
import { decide, type GateSite, type GateVerdict, type GateWho, type Settled } from '../commandGate';
import type { EgressCheck } from '../egressGuard';
import { grantScopeFor } from '../pathScope';
import { ParsedLine } from '../parsedLine';
import type { ToolOutcome } from '../../interfaces/IFileSystem';

/**
 * The command gate decides, with no filesystem: what each site may ask, which
 * standing answers count there, and what runs sealed (ADR-0008, ADR-0036,
 * ADR-0046, ADR-0011 B3).
 */

const ROOT = resolve(tmpdir(), 'gate-workspace');
const OUTSIDE = resolve('/etc/hosts');

interface Fixture {
  approval: ApprovalPolicy;
  /** Every request that reached a person. */
  asked: string[];
}

/** The session's approvals under Guarded, whose card answers `yes` only for the commands it names. */
function approvals(opts: { preApproved?: string[]; yes?: string[] | 'all'; mode?: 'ask' | 'deny' } = {}): Fixture {
  const asked: string[] = [];
  const approval = new ApprovalPolicy({
    mode: opts.mode ?? 'ask',
    preApproved: opts.preApproved ?? [],
    ask: async (req) => {
      asked.push(req.subject);
      return opts.yes === 'all' || (opts.yes?.includes(req.subject) ?? false);
    },
  });
  return { approval, asked };
}

function site(who: GateWho, approval: ApprovalPolicy, over: Partial<GateSite> = {}): GateSite {
  return {
    who,
    root: ROOT,
    approval,
    canSeal: async () => false,
    outboundSecrets: () => [],
    vetEgress: async () => ({ ok: true, addresses: ['93.184.216.34'] }),
    probe: async () => ({ success: true, output: 'GNU Wget 1.21.4 built on linux-gnu.', truncated: false }),
    ...over,
  };
}

const line = (command: string) => ParsedLine.parse(command);

/** Carries a planner's `ask` to the person, as the filesystem does. */
async function settle(verdict: GateVerdict, approval: ApprovalPolicy): Promise<Settled> {
  return verdict.kind === 'ask' ? verdict.answer(await approval.request(verdict.request)) : verdict;
}

/** Puts a "no" on the card for `command` this session, as the planner's prompt would. */
async function denyOnCard(command: string, fixture: Fixture): Promise<void> {
  const verdict = await decide(line(command), site('planner', fixture.approval));
  expect(verdict.kind).toBe('ask');
  expect(await settle(verdict, fixture.approval)).toMatchObject({ kind: 'refuse' });
}

const sealable = { canSeal: async () => true };

describe('commandGate: the planner', () => {
  it('runs a read-only command natively, without the network, and asks nobody', async () => {
    const { approval, asked } = approvals();
    expect(await decide(line('git status'), site('planner', approval))).toEqual({ kind: 'native', network: false, command: 'git status' });
    expect(asked).toEqual([]);
  });

  it('asks about a command outside the read-only set, which keeps the network once approved (ADR-0011 B3)', async () => {
    const { approval } = approvals({ yes: ['npm test'] });
    const verdict = await decide(line('npm test'), site('planner', approval));
    expect(verdict).toMatchObject({ kind: 'ask', request: { kind: 'shell_command', subject: 'npm test' } });
    expect(await settle(verdict, approval)).toEqual({ kind: 'native', network: true, command: 'npm test' });
  });

  it('says what to do instead when the card says no, with the sed hint where it helps', async () => {
    const { approval } = approvals();
    const denied = await settle(await decide(line('npm test'), site('planner', approval)), approval);
    expect(denied).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/^Command not approved: npm test\nIt is outside the auto-allowed read-only set/) });
    expect(denied).not.toMatchObject({ reason: expect.stringContaining('sed -n') });

    const sed = await settle(await decide(line("sed 's/a/b/' a.md"), site('planner', approval)), approval);
    expect(sed).toMatchObject({ kind: 'refuse', reason: expect.stringContaining(`"sed -n '10,40p' FILE" run without approval`) });
  });

  it('asks once for a path outside the workspace, approving the path and not the network', async () => {
    const { approval } = approvals({ yes: [OUTSIDE] });
    const verdict = await decide(line(`cat ${OUTSIDE}`), site('planner', approval));
    expect(verdict).toMatchObject({ kind: 'ask', request: { kind: 'external_path', subject: OUTSIDE, scope: grantScopeFor(OUTSIDE, 'file') } });
    expect(await settle(verdict, approval)).toEqual({ kind: 'native', network: false, command: `cat ${OUTSIDE}` });

    const refused = await settle(await decide(line(`cd .. ; cat ${OUTSIDE}`), site('planner', approvals().approval)), approvals().approval);
    expect(refused).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/^Access denied: .*outside the workspace root/) });
  });

  describe('what the envelope refuses without asking anyone (ADR-0036 S2, S6)', () => {
    it('runs sealed where the host can seal it', async () => {
      const { approval, asked } = approvals();
      expect(await decide(line('rm -rf build'), site('planner', approval, sealable))).toEqual({ kind: 'sealed', why: 'refused', command: 'rm -rf build' });
      expect(asked).toEqual([]);
    });

    it('stays a refusal where it cannot', async () => {
      const { approval } = approvals();
      expect(await decide(line('rm -rf build'), site('planner', approval))).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/^Command refused: /) });
    });

    it("runs the approval mode's refusal sealed, and elsewhere hands it in to be recorded", async () => {
      const { approval, asked } = approvals({ mode: 'deny' });
      expect(await decide(line('npm test'), site('planner', approval, sealable))).toEqual({ kind: 'sealed', why: 'refused', command: 'npm test' });
      const unsealed = await decide(line('npm test'), site('planner', approval));
      expect(unsealed.kind).toBe('ask');
      expect(await settle(unsealed, approval)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/^Command not approved: npm test/) });
      expect(asked).toEqual([]);
    });

    it('refuses a path the shell reads by rules confinement cannot follow, or runs it sealed', async () => {
      const { approval } = approvals();
      const unfollowable = { hostPath: (spelled: string) => (spelled.startsWith('/proc/') ? undefined : spelled) };
      const command = 'cat /proc/registry/x';
      expect(await decide(line(command), site('planner', approval, unfollowable))).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('Git Bash reads "/proc/registry/x" by rules this check cannot follow') });
      expect(await decide(line(command), site('planner', approval, { ...unfollowable, ...sealable }))).toEqual({ kind: 'sealed', why: 'refused', command });
    });
  });

  describe('a sealed run asked for (ADR-0036 S2)', () => {
    it('runs sealed, and is refused where nothing can seal it', async () => {
      const { approval } = approvals();
      expect(await decide(line('npm test'), site('planner', approval, { ...sealable, sealed: true }))).toEqual({ kind: 'sealed', why: 'asked', command: 'npm test' });
      expect(await decide(line('git status'), site('planner', approval, { sealed: true }))).toMatchObject({
        kind: 'refuse', reason: expect.stringMatching(/^Command refused: this machine has no sandbox to run a command sealed in\./),
      });
    });
  });

  describe("what the person said no to holds for a sealed run (ADR-0036 S3)", () => {
    it('an allowlist exclusion naming the command', async () => {
      const { approval } = approvals({ preApproved: ['!rm *'] });
      expect(await decide(line('rm -rf build'), site('planner', approval, sealable))).toMatchObject({
        kind: 'refuse', reason: 'Command refused: the planner allowlist excludes it ("!rm *"), and an exclusion holds for a sealed run too.',
      });
    });

    it('an allowlist exclusion naming a path it touches', async () => {
      const { approval } = approvals({ preApproved: [`!${grantScopeFor(OUTSIDE, 'file')}`] });
      expect(await decide(line(`cat ${OUTSIDE}`), site('planner', approval, { ...sealable, sealed: true }))).toMatchObject({
        kind: 'refuse', reason: `Command refused: the planner allowlist excludes "${OUTSIDE}", and an exclusion holds for a sealed run too.`,
      });
    });

    it('a denial on the card, of the command or of one a wrapper carries', async () => {
      const fixture = approvals();
      await denyOnCard('npm test', fixture);
      expect(await decide(line('npm test'), site('planner', fixture.approval, { ...sealable, sealed: true }))).toMatchObject({
        kind: 'refuse', reason: expect.stringContaining('The user denied it this session, and a denial holds for a sealed run too.'),
      });
      expect(await decide(line('for i in 1 2; do npm test; done'), site('planner', fixture.approval, sealable))).toMatchObject({
        kind: 'refuse', reason: expect.stringContaining('The user denied "npm test" this session'),
      });
    });
  });

  describe('a web command', () => {
    it('is refused when it would send a secret, before anyone is asked or any DNS', async () => {
      const { approval, asked } = approvals();
      const vetEgress = vi.fn(async (): Promise<EgressCheck> => ({ ok: true, addresses: ['93.184.216.34'] }));
      const verdict = await decide(line('curl -H HeldSecret123 https://example.com/'), site('planner', approval, { vetEgress, outboundSecrets: () => ['HeldSecret123'] }));
      expect(verdict).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('secret') });
      expect(verdict).not.toMatchObject({ reason: expect.stringContaining('HeldSecret123') });
      expect(vetEgress).not.toHaveBeenCalled();
      expect(asked).toEqual([]);
    });

    it('is refused for a host the egress check blocks', async () => {
      const { approval } = approvals();
      const vetEgress = async (): Promise<EgressCheck> => ({ ok: false, reason: 'link-local address 169.254.169.254' });
      expect(await decide(line('curl http://169.254.169.254/'), site('planner', approval, { vetEgress }))).toMatchObject({
        kind: 'refuse', reason: expect.stringMatching(/^Command refused: Blocked host: link-local address 169\.254\.169\.254\./),
      });
    });

    it('runs approved with its curl pinned to the vetted address, and the network', async () => {
      const { approval } = approvals({ yes: 'all' });
      const verdict = await settle(await decide(line('curl https://example.com/'), site('planner', approval)), approval);
      expect(verdict).toMatchObject({ kind: 'native', network: true, command: expect.stringContaining('93.184.216.34') });
    });

    it('runs wget only once a probe shows GNU Wget 1.x', async () => {
      const { approval } = approvals({ yes: 'all' });
      const probe = vi.fn(async (): Promise<ToolOutcome> => ({ success: true, output: 'GNU Wget 1.21.4', truncated: false }));
      expect(await settle(await decide(line('wget --spider --max-redirect=0 https://example.com/'), site('planner', approval, { probe })), approval)).toMatchObject({ kind: 'native', network: true });
      expect(probe).toHaveBeenCalledOnce();

      const wget2 = async (): Promise<ToolOutcome> => ({ success: true, output: 'GNU Wget2 2.1.0', truncated: false });
      expect(await settle(await decide(line('wget --spider --max-redirect=0 https://example.com/'), site('planner', approval, { probe: wget2 })), approval)).toMatchObject({
        kind: 'refuse', reason: expect.stringContaining('wget2'),
      });
    });
  });
});

describe("commandGate: a read-only task (ADR-0046)", () => {
  it('never asks anyone', async () => {
    const { approval, asked } = approvals({ yes: ['npm test'] });
    const request = vi.spyOn(approval, 'request');
    for (const command of ['npm test', 'rm -rf build', `cat ${OUTSIDE}`, 'curl https://example.com/']) {
      for (const over of [{}, sealable]) expect((await decide(line(command), site('task', approval, over))).kind).not.toBe('ask');
    }
    expect(request).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('runs what would ask sealed, or refuses it where nothing can seal it', async () => {
    const { approval } = approvals();
    expect(await decide(line('npm test'), site('task', approval, sealable))).toEqual({ kind: 'sealed', why: 'refused', command: 'npm test' });
    expect(await decide(line('npm test'), site('task', approval))).toMatchObject({
      kind: 'refuse', reason: 'Command not run: npm test\nA read-only task asks nobody, so this command could only run sealed, and this machine has no sandbox to seal it in. Continue without it, and say in your report if what it would have shown matters.',
    });
    expect(await decide(line('rm -rf build'), site('task', approval))).toMatchObject({
      kind: 'refuse', reason: expect.stringMatching(/^Command refused: .*\nA read-only task asks nobody, so this command could only run sealed/s),
    });
  });

  it("keeps the allowlist's standing grants, with their network, but not a grant given on the planner's card", async () => {
    const { approval } = approvals({ preApproved: ['gh issue list'], yes: ['npm test'] });
    expect(await decide(line('gh issue list'), site('task', approval, sealable))).toEqual({ kind: 'native', network: true, command: 'gh issue list' });
    await settle(await decide(line('npm test'), site('planner', approval)), approval);
    expect(await decide(line('npm test'), site('task', approval, sealable))).toEqual({ kind: 'sealed', why: 'refused', command: 'npm test' });
  });

  it("names the person's refusal that stood", async () => {
    const fixture = approvals({ preApproved: [`!${grantScopeFor(OUTSIDE, 'file')}`] });
    await denyOnCard('npm test', fixture);
    expect(await decide(line('npm test'), site('task', fixture.approval))).toMatchObject({ reason: expect.stringContaining('\nThe user denied it this session. Continue without it') });
    expect(await decide(line(`cat ${OUTSIDE}`), site('task', fixture.approval))).toMatchObject({ reason: expect.stringContaining('\nThe allowlist excludes it. Continue without it') });
    // A refusal that stood is not run sealed instead (ADR-0036 S3).
    expect(await decide(line('npm test'), site('task', fixture.approval, sealable))).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('\nThe user denied it this session.') });
  });

  it('runs every command sealed after its first sealed run, the read-only tier and the allowlist included', async () => {
    const { approval } = approvals({ preApproved: ['gh issue list'] });
    for (const command of ['git status', 'gh issue list', 'npm test']) {
      expect(await decide(line(command), site('task', approval, { ...sealable, after: true }))).toEqual({ kind: 'sealed', why: 'after', command });
    }
  });

  it('refuses everything once its shell is stopped', async () => {
    const { approval } = approvals();
    expect(await decide(line('git status'), site('task', approval, { ...sealable, stopped: 'a repository could not be removed' }))).toEqual({
      kind: 'refuse', reason: 'Command not run: a repository could not be removed.\nContinue without it, and say in your report if what it would have shown matters.',
    });
  });
});

describe('commandGate: a research subagent (ADR-0008 T6, ADR-0036 S5)', () => {
  it('runs the read-only tier natively, without the network', async () => {
    const { approval } = approvals();
    expect(await decide(line('git status'), site('subagent', approval))).toEqual({ kind: 'native', network: false, command: 'git status' });
  });

  it('never asks, and keeps no grant: not the allowlist, not the card', async () => {
    const { approval, asked } = approvals({ preApproved: ['gh issue list'], yes: ['npm test'] });
    await settle(await decide(line('npm test'), site('planner', approval)), approval);
    asked.length = 0;
    const request = vi.spyOn(approval, 'request');
    for (const command of ['gh issue list', 'npm test']) {
      expect(await decide(line(command), site('subagent', approval))).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('research agents run in the background where nothing can be approved') });
      expect(await decide(line(command), site('subagent', approval, sealable))).toEqual({ kind: 'sealed', why: 'asked', command });
    }
    expect(request).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('refuses a path outside the workspace, or reads it sealed', async () => {
    const { approval } = approvals();
    expect(await decide(line(`cat ${OUTSIDE}`), site('subagent', approval))).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/^Path ".*" is outside the workspace\. Research agents are confined/) });
    expect(await decide(line(`cat ${OUTSIDE}`), site('subagent', approval, sealable))).toEqual({ kind: 'sealed', why: 'asked', command: `cat ${OUTSIDE}` });
  });

  it("refuses what the classifier refuses where nothing can seal, and holds the person's refusals sealed (S3)", async () => {
    const fixture = approvals({ preApproved: ['!rm *'] });
    expect(await decide(line('rm -rf build'), site('subagent', fixture.approval))).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/^Command refused: /) });
    expect(await decide(line('rm -rf build'), site('subagent', fixture.approval, sealable))).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('an exclusion holds for a sealed run too') });
    await denyOnCard('npm test', fixture);
    expect(await decide(line('npm test'), site('subagent', fixture.approval, sealable))).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('a denial holds for a sealed run too') });
  });
});

/**
 * What the `subagent` site decides for each command, under a session whose
 * card holds a standing grant (`gh issue list`), two exclusions (`!rm *`,
 * `!npm run *`) and a "no" for `npm test`. These are the decisions a research
 * subagent has always had, from before it shared the gate with the planner and
 * tasks: a table pinned so that moving a site's rules cannot widen one. A sandbox that seals turns what would ask, or be
 * refused, into a sealed run — except what the person said no to (S3); one
 * that cannot, refuses it with what to report instead (S6). No grant is kept
 * at this site, and no command keeps a network (ADR-0011 B3).
 */
describe('commandGate: a research subagent, command by command (ADR-0008 T6)', () => {
  const native = (command: string) => ({ kind: 'native', network: false, command });
  const sealed = (command: string) => ({ kind: 'sealed', why: 'asked', command });
  const refuses = (text: string) => ({ kind: 'refuse', reason: expect.stringContaining(text) });
  const OUTSIDE_TEXT = 'is outside the workspace. Research agents are confined to the workspace root';
  const UNAPPROVED = 'needs user approval, and research agents run in the background where nothing can be approved';
  const NO_SANDBOX = 'this machine has no sandbox to run a command sealed in';
  const EXCLUDED = 'an exclusion holds for a sealed run too';
  const DENIED = 'a denial holds for a sealed run too';

  /** What each command meets: on a host that seals, on one that cannot, and when the agent asked for a sealed run. */
  const TABLE: Array<{ command: string; sealable: object; unsealable: object; asked: object }> = [
    { command: 'git status', sealable: native('git status'), unsealable: native('git status'), asked: sealed('git status') },
    { command: 'cat a.md', sealable: native('cat a.md'), unsealable: native('cat a.md'), asked: sealed('cat a.md') },
    { command: 'git log --oneline | head -5', sealable: native('git log --oneline | head -5'), unsealable: native('git log --oneline | head -5'), asked: sealed('git log --oneline | head -5') },
    { command: `cat ${OUTSIDE}`, sealable: sealed(`cat ${OUTSIDE}`), unsealable: refuses(OUTSIDE_TEXT), asked: sealed(`cat ${OUTSIDE}`) },
    { command: 'ls ..', sealable: sealed('ls ..'), unsealable: refuses(OUTSIDE_TEXT), asked: sealed('ls ..') },
    { command: 'cd .. && cat a.md', sealable: sealed('cd .. && cat a.md'), unsealable: refuses(OUTSIDE_TEXT), asked: sealed('cd .. && cat a.md') },
    { command: 'cat /dev/null', sealable: sealed('cat /dev/null'), unsealable: refuses(OUTSIDE_TEXT), asked: sealed('cat /dev/null') },
    // A "no" on the card and an exclusion refuse, sealed or not (S3).
    { command: 'npm test', sealable: refuses(DENIED), unsealable: refuses(UNAPPROVED), asked: refuses(DENIED) },
    { command: 'for i in 1 2; do npm test; done', sealable: refuses(DENIED), unsealable: refuses('Command refused: "for" is a shell keyword'), asked: refuses(DENIED) },
    { command: 'npm run lint', sealable: refuses(EXCLUDED), unsealable: refuses(UNAPPROVED), asked: refuses(EXCLUDED) },
    { command: 'rm -rf build', sealable: refuses(EXCLUDED), unsealable: refuses('Command refused: "rm" modifies state'), asked: refuses(EXCLUDED) },
    // What the classifier refuses runs sealed where it can (S2), and is the refusal elsewhere (S6).
    { command: 'echo draft > notes.txt', sealable: sealed('echo draft > notes.txt'), unsealable: refuses('Command refused: "> notes.txt" writes to a file'), asked: sealed('echo draft > notes.txt') },
    { command: "sed -i 's/a/b/' a.md", sealable: sealed("sed -i 's/a/b/' a.md"), unsealable: refuses('Command refused: "sed -i" edits files in place'), asked: sealed("sed -i 's/a/b/' a.md") },
    // A standing grant is the planner's: the subagent has none, so it is what would ask.
    { command: 'gh issue list', sealable: sealed('gh issue list'), unsealable: refuses(UNAPPROVED), asked: sealed('gh issue list') },
    { command: 'curl https://example.com/', sealable: sealed("curl -q --noproxy '*' https://example.com/"), unsealable: refuses(UNAPPROVED), asked: sealed("curl -q --noproxy '*' https://example.com/") },
  ];

  async function fixture() {
    const fixture = approvals({ preApproved: ['gh issue list', '!rm *', '!npm run *'] });
    await denyOnCard('npm test', fixture);
    return fixture;
  }

  it.each(TABLE)('$command', async ({ command, sealable: whereSealed, unsealable }) => {
    const { approval, asked } = await fixture();
    const before = asked.length;
    expect(await decide(line(command), site('subagent', approval, { canSeal: async () => true }))).toMatchObject(whereSealed);
    expect(await decide(line(command), site('subagent', approval))).toMatchObject(unsealable);
    expect(asked.length).toBe(before);
  });

  it.each(TABLE)('$command, asked to run sealed', async ({ command, asked: whenAsked }) => {
    const { approval, asked } = await fixture();
    const before = asked.length;
    expect(await decide(line(command), site('subagent', approval, { canSeal: async () => true, sealed: true }))).toMatchObject(whenAsked);
    expect(await decide(line(command), site('subagent', approval, { sealed: true }))).toMatchObject(refuses(NO_SANDBOX));
    expect(asked.length).toBe(before);
  });
});
