/** A name a skill can have, lower-cased: the one pattern for a `/name` token and for a skill folder. */
export const SKILL_NAME_PATTERN = '[a-z0-9][a-z0-9_-]*';

/**
 * A `/skill-name` token anywhere in a message: whitespace (or string start)
 * before it, a skill name in any case, optional trailing punctuation that
 * isn't part of the name, then whitespace (or string end). The punctuation
 * group is what lets "/grilling," name "grilling".
 */
const SKILL_TOKEN = new RegExp(`(^|\\s)\\/(${SKILL_NAME_PATTERN})([,.!?;:]*)(?=\\s|$)`, 'gi');

/** Where a skill name is invoked: `start` is its `/`, `end` is just past the name, before any punctuation. */
export interface SkillToken {
  name: string;
  start: number;
  end: number;
}

/**
 * The first `/name` token for each name in `text`, names lower-cased. Only
 * the first counts because a skill loads once per message however often it is
 * named, so a later repeat is plain text.
 */
export function skillTokens(text: string): SkillToken[] {
  const tokens: SkillToken[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const name = match[2].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const start = match.index + match[1].length;
    tokens.push({ name, start, end: start + 1 + match[2].length });
  }
  return tokens;
}

/** The tokens in a sent message that loaded one of `loaded` — what a surface highlights in the user's bubble. */
export function loadedSkillTokens(text: string, loaded: readonly string[]): SkillToken[] {
  return skillTokens(text).filter((t) => loaded.includes(t.name));
}
