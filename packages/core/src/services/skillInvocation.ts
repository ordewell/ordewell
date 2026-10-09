import * as os from 'os';
import { skillTokens } from '../conversation/skillTokens';
import { isUserMessage, type ConversationMessage, type SkillLoad } from '../models/Task';
import type { SkillInfo, SkillsService } from './SkillsService';

/** A user's message as sent, and the skills its `/name` tokens load. */
export interface SkillInvocation {
  text: string;
  skills: SkillLoad[];
}

/**
 * A path with the home directory written `~`, for a notice or listing. On
 * Windows the drive letter's case is not significant and the separators are
 * rendered `/`, so the same skill reads alike wherever the session reloads.
 */
export function abbreviateHome(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  const normal = (p: string): string => (win ? p.replace(/\\/g, '/') : p);
  const shown = normal(file);
  const prefix = normal(home).replace(/\/+$/, '');
  if (!prefix) return shown;
  const inHome = win ? shown.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) : shown.startsWith(`${prefix}/`);
  return inHome ? `~${shown.slice(prefix.length)}` : shown;
}

export function modelInvocablePlannerSkills(skills: readonly SkillInfo[]): SkillInfo[] {
  return skills.filter((skill) => skill.appliesTo === 'planner' && skill.modelInvocable);
}

export function modelInvocableTaskSkills(skills: readonly SkillInfo[]): SkillInfo[] {
  return skills.filter((skill) => skill.appliesTo === 'task' && skill.modelInvocable);
}

export function snapshotSkill(skill: SkillInfo, invokedBy: SkillLoad['invokedBy'], home = os.homedir()): SkillLoad {
  return { invokedBy, name: skill.name, source: skill.source, path: abbreviateHome(skill.path, home), content: skill.content };
}

/** A task skill the user named: the planner is told to attach it, never given its body. */
function attachSkill(skill: SkillInfo, home: string): SkillLoad {
  return { ...snapshotSkill(skill, 'user', home), content: '', attaches: { description: skill.description } };
}

/**
 * Resolve the `/skill-name` tokens in a message to snapshots of the skills they
 * name. Pure and exported so surfaces can resolve without a full Session. The text itself is never rewritten.
 *
 * Every distinct skill named loads, once, in the order first named. A token
 * naming no skill is plain text, wherever it stands — a whole message of
 * `/unknown` included: embedded in a sentence it is as likely to be incidental
 * text (a path, an example command) as a typo'd invocation. So is one naming
 * a skill with `user-invocable: false`, which only the model may invoke.
 */
export function resolveSkillInvocation(
  text: string,
  skillsService: Pick<SkillsService, 'findSkill'>,
  home: string = os.homedir(),
): SkillInvocation {
  const skills = skillTokens(text).flatMap(({ name }): SkillLoad[] => {
    const skill = skillsService.findSkill(name);
    if (!skill?.userInvocable) return [];
    return [skill.appliesTo === 'task' ? attachSkill(skill, home) : snapshotSkill(skill, 'user', home)];
  });
  return { text, skills };
}

/** A skill-load entry's `content`: the line a reader of the bare transcript sees, never what the planner is sent. */
export function skillLoadLabel(skill: SkillLoad): string {
  if (skill.attaches) return `/${skill.name} will be attached to fitting tasks`;
  return skill.invokedBy === 'planner' ? `${skill.name} skill loaded by planner` : `/${skill.name} skill loaded`;
}

/**
 * What the planner receives for a user message: the bodies of the skills it
 * loaded, then the message as the user wrote it. The one composition for a
 * live send and for a replay of the transcript, so a resumed conversation
 * hands the planner what the live one did.
 */
export function plannerMessage(text: string, loads: readonly SkillLoad[]): string {
  if (loads.length === 0) return text;
  const skills = loads.filter((s) => !s.attaches);
  const attached = loads.filter((s) => s.attaches);
  return [
    ...(skills.length === 0 ? [] : [
      `The user invoked ${skills.map((s) => `/${s.name}`).join(', ')} in the message below. Follow ${skills.length === 1 ? 'this skill' : 'these skills'}:`,
      ...skills.map(skillBlock),
    ]),
    ...attached.map(attachDirective),
    text,
  ].join('\n\n');
}

const PLANNER_LOAD_PREAMBLE = '(skill loaded via load_skill)';

function attachDirective({ name, attaches }: SkillLoad): string {
  const description = attaches?.description.trim();
  return `The user asks to use task skill "${name}"${description ? ` (${description})` : ''}; attach it to the tasks it fits.`;
}

function skillBlock(skill: SkillLoad): string {
  if (skill.attaches) return attachDirective(skill);
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
      const loads = entry.skill.invokedBy === 'user' ? loadsOf.get(owner) : undefined;
      if (loads) loads.push(entry.skill);
      else {
        // Live, the body reached the planner as a tool result, not as its own
        // words; a transcript has no tool-result role, so it replays as context.
        out.push({ role: 'user', content: `${PLANNER_LOAD_PREAMBLE}\n\n${skillBlock(entry.skill)}`, timestamp: entry.timestamp });
        owner = -1;
      }
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
