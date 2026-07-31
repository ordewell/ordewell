/** The envelope key a full plan reply is keyed by: `{"tasks":[...]}`. */
export const PLAN_ENVELOPE_KEY = 'tasks';
/** The envelope key a targeted-edits reply is keyed by: `{"taskOps":[...]}`. */
export const TASK_OPS_ENVELOPE_KEY = 'taskOps';

/** Thrown when an LLM plan response cannot be parsed into a valid plan. Carries the raw text so callers can log it or retry. */
export class PlanParseError extends Error {
  readonly raw: string;
  /**
   * True when the reply was cut off mid-object (output-token limit) rather
   * than malformed — the two need different repairs: a truncated emission will
   * be cut at the same point again unless the retry frees context or asks for
   * terser output.
   */
  readonly truncated: boolean;
  /**
   * True when the JSON parsed fine and a *shape* rule rejected it. The generic
   * "could not be parsed as JSON" corrective is a lie for these, so the model
   * re-sends the same object; a semantic rejection must be repaired by naming
   * the rule it broke.
   */
  readonly semantic: boolean;
  constructor(message: string, raw: string, opts?: { truncated?: boolean; semantic?: boolean }) {
    super(message);
    this.name = 'PlanParseError';
    this.raw = raw;
    this.truncated = opts?.truncated ?? false;
    this.semantic = opts?.semantic ?? false;
  }
}
/**
 * Strip the noise reasoning models wrap around their answer: markdown code
 * fences and `<think>…</think>` chain-of-thought blocks (which routinely contain
 * stray braces that would otherwise derail brace-balancing). Reasoning captured
 * out-of-band by the service never reaches here, but a model that inlines its
 * thinking in the content channel still must not corrupt parsing.
 */
export function stripModelNoise(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

/**
 * Scan from `start` (which must point at a `{`) for the matching balanced close,
 * ignoring braces inside strings. Returns the object substring and whether it was
 * balanced; an unbalanced result means the input was truncated mid-object.
 */
function balancedObjectAt(text: string, start: number): { json: string; balanced: boolean } {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), balanced: true };
    }
  }
  return { json: text.slice(start), balanced: false };
}

/**
 * Scan an LLM response for every balanced `{…}` object carrying a `"<key>":`
 * entry. Strips fences and `<think>` blocks first. A matching object is
 * skipped over wholesale, so its nested braces don't produce fragment
 * candidates; non-matching objects are descended into, so a match wrapped in
 * an unrelated outer object is still found. `fallback` preserves the legacy
 * behavior for callers with no keyed match: the first balanced object, else
 * the stripped text so a JSON.parse error still surfaces.
 */
export function extractObjectsWithKey(raw: string, key: string): {
  matches: string[];
  fallback: { json: string; balanced: boolean };
  sawBrace: boolean;
  /** An object ran to EOF unclosed — the classic signature of truncated output. */
  sawUnbalanced: boolean;
} {
  const stripped = stripModelNoise(raw);
  const keyRe = new RegExp(`"${key}"\\s*:`);

  const matches: string[] = [];
  let firstObject: string | null = null;
  let sawBrace = false;
  let sawUnbalanced = false;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch !== '{') continue;

    sawBrace = true;
    const obj = balancedObjectAt(stripped, i);
    // A stray brace in a reasoning preamble produces an unbalanced candidate,
    // which we skip so it can't swallow the real object that follows.
    if (obj.balanced && keyRe.test(obj.json)) {
      matches.push(obj.json);
      i += obj.json.length - 1;
      continue;
    }
    if (!obj.balanced) sawUnbalanced = true;
    if (!firstObject && obj.balanced) firstObject = obj.json;
  }

  return {
    matches,
    fallback: firstObject !== null ? { json: firstObject, balanced: true } : { json: stripped, balanced: false },
    sawBrace,
    sawUnbalanced,
  };
}

/**
 * Pull the JSON object out of an LLM response and report whether it was balanced.
 * Strips fences and `<think>` blocks, then walks every top-level `{…}` and
 * returns the FIRST one that contains a `"tasks"` key — so a brace appearing
 * earlier in reasoning (or an unrelated preamble object) can't make us parse the
 * wrong thing. Falls back to the first balanced object and, failing that, the
 * first `{` onwards so a genuine `JSON.parse` error still surfaces.
 */
export function extractObjectWithBalance(raw: string): { json: string; balanced: boolean; sawBrace: boolean } {
  const { matches, fallback, sawBrace } = extractObjectsWithKey(raw, PLAN_ENVELOPE_KEY);
  if (matches.length > 0) return { json: matches[0], balanced: true, sawBrace };
  return { ...fallback, sawBrace };
}

/**
 * Pull the JSON object out of an LLM response. Strips markdown code fences and
 * `<think>` blocks, prefers the object containing a `tasks` key, and tolerates a
 * prose preamble and trailing prose. Returns the fence-stripped text unchanged
 * if no `{` is present so the caller's JSON.parse produces a clear failure.
 */
export function extractJsonObject(raw: string): string {
  return extractObjectWithBalance(raw).json;
}

/** Drop trailing commas before a closing `}` or `]` — a common model quirk. */
export function stripTrailingCommas(json: string): string {
  return json.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Escape raw control characters that appear INSIDE string literals — budget
 * models routinely emit multi-line `prompt` strings with literal newlines,
 * which strict JSON.parse rejects ("bad control character"). Characters
 * outside strings (formatting whitespace) are left untouched.
 */
export function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}
