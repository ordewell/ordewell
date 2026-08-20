import { describe, it, expect, vi } from 'vitest';
import { makeSession } from './sessionTestKit';
import type { SkillsService, SkillInfo } from '../SkillsService';

function skill(name: string, content: string): SkillInfo {
  return { name, description: name, metadata: { name, description: name }, content, path: `/skills/${name}/SKILL.md`, source: 'global' };
}

function fakeSkillsService(map: Record<string, string>): Pick<SkillsService, 'findSkill'> {
  return {
    findSkill: (n: string) => (map[n] ? skill(n, map[n]) : undefined),
  };
}

describe('skill invocation interception', () => {
  it('startPlanning substitutes /grilling with skill content before it reaches the AI service', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'Question?', researchLog: [] });
    const session = makeSession({
      skillsService: fakeSkillsService({ grilling: '# Grilling\n\nBody.' }),
      aiService: {
        startConversation,
        hasActiveConversation: () => false,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('/grilling', ['claude-code']);

    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(startConversation.mock.calls[0][0].goal).toBe('# Grilling\n\nBody.');
  });

  it('continueConversation substitutes /to-spec with skill content before it reaches the AI service', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] });
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      skillsService: fakeSkillsService({ 'to-spec': '# To Spec\n\nBody.' }),
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        conversationMatchesConfig: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('some goal', ['claude-code']);
    await session.continueConversation('/to-spec');

    expect(continueConversation).toHaveBeenCalledTimes(1);
    expect(continueConversation.mock.calls[0][0]).toContain('# To Spec\n\nBody.');
    expect(continueConversation.mock.calls[0][0]).not.toContain('/to-spec');
  });

  it('leaves a plain message with no slash prefix unchanged', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] });
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      skillsService: fakeSkillsService({ grilling: '# Grilling' }),
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        conversationMatchesConfig: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('just a normal question');

    expect(continueConversation.mock.calls[0][0]).toContain('just a normal question');
  });

  it('substitutes a skill invocation without a matching skill with an unknown-skill notice', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] });
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      skillsService: fakeSkillsService({ grilling: '# Grilling' }),
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        conversationMatchesConfig: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('/nope');

    expect(continueConversation.mock.calls[0][0]).toContain('Unknown skill');
    expect(continueConversation.mock.calls[0][0]).not.toContain('/nope');
  });
});

describe('skill invocation with a default SkillsService', () => {
  it('plan still works when no skillsService is injected and no skill exists on disk', async () => {
    const startConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] });
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation,
        hasActiveConversation: () => true,
        conversationMatchesConfig: () => true,
        reset: vi.fn(),
      },
    });

    await session.startPlanning('plain goal', ['claude-code']);
    await session.continueConversation('a follow-up');

    expect(continueConversation).toHaveBeenCalledTimes(1);
    expect(continueConversation.mock.calls[0][0]).toContain('a follow-up');
  });
});
