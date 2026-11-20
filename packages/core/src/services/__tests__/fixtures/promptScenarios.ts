import { classifyAttempt, type AttemptKind, type AttemptPromptSources } from '../../attemptKind';
import { createTask, type Task } from '../../../models/Task';

/**
 * Attempts of every kind that composes a first message, each carrying as many
 * of the parts as it can. `firstMessages.json` holds what the composer sent for
 * each before the message was told apart into parts: the bytes it must keep.
 */
export interface PromptScenario {
  name: string;
  kind: AttemptKind;
  src: AttemptPromptSources;
}

const dep = createTask({
  id: 'dep', order: 1, title: 'Add the parser', prompt: 'parse it', status: 'completed',
  outputSummary: { reviewReason: 'Verified', logTail: '', capturedAt: '2026-01-01T00:00:00Z' },
  handoff: { summary: 'Parser added in src/parse.ts.', findings: [{ id: 'F1', severity: 'minor', title: 'No streaming yet' }], findingCount: 1 },
});
const sibling = createTask({ id: 'sib', order: 3, title: 'Docs', prompt: 'write docs' });

function sources(task: Task, plan: readonly Task[], extra: Partial<AttemptPromptSources> = {}): AttemptPromptSources {
  return {
    task,
    plan,
    skills: [{ name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md', content: 'RED then GREEN.' }],
    repairPrompt: () => 'Merge the integration branch into your worktree and resolve the conflict in src/parse.ts.',
    previousAttempt: () => 'created resource group rg-dev',
    previousHandoff: () => ({ summary: 'Two holes.', findings: [{ id: 'F1', severity: 'major', title: 'Comma lost' }], findingCount: 1 }),
    ...extra,
  };
}

const beside = { integrationBranch: 'ordewell/run/integration', message: 'Take in what landed beside "Use the parser"', repos: ['.'] };

// createTask keeps no retry note: a retry sets it on the task it reopens.
const change: Task = {
  ...createTask({ id: 'use', order: 2, title: 'Use the parser', prompt: 'Wire the parser into the CLI.\n\nDone when `cli parse` works.', dependencies: ['dep'] }),
  retryNote: { by: 'supervisor', text: 'Run the parser tests before you finish.' },
};
const hitl = createTask({ id: 'use', order: 2, title: 'Use the parser', prompt: 'Wire the parser in.', dependencies: ['dep'], autonomy: 'HITL' });
const ops = createTask({ id: 'deploy', order: 2, title: 'Deploy', prompt: 'Deploy to dev.', dependencies: ['dep'] });
const check = createTask({
  id: 'check', order: 3, title: 'Review the parser', prompt: 'Review src/parse.ts.', dependencies: ['dep'],
  loop: { body: ['dep'], maxRounds: 3 }, loopRound: 2,
});
const firstCheck = createTask({ id: 'check', order: 3, title: 'Review the parser', prompt: 'Review src/parse.ts.', dependencies: ['dep'], loop: { body: ['dep'], maxRounds: 3 } });

export const PROMPT_SCENARIOS: readonly PromptScenario[] = [
  { name: 'change, beside and retried', kind: classifyAttempt('change'), src: sources(change, [dep, change, sibling], { beside }) },
  { name: 'attended change', kind: classifyAttempt('change'), src: sources(hitl, [dep, hitl]) },
  { name: 'ops', kind: classifyAttempt('ops'), src: sources(ops, [dep, ops]) },
  { name: 'repair', kind: classifyAttempt('change', { repair: { n: 1, limit: 2 } }), src: sources(change, [dep, change]) },
  { name: 'read-only', kind: classifyAttempt('readOnly'), src: sources(createTask({ id: 'r', order: 2, title: 'Read', prompt: 'Read the code.' }), [dep]) },
  { name: 'carried over', kind: classifyAttempt('change', { carriedFrom: 'codex' }), src: sources(change, [dep, change], { previousWork: { outcome: 'restored' }, beside }) },
  { name: 'loop check, first round', kind: classifyAttempt('readOnly'), src: sources(firstCheck, [dep, firstCheck]) },
  { name: 'loop check, next round', kind: classifyAttempt('readOnly'), src: sources(check, [dep, check]) },
  { name: 'no skills, no dependencies', kind: classifyAttempt('change'), src: sources(createTask({ id: 'lone', order: 1, title: 'Lone', prompt: '' }), [], { skills: [] }) },
];
