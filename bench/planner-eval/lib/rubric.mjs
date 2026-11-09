/**
 * The rubric review: one `claude -p` call on Opus per submitted plan, with no
 * tools, asked fixed questions about the plan against its goal's answer key.
 * The reviewer must cite task ids or quote the plan for every claim; a claim
 * that does neither, or cites an id the plan does not hold, or quotes text the
 * plan does not contain, is discarded before anything counts it. An answer
 * left with no claim reads as unsupported, never as a problem.
 */
import { spawn } from 'node:child_process';

export const QUESTIONS = [
  { id: 'leading-task', text: "Is there a leading task for each shared decision the key lists, which the tasks needing that decision depend on? Name it. (If the key lists none, answer 'na'.)" },
  { id: 'split', text: 'Were steps the key says belong together split across tasks, especially tasks that can run in parallel?' },
  { id: 'count', text: "Is the task count within the key's range, and which tasks are too small to stand on their own?" },
  { id: 'interface', text: 'Do two tasks that can run in parallel (neither depends on the other, directly or not) decide the same interface: a type, a schema, a formatter, a file both must edit?' },
  { id: 'paths', text: "Does each task's prompt name the files and paths it works on?" },
  { id: 'reproduce', text: 'Did the plan reproduce the failure before fixing it, and give the hypotheses about its cause to research tasks?', only: 'g4' },
];

export const questionsFor = (goal) => QUESTIONS.filter((q) => !q.only || q.only === goal.id);

const VERDICTS = ['ok', 'problem', 'na'];

/** The JSON Schema handed to `claude --json-schema`, and the shape `parseRubric` accepts. */
export const RUBRIC_SCHEMA = {
  type: 'object',
  required: ['answers'],
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question', 'verdict', 'claims'],
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          verdict: { enum: VERDICTS },
          claims: {
            type: 'array',
            items: {
              type: 'object',
              required: ['text', 'taskIds', 'quotes'],
              additionalProperties: false,
              properties: {
                text: { type: 'string' },
                taskIds: { type: 'array', items: { type: 'string' } },
                quotes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    tooSmall: { type: 'array', items: { type: 'string' } },
  },
};

export function rubricPrompt(goal, digest) {
  const questions = questionsFor(goal).map((q) => `- ${q.id}: ${q.text}`).join('\n');
  return [
    'You review a plan a coding-agent planner produced for a goal, against an answer key written before the plan existed.',
    'You have no tools. Judge only from the text below. Do not run anything.',
    '',
    'Answer every question with a verdict: "ok" when the plan meets the key on that point, "problem" when it does not, "na" when the question does not apply to this goal.',
    'Every claim must cite the ids of the tasks it is about in taskIds, or quote the plan verbatim (a title, or a phrase from a prompt) in quotes, or both.',
    'A claim with neither is discarded, and so is a quote that does not appear in the plan word for word. An answer with no surviving claim counts as unsupported.',
    "Put the ids of tasks too small to stand on their own in tooSmall (an empty list when there are none).",
    'Reply with JSON only, matching the schema you were given.',
    '',
    '## Questions',
    questions,
    '',
    '## Goal',
    goal.goal,
    '',
    '## Answer key',
    JSON.stringify(goal.key, null, 2),
    '',
    '## Plan (tasks with ids, titles, dependencies by id, and prompts)',
    JSON.stringify(digest, null, 2),
  ].join('\n');
}

/** The first JSON object in `text`: the reviewer may fence it or put a line before it. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function planText(digest) {
  const parts = [];
  const walk = (tasks) => {
    for (const t of tasks) {
      parts.push(String(t.title ?? ''), String(t.prompt ?? ''));
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(digest);
  return parts.join('\n');
}

function planIds(digest) {
  const ids = new Set();
  const walk = (tasks) => {
    for (const t of tasks) {
      ids.add(String(t.id));
      if (t.order !== undefined) ids.add(String(t.order));
      if (t.subtasks) walk(t.subtasks);
    }
  };
  walk(digest);
  return ids;
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Keep the claims that cite the plan, and only the citations that hold: a
 * task id the plan has, a quote it contains (whitespace aside). A task's order
 * number is accepted as its id, as a reviewer reading "1." may write it.
 */
export function citedOnly(raw, goal, digest) {
  const ids = planIds(digest);
  const text = squash(planText(digest));
  const asked = new Map(questionsFor(goal).map((q) => [q.id, q]));
  let discarded = 0;
  const answers = [];
  for (const answer of Array.isArray(raw?.answers) ? raw.answers : []) {
    if (!asked.has(answer?.question) || !VERDICTS.includes(answer?.verdict)) {
      discarded++;
      continue;
    }
    const claims = [];
    for (const claim of Array.isArray(answer.claims) ? answer.claims : []) {
      const taskIds = (Array.isArray(claim?.taskIds) ? claim.taskIds : []).map(String).filter((id) => ids.has(id));
      const quotes = (Array.isArray(claim?.quotes) ? claim.quotes : []).map(String).filter((q) => squash(q).length > 0 && text.includes(squash(q)));
      if (typeof claim?.text === 'string' && (taskIds.length > 0 || quotes.length > 0)) claims.push({ text: claim.text, taskIds, quotes });
      else discarded++;
    }
    answers.push({ question: answer.question, verdict: claims.length > 0 || answer.verdict === 'na' ? answer.verdict : 'unsupported', claims });
  }
  const tooSmall = (Array.isArray(raw?.tooSmall) ? raw.tooSmall : []).map(String).filter((id) => ids.has(id));
  const problems = answers.filter((a) => a.verdict === 'problem').map((a) => ({ question: a.question, claims: a.claims }));
  return { answers, tooSmall, problems, discardedClaims: discarded };
}

/**
 * Run the reviewer. Its environment is the bench's own minus every key it
 * holds for a backend: the reviewer needs Claude Code's login, nothing else.
 */
export function reviewPlan(goal, digest, { model = 'opus', timeoutMs = 600_000, command = 'claude', env = process.env } = {}) {
  const args = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--output-format', 'json', '--json-schema', JSON.stringify(RUBRIC_SCHEMA)];
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) if (/API_KEY$|_TOKEN$/.test(name) && name !== 'CLAUDE_CODE_OAUTH_TOKEN') delete childEnv[name];
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `could not start ${command}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const envelope = extractJson(out);
      const raw = envelope?.structured_output ?? (typeof envelope?.result === 'string' ? extractJson(envelope.result) : envelope);
      if (code !== 0 || !raw) {
        resolve({ ok: false, error: `reviewer exited ${code}: ${(err || out).slice(0, 400)}` });
        return;
      }
      resolve({ ok: true, ...citedOnly(raw, goal, digest)});
    });
    child.stdin.on('error', () => {});
    child.stdin.end(rubricPrompt(goal, digest));
  });
}
