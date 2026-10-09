import { describe, it, expect, vi } from 'vitest';
import { makeSession, saves } from './sessionTestKit';
import type { SkillsService, SkillInfo } from '../SkillsService';
import type { SessionMessage } from '../SessionMessage';
import type { ConversationMessage, LegacyPlanState, SkillLoad } from '../../models/Task';
import { plannerMessage, plannerTranscript, resolveSkillInvocation } from '../skillInvocation';
import type { ConversationRequest } from '../AiService';

function skill(name: string, content: string, path = `/skills/${name}/SKILL.md`): SkillInfo {
  return { name, description: name, metadata: { name, description: name }, content, path, source: 'global', appliesTo: 'planner', modelInvocable: true, userInvocable: true };
}

/** Backed by a live map, so a test can edit or delete a SKILL.md after it was loaded. */
function fakeSkillsService(map: Record<string, string>): Pick<SkillsService, 'findSkill'> {
  return {
    findSkill: (n: string) => (map[n] ? skill(n, map[n]) : undefined),
  };
}

const reply = { kind: 'message', text: 'ok', researchLog: [] };

function liveAi() {
  return {
    startConversation: vi.fn().mockResolvedValue(reply),
    continueConversation: vi.fn().mockResolvedValue(reply),
    hasActiveConversation: () => true,
    conversationMatchesConfig: () => true,
    reset: vi.fn(),
  };
}

function turnStarts(broadcast: ReturnType<typeof vi.fn>): Extract<SessionMessage, { type: 'planner_turn_started' }>[] {
  return broadcast.mock.calls
    .map(([m]) => m as SessionMessage)
    .filter((m): m is Extract<SessionMessage, { type: 'planner_turn_started' }> => m.type === 'planner_turn_started');
}

describe('resolveSkillInvocation', () => {
  const skills = fakeSkillsService({ grilling: 'GRILL', 'to-spec': 'SPEC' });
  const names = (text: string) => resolveSkillInvocation(text, skills, '/home/me').skills.map((s) => s.name);

  it('keeps the text verbatim and returns a snapshot of each skill it names', () => {
    const resolved = resolveSkillInvocation('/grilling this idea', skills, '/home/me');
    expect(resolved.text).toBe('/grilling this idea');
    expect(resolved.skills).toEqual([{ invokedBy: 'user', name: 'grilling', source: 'global', path: '/skills/grilling/SKILL.md', content: 'GRILL' }]);
  });

  it('loads every distinct skill named, in order, and a repeat only once', () => {
    expect(names('/grilling this and then /to-spec it, /grilling again')).toEqual(['grilling', 'to-spec']);
  });

  it('matches a token with trailing punctuation and ignores case', () => {
    expect(names('use /Grilling, please')).toEqual(['grilling']);
  });

  it('treats a token naming no skill as plain text, a bare one included', () => {
    expect(resolveSkillInvocation('/nope', skills)).toEqual({ text: '/nope', skills: [] });
    expect(names('check out /nope for details')).toEqual([]);
    expect(names('a path like src/grilling is not a token')).toEqual([]);
  });

  it('abbreviates a SKILL.md under the home directory', () => {
    const home = fakeSkillsService({});
    home.findSkill = (n) => skill(n, 'BODY', '/home/me/.ordewell/skills/grilling/SKILL.md');
    expect(resolveSkillInvocation('/grilling', home, '/home/me').skills[0].path).toBe('~/.ordewell/skills/grilling/SKILL.md');
    expect(resolveSkillInvocation('/grilling', home, '/home/m').skills[0].path).toBe('/home/me/.ordewell/skills/grilling/SKILL.md');
  });
});

