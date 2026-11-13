import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPolicy } from '../ApprovalPolicy';
import { BaseFileSystem } from '../BaseFileSystem';
import { decide, type GateSite, type GateVerdict, type GateWho, type Settled } from '../commandGate';
import type { EgressCheck } from '../egressGuard';
import { grantScopeFor } from '../pathScope';
import { ParsedLine } from '../parsedLine';
import { nonPromptingFs } from '../ResearchSubagents';
import { researchLineShell, resolveResearchShell, type ShellLaunch } from '../researchShell';
import { PlannerShellSandbox, plannerShellProfile, sealedShellProfile, type PlannerSandboxAvailability } from '../sandbox/plannerSandbox';
import type { SandboxBackend, SandboxLaunch, SandboxProfile } from '../sandbox/SandboxBackend';
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

/** Hands back a launch that says whether it was sealed and with what network, so a run reads as a verdict. */
class RecordingBackend implements SandboxBackend {
  readonly name = 'recording';
  readonly profiles: SandboxProfile[] = [];
  async probe(): Promise<{ ok: true }> { return { ok: true }; }
  wrap(_invocation: unknown, profile: SandboxProfile): SandboxLaunch {
    this.profiles.push(profile);
    return { file: profile.limits ? '/sealed' : '/sandboxed', args: [String(this.profiles.length - 1)], env: {} };
  }
}

function available(backend: SandboxBackend): PlannerSandboxAvailability {
  return {
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'darwin', services: [] }, opts),
    sealed: { available: true, profile: (opts) => sealedShellProfile({ platform: 'darwin', reads: ['/usr'], masked: [], overlay: false }, opts) },
  };
}

type Outcome = { ran: string; sealed: boolean; network: boolean } | { refused: string };

class WorkspaceFileSystem extends BaseFileSystem {
  last?: Outcome;
  constructor(private readonly root: string, private readonly backend: RecordingBackend | null) {
    super(undefined, new PlannerShellSandbox(async () => (backend ? available(backend) : { available: false, notice: 'no sandbox in this test' })));
  }
  getWorkspaceRoot(): string { return this.root; }
  protected async readFileImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async listDirImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async execBashImpl(command: string, shell: ShellLaunch): Promise<ToolOutcome> {
    const profile = shell.file === null ? undefined : this.backend?.profiles[Number(shell.args[0])];
    this.last = { ran: command, sealed: shell.file === '/sealed', network: profile?.network ?? false };
    return { success: true, output: 'ran', truncated: false };
  }
}

describe("commandGate's subagent site decides as nonPromptingFs does (part 2 moves the wrapper onto it)", () => {
  let workspace: string;
  beforeEach(() => { workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-gate-'))); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  const COMMANDS = [
    'git status', 'cat a.md', `cat ${OUTSIDE}`, 'ls ..', 'cd .. && cat a.md', 'cat /dev/null', 'npm test', 'npm run lint',
    'rm -rf build', 'echo draft > notes.txt', 'for i in 1 2; do npm test; done', 'gh issue list', 'curl https://example.com/',
    "sed -i 's/a/b/' a.md", 'git log --oneline | head -5',
  ];

  it.each([
    { name: 'with a sandbox', sandbox: true },
    { name: 'without one', sandbox: false },
  ])('$name, across standing grants, exclusions and denials', async ({ sandbox }) => {
    const shell = resolveResearchShell();
    for (const sealed of [false, true]) {
      const fixture = approvals({ preApproved: ['gh issue list', '!rm *', '!npm run *'] });
      await denyOnCard('npm test', fixture);
      for (const command of COMMANDS) {
        const fs = new WorkspaceFileSystem(workspace, sandbox ? new RecordingBackend() : null);
        fs.setApproval(fixture.approval);
        const wrapped = await nonPromptingFs(fs).bash(command, undefined, sealed ? { sealed: true } : undefined);
        const before: Outcome = wrapped.output === 'ran' || wrapped.output.endsWith('\nran') ? fs.last! : { refused: wrapped.output };

        const verdict = await decide(ParsedLine.parse(command, researchLineShell(shell)), {
          ...site('subagent', fixture.approval),
          root: workspace,
          ...(shell.hostPath ? { hostPath: shell.hostPath } : {}),
          canSeal: () => fs.canSeal(),
          ...(sealed ? { sealed: true } : {}),
        });
        expect(verdict.kind).not.toBe('ask');
        const after: Outcome = verdict.kind === 'refuse' ? { refused: verdict.reason }
          : verdict.kind === 'sealed' ? { ran: verdict.command, sealed: true, network: false }
            : verdict.kind === 'native' ? { ran: verdict.command, sealed: false, network: verdict.network }
              : { refused: 'asked' };
        expect({ command, sealed, outcome: after }).toEqual({ command, sealed, outcome: before });
      }
      expect(fixture.asked).toEqual(['npm test']);
    }
  });
});
