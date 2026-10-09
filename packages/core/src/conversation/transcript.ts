import type { ResearchLogEntry, ResearchStep, SkillLoadNotice, SubagentLogEntry } from '../models/Task';
import type { SerializedConversationMessage } from '../services/SessionMessage';
import { isMeasured, usageLine, type PlannerUsage } from '../models/Usage';
import type { DisplayBlock } from './blocks';
import { planMarker, settledMessage, skillLoadBlock, skillLoadNotice, subagentBlock, toolFromStep, usageBlock, userMessage } from './records';
import type { ConversationView } from './reduce';

/** One top-level block before it has an id, and where it falls in time. */
interface Placed {
  at: string;
  /** Breaks a tie in `at`: a user's message, then the research it caused, then what the turn settled on. */
  rank: number;
  build: (nextId: () => string) => DisplayBlock;
}

const USER = 0;
const RESEARCH = 1;
const SETTLED = 2;

/** `loaded`: the skills the entries after a user's message say it loaded. */
function fromEntry(entry: SerializedConversationMessage, loaded: readonly SkillLoadNotice[] = []): Placed['build'] {
  if (entry.kind === 'plan_generated') return (id) => ({ type: 'plan', id: id(), text: '', ...planMarker(entry.content) });
  if (entry.kind === 'skill_load' && entry.skill) {
    const { skill } = entry;
    return (id) => skillLoadBlock(id(), skillLoadNotice(skill));
  }
  if (entry.role === 'user' && !entry.kind) return (id) => userMessage(id(), entry.content, loaded.map(skillLoadNotice));
  const role = entry.kind === 'system' || entry.kind === 'compaction' ? 'system' : entry.role === 'user' ? 'user' : 'planner';
  return (id) => settledMessage(id(), role, entry.content);
}

function loadsAfter(entries: readonly SerializedConversationMessage[], index: number): SkillLoadNotice[] {
  const loads: SkillLoadNotice[] = [];
  for (let i = index + 1; i < entries.length && entries[i].kind === 'skill_load'; i++) {
    const { skill } = entries[i];
    if (skill?.invokedBy === 'user') loads.push(skill);
  }
  return loads;
}

// A skill load ranks with the message that caused it: same time, same rank,
// and the stable sort keeps it right under the message.
function rankOf(entry: SerializedConversationMessage): number {
  return entry.role === 'user' && (!entry.kind || entry.kind === 'skill_load') ? USER : SETTLED;
}

function spawnBrief(step: ResearchStep): string | undefined {
  try {
    const args: unknown = JSON.parse(step.args);
    const prompt = args && typeof args === 'object' ? (args as Record<string, unknown>).prompt : undefined;
    return typeof prompt === 'string' ? prompt.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which subagent a planner step started, if it did. The log keeps no link: a
 * harness planner's subagent takes its call's id, and an ADR-0005 research
 * agent is briefed with its spawn call's prompt, trimmed.
 */
function spawnedBy(step: ResearchStep, unclaimed: SubagentLogEntry[]): SubagentLogEntry | undefined {
  const byId = unclaimed.find((e) => e.subagentId === step.toolCallId);
  if (byId) return byId;
  if (step.tool !== 'spawn_research_agent') return undefined;
  const brief = spawnBrief(step);
  return brief === undefined ? undefined : unclaimed.find((e) => e.brief === brief);
}

function research(log: readonly ResearchLogEntry[]): Placed[] {
  const subagents = log.filter((e): e is SubagentLogEntry => 'type' in e && e.type === 'subagent');
  const ownSubagent = new Set(subagents.map((e) => e.subagentId));
  const unclaimed = [...subagents];
  const spawnCall = new Map<string, string | undefined>();
  const placed: Placed[] = [];

  for (const entry of log) {
    if ('type' in entry) {
      if (entry.type === 'system') placed.push({ at: entry.timestamp, rank: RESEARCH, build: (id) => settledMessage(id(), 'system', entry.content) });
      continue;
    }
    if (entry.subagentId && ownSubagent.has(entry.subagentId)) continue;
    const spawned = spawnedBy(entry, unclaimed);
    if (spawned) {
      unclaimed.splice(unclaimed.indexOf(spawned), 1);
      spawnCall.set(spawned.subagentId, entry.toolCallId);
      continue;
    }
    placed.push({ at: entry.timestamp, rank: RESEARCH, build: (id) => toolFromStep(id(), entry) });
  }

  // A subagent stands where it started, which is where its spawn call was
  // announced; the call's own record is written only once the subagent is done.
  for (const entry of subagents) {
    const toolCallId = spawnCall.get(entry.subagentId);
    const steps = log.filter((e): e is ResearchStep => !('type' in e) && e.subagentId === entry.subagentId);
    placed.push({
      at: entry.timestamp,
      rank: RESEARCH,
      build: (id) => subagentBlock(id(), {
        subagentId: entry.subagentId, brief: entry.brief, status: entry.outcome, digest: entry.digest,
        children: steps.map((step) => toolFromStep(id(), step)),
        toolCallId, model: entry.model, usage: entry.usage,
      }),
    });
  }
  return placed;
}

/**
 * The view a saved session reopens with: what its transcript and research log
 * kept, in the order it happened — messages, notices and the compaction
 * summary, plan markers, tool calls with each subagent's calls nested under
 * it, and the token line. Reasoning and streamed text were never saved, so a
 * reload has none.
 *
 * The research log interleaves with the transcript by time. Entries older than
 * a compaction's first kept message went with the turns it condensed.
 */
export function fromTranscript(
  conversationHistory: readonly SerializedConversationMessage[] | undefined,
  researchLog: readonly ResearchLogEntry[] | undefined,
  plannerUsage?: PlannerUsage,
): ConversationView {
  const history = conversationHistory ?? [];
  const compacted = history[0]?.kind === 'compaction' ? history[0] : undefined;
  const kept = compacted ? history.slice(1) : history;
  const cutoff = compacted ? (kept[0]?.timestamp ?? compacted.timestamp) : '';

  const placed: Placed[] = [
    ...kept.map((entry, i) => ({ at: entry.timestamp, rank: rankOf(entry), build: fromEntry(entry, loadsAfter(kept, i)) })),
    ...research(researchLog ?? []).filter((item) => item.at >= cutoff),
  ];
  placed.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank));
  // The summary stands where the condensed turns were, ahead of everything kept.
  if (compacted) placed.unshift({ at: '', rank: SETTLED, build: fromEntry(compacted) });

  let nextId = 1;
  const id = () => `b${nextId++}`;
  const blocks = placed.map((item) => item.build(id));

  if (plannerUsage && isMeasured(plannerUsage.totals)) blocks.push(usageBlock(id(), usageLine(plannerUsage)));

  const transcriptAt = history.reduce<string | undefined>((latest, e) => (latest === undefined || e.timestamp > latest ? e.timestamp : latest), undefined);
  return { blocks, nextId, ...(transcriptAt ? { transcriptAt } : {}) };
}