describe('plannerTranscript', () => {
  const load = (name: string, content: string): SkillLoad => ({ invokedBy: 'user', name, source: 'global', path: `~/s/${name}`, content });
  const entry = (role: ConversationMessage['role'], content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({ role, content, timestamp: 't', ...extra });

  it('folds the skills loaded after a message into it, as a live send composes it', () => {
    const grill = load('grilling', 'GRILL');
    const replayed = plannerTranscript([
      entry('user', '/grilling my goal'),
      entry('user', '/grilling skill loaded', { kind: 'skill_load', skill: grill }),
      entry('assistant', 'question?'),
      entry('user', 'an answer'),
    ]);
    expect(replayed.map((m) => m.content)).toEqual([plannerMessage('/grilling my goal', [grill]), 'question?', 'an answer']);
  });

  it('replays a session saved before skill loads existed as it is', () => {
    const legacy = [entry('user', '# Grilling expanded body'), entry('assistant', 'question?')];
    expect(plannerTranscript(legacy)).toEqual(legacy);
  });
});

describe('skill invocation in a session', () => {
  it('stores and shows the goal verbatim, with a skill-load entry holding the snapshot', async () => {
    const ai = liveAi();
    const broadcast = vi.fn();
    const session = makeSession({ broadcast, skillsService: fakeSkillsService({ grilling: '# Grilling\n\nBody.' }), aiService: ai });

    await session.startPlanning('/grilling design the cache', ['claude-code']);

    expect(session.currentGoal).toBe('/grilling design the cache');
    expect(session.planState?.conversationHistory?.map(({ role, kind, content, skill: s }) => ({ role, kind, content, skill: s }))).toEqual([
      { role: 'user', kind: undefined, content: '/grilling design the cache', skill: undefined },
      {
        role: 'user', kind: 'skill_load', content: '/grilling skill loaded',
        skill: { invokedBy: 'user', name: 'grilling', source: 'global', path: '/skills/grilling/SKILL.md', content: '# Grilling\n\nBody.' },
      },
      expect.objectContaining({ role: 'assistant', content: 'ok' }),
    ]);
    expect(turnStarts(broadcast)).toEqual([expect.objectContaining({
      prompt: '/grilling design the cache',
      skills: [{ invokedBy: 'user', name: 'grilling', source: 'global', path: '/skills/grilling/SKILL.md' }],
    })]);
    const request = ai.startConversation.mock.calls[0][0] as ConversationRequest;
    expect(request.goal).toContain('# Grilling\n\nBody.');
    expect(request.goal).toContain('/grilling design the cache');
  });

  it('titles the saved session with the verbatim goal', async () => {
    const session = makeSession({ skillsService: fakeSkillsService({ grilling: 'GRILL' }), aiService: liveAi() });

    await session.startPlanning('/grilling design the cache', ['claude-code']);

    const goals = saves(session).mock.calls.map((call) => call[1]);
    expect(goals.length).toBeGreaterThan(0);
    expect(new Set(goals)).toEqual(new Set(['/grilling design the cache']));
  });

  it('sends a follow-up verbatim with the skill bodies, recording each skill once', async () => {
    const ai = liveAi();
    const broadcast = vi.fn();
    const session = makeSession({ broadcast, skillsService: fakeSkillsService({ grilling: 'GRILL', 'to-spec': 'SPEC' }), aiService: ai });
    await session.startPlanning('goal', ['claude-code']);

    await session.continueConversation('/grilling this, then /to-spec it and /grilling again');

    const sent = ai.continueConversation.mock.calls[0][0] as string;
    expect(sent).toContain('GRILL');
    expect(sent).toContain('SPEC');
    expect(sent.endsWith('/grilling this, then /to-spec it and /grilling again')).toBe(true);
    const history = session.planState?.conversationHistory ?? [];
    expect(history.filter((m) => m.kind === 'skill_load').map((m) => m.skill?.name)).toEqual(['grilling', 'to-spec']);
    expect(history.filter((m) => m.role === 'user' && !m.kind).map((m) => m.content)).toEqual(['goal', '/grilling this, then /to-spec it and /grilling again']);
    expect(turnStarts(broadcast)[1].prompt).toBe('/grilling this, then /to-spec it and /grilling again');
  });

  it('passes a message that is only an unknown /name through verbatim, with no notice and no load', async () => {
    const ai = liveAi();
    const broadcast = vi.fn();
    const session = makeSession({ broadcast, skillsService: fakeSkillsService({ grilling: 'GRILL' }), aiService: ai });
    await session.startPlanning('goal', ['claude-code']);

    await session.continueConversation('/nope');

    const sent = ai.continueConversation.mock.calls[0][0] as string;
    expect(sent.endsWith('\n\n/nope')).toBe(true);
    expect(sent).not.toContain('Unknown skill');
    expect(session.planState?.conversationHistory?.some((m) => m.kind === 'skill_load')).toBe(false);
    expect(turnStarts(broadcast)[1]).not.toHaveProperty('skills');
  });

  it('opens a bare unknown goal verbatim', async () => {
    const ai = liveAi();
    const session = makeSession({ skillsService: fakeSkillsService({}), aiService: ai });

    await session.startPlanning('/nope', ['claude-code']);

    expect((ai.startConversation.mock.calls[0][0] as ConversationRequest).goal).toBe('/nope');
  });

  it.each([
    ['edited', { grilling: 'GRILL v2' }],
    ['deleted', {}],
  ])('replays the snapshot the planner first saw after the SKILL.md was %s', async (_change, after: Record<string, string>) => {
    const files: Record<string, string> = { grilling: 'GRILL v1' };
    const skills: Pick<SkillsService, 'findSkill'> = { findSkill: (n) => (files[n] ? skill(n, files[n]) : undefined) };
    const first = makeSession({ skillsService: skills, aiService: liveAi() });
    await first.startPlanning('goal', ['claude-code']);
    await first.continueConversation('/grilling the cache');
    const saved = structuredClone(first.planState) as LegacyPlanState;

    delete files.grilling;
    Object.assign(files, after);
    const ai = { ...liveAi(), hasActiveConversation: () => false };
    const reloaded = makeSession({ skillsService: skills, aiService: ai });
    reloaded.loadPlan(saved, 'goal', process.cwd(), { persist: false });
    await reloaded.continueConversation('next');

    const request = ai.startConversation.mock.calls[0][0] as ConversationRequest;
    const replayed = request.priorHistory?.map((m) => m.content) ?? [];
    expect(replayed).toContain(plannerMessage('/grilling the cache', [{ invokedBy: 'user', name: 'grilling', source: 'global', path: '/skills/grilling/SKILL.md', content: 'GRILL v1' }]));
    expect(replayed.join('\n')).not.toContain('GRILL v2');
    expect(replayed.some((m) => m === '/grilling skill loaded')).toBe(false);
  });

  it('replays the opening skill into the resumed planner goal', async () => {
    const files: Record<string, string> = { grilling: 'GRILL v1' };
    const skills: Pick<SkillsService, 'findSkill'> = { findSkill: (n) => (files[n] ? skill(n, files[n]) : undefined) };
    const first = makeSession({ skillsService: skills, aiService: liveAi() });
    await first.startPlanning('/grilling the cache', ['claude-code']);
    const saved = structuredClone(first.planState) as LegacyPlanState;

    files.grilling = 'GRILL v2';
    const ai = { ...liveAi(), hasActiveConversation: () => false };
    const reloaded = makeSession({ skillsService: skills, aiService: ai });
    reloaded.loadPlan(saved, '/grilling the cache', process.cwd(), { persist: false });
    await reloaded.continueConversation('next');

    const goal = (ai.startConversation.mock.calls[0][0] as ConversationRequest).goal;
    expect(goal).toContain('GRILL v1');
    expect(goal).not.toContain('GRILL v2');
  });

  it('rewinds to the verbatim message, cutting its skill loads with it', async () => {
    const session = makeSession({ skillsService: fakeSkillsService({ grilling: 'GRILL' }), aiService: liveAi() });
    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('/grilling the cache');

    const targets = session.rewindTargets();
    expect(targets.map((t) => t.content)).toEqual(['/grilling the cache']);
    const { rewoundMessage } = session.rewindConversation(targets[0].index);
    expect(rewoundMessage).toBe('/grilling the cache');
  });

  it('plans when no skillsService is injected and no skill exists on disk', async () => {
    const ai = liveAi();
    const session = makeSession({ aiService: ai });

    await session.startPlanning('plain goal', ['claude-code']);
    await session.continueConversation('a follow-up');

    expect(ai.continueConversation).toHaveBeenCalledTimes(1);
    expect(ai.continueConversation.mock.calls[0][0]).toContain('a follow-up');
  });
});
