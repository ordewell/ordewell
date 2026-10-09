import * as os from 'os';
import * as path from 'path';
import { skillTokens } from '../conversation/skillTokens';
import { isUserMessage, type ConversationMessage, type SkillLoad, type SkillLoadNotice } from '../models/Task';
import type { SkillsService } from './SkillsService';

/** A user's message as sent, and the skills its `/name` tokens load. */
export interface SkillInvocation {
  text: string;
  skills: SkillLoad[];
}

function homeAbbreviated(file: string, home: string): string {
  return home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/**
 * Resolve the `/skill-name` tokens in a message to snapshots of the skills they
 * name. Pure and exported so surfaces and verification can resolve without a
 * full Session. The text itself is never rewritten.
 *
 * Every distinct skill named loads, once, in the order first named. A token
 * naming no skill is plain text, wherever it stands — a whole message of
 * `/unknown` included: embedded in a sentence it is as likely to be incidental
 * text (a path, an example command) as a typo'd invocation.
 */
export function resolveSkillInvocation(
  text: string,
  skillsService: Pick<SkillsService, 'findSkill'>,
  home: string = os.homedir(),
): SkillInvocation {
  const skills = skillTokens(text).flatMap(({ name }): SkillLoad[] => {
    const skill = skillsService.findSkill(name);
    return skill
      ? [{ invokedBy: 'user', name, source: skill.source, path: homeAbbreviated(skill.path, home), content: skill.content }]
      : [];
  });
  return { text, skills };
}

export function skillLoadNotice({ invokedBy, name, source, path: file }: SkillLoad): SkillLoadNotice {
  return { invokedBy, name, source, path: file };
}

/** A skill-load entry's `content`: the line a reader of the bare transcript sees, never what the planner is sent. */
export function skillLoadLabel(skill: SkillLoad): string {
  return `/${skill.name} skill loaded`;
}

/**
 * What the planner receives for a user message: the bodies of the skills it
 * loaded, then the message as the user wrote it. The one composition for a
 * live send and for a replay of the transcript, so a resumed conversation
 * hands the planner what the live one did.
 */
export function plannerMessage(text: string, skills: readonly SkillLoad[]): string {
  if (skills.length === 0) return text;
  return [
    `The user invoked ${skills.map((s) => `/${s.name}`).join(', ')} in the message below. Follow ${skills.length === 1 ? 'this skill' : 'these skills'}:`,
    ...skills.map(skillBlock),
    text,
  ].join('\n\n');
}

function skillBlock(skill: SkillLoad): string {
  return `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`;
}

/**
 * The transcript as the planner is to see it on a replay: each user message
 * carries the skills loaded after it, composed by {@link plannerMessage}, and
 * the load entries themselves are folded away. Sessions saved before skill
 * loads existed hold the expanded text in the message and replay unchanged.
 */
export function plannerTranscript(history: readonly ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  const loadsOf = new Map<number, SkillLoad[]>();
  let owner = -1;
  for (const entry of history) {
    if (entry.kind === 'skill_load' && entry.skill) {
      const loads = loadsOf.get(owner);
      if (loads) loads.push(entry.skill);
      else out.push({ role: entry.role, content: skillBlock(entry.skill), timestamp: entry.timestamp });
      continue;
    }
    owner = isUserMessage(entry) ? out.length : -1;
    if (owner >= 0) loadsOf.set(owner, []);
    out.push(entry);
  }
  return out.map((entry, i) => {
    const loads = loadsOf.get(i);
    return loads && loads.length > 0 ? { ...entry, content: plannerMessage(entry.content, loads) } : entry;
  });
}
