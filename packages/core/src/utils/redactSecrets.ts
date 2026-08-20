/**
 * Credential redaction for research tool output.
 *
 * Applied once, where a research tool's result is constructed (see
 * `executeTool`), so a single call covers every sink that result reaches: the
 * persisted session file, the tool result sent to the model provider, the
 * fallback plan prompt, and the live progress stream. Redacting per-sink would
 * mean the provider payload and the session file could drift apart, and a
 * third party would end up with key material the disk copy had scrubbed.
 *
 * Secrets are replaced with a visible marker carrying the length of what was
 * removed, not deleted: the planner still needs to reason about the shape of
 * the file it read — that a key was present, and roughly how big — to plan
 * around it.
 *
 * The rules err towards leaving text alone. Ordinary source code is full of the
 * words `token` and `key`, so a named-credential match additionally requires a
 * value that does not look like code: identifiers, member expressions, type
 * annotations, paths, URLs, numbers and language keywords are all left intact.
 */

export const REDACTION_MARKER = 'REDACTED';

function marker(kind: string, length: number): string {
  return `[${REDACTION_MARKER} ${kind}: ${length} chars]`;
}

/**
 * Research output is line-oriented and usually arrives prefixed: `read_file`
 * emits `  12|content`, ripgrep emits `path:12:content`. A rule anchored to the
 * start of a line has to see past both or it never fires on real tool output.
 */
const LINE_PREFIX = String.raw`(?:[ \t]*\d+\||[^\s:]*:\d+:|)[ \t]*`;
const LINE_PREFIX_ANCHORED = new RegExp('^' + LINE_PREFIX);

/**
 * The `(?![a-z])` tail makes the word whole: without it `secret` matches inside
 * `secretlint` and a bin path gets rewritten as if it were key material.
 */
const CREDENTIAL_WORD = String.raw`(?:api[_-]?keys?|secrets?|passwords?|passwd|passphrase|tokens?|access[_-]?keys?|private[_-]?keys?|client[_-]?secrets?|credentials?|auth)(?![a-z])`;

/**
 * `KEY=value` / `"key": "value"` in any of the shapes a config file, shell
 * export or JSON blob uses. The name may sit anywhere inside a longer
 * identifier, so `AWS_SECRET_ACCESS_KEY` and `stripeApiKeyLive` both match.
 */
const NAMED_CREDENTIAL = new RegExp(
  String.raw`((?:^|[^A-Za-z0-9_])["']?[A-Za-z0-9_.\-]*` + CREDENTIAL_WORD + String.raw`[A-Za-z0-9_.\-]*["']?[ \t]*(?:=>|[:=])[ \t]*)(["'\x60]?)([A-Za-z0-9_\-./+=:~!@#%^&*]{8,})\2`,
  'gi',
);

/**
 * The dotenv shape specifically: a whole line that is nothing but an
 * upper-case credential variable and its value. Because the line can hold
 * nothing else, this rule can afford a short, low-entropy value — a real
 * `DB_PASSWORD=hunter2` is indistinguishable from a bare word, and only the
 * surrounding line tells them apart.
 *
 * The name list is upper-cased wholesale rather than matched case-insensitively
 * so that a lower-case assignment — which is code, not a dotenv line — cannot
 * reach this rule's much looser value test.
 */
const DOTENV_CREDENTIAL = new RegExp(
  String.raw`^(` + LINE_PREFIX + String.raw`(?:export[ \t]+)?[A-Z0-9_]*` + CREDENTIAL_WORD.toUpperCase() + String.raw`[A-Z0-9_]*[ \t]*=[ \t]*)(["'\x60]?)([^\s"'\x60]{3,})\2[ \t]*$`,
  'gm',
);

/** Provider key prefixes distinctive enough to redact wherever they appear. */
const PROVIDER_KEY_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic / OpenRouter and the many `sk-` derivatives
  /(?<![A-Za-z0-9])sk-(?:ant-|proj-|or-v1-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  // GitHub personal-access, OAuth, app and refresh tokens
  /(?<![A-Za-z0-9])(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{22,}/g,
  // Slack bot / user / app tokens
  /(?<![A-Za-z0-9])xox[abprse]-[A-Za-z0-9-]{10,}/g,
  // Stripe secret and restricted keys
  /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Google API keys and OAuth access tokens
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9_-]{20,}/g,
  // npm, Hugging Face, Groq, GitLab, DigitalOcean, Shopify
  /(?<![A-Za-z0-9])(?:npm|hf|gsk|glpat|dop_v1|shpat|shpss)[_-][A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/g,
  // Three-segment JWTs, whose payload segment is base64 for `{"`
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/**
 * AWS-style access key identifiers. The four-character resource prefix plus a
 * fixed 16-character body is specific enough to match on its own, which
 * matters because the identifier is often printed far from any variable name
 * (`aws sts get-caller-identity`, a credentials file, an error message).
 */
const CLOUD_ACCESS_KEY_ID =
  /(?<![A-Za-z0-9])(?:A3T[A-Z0-9]{2}|AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;

const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/;
/** Base64 payload, and the `Proc-Type:`/`DEK-Info:` headers of an encrypted key. */
const PEM_BODY_LINE = /^[A-Za-z0-9+/=:,.\- \t]*$/;

/**
 * Drop the body of every PEM private key block, keeping its `BEGIN`/`END`
 * lines. Done line by line rather than with one block-spanning regex because a
 * paginated `read_file` truncates mid-key: the block still carries key
 * material, but there is no `END` line to match against, and a regex reaching
 * for the end of the text would swallow whatever followed the truncation.
 */
function redactPrivateKeyBlocks(text: string): string {
  if (!PEM_BEGIN.test(text)) return text;

  const out: string[] = [];
  let label: string | null = null;
  let bodyChars = 0;

  const closeBlock = (): void => {
    if (label === null) return;
    out.push(marker('private key', bodyChars));
    label = null;
    bodyChars = 0;
  };

  for (const line of text.split('\n')) {
    if (label === null) {
      out.push(line);
      const begun = PEM_BEGIN.exec(line);
      if (begun) label = begun[1];
      continue;
    }
    const content = line.replace(LINE_PREFIX_ANCHORED, '');
    if (content.includes(`-----END ${label}-----`)) {
      closeBlock();
      out.push(line);
    } else if (PEM_BODY_LINE.test(content)) {
      bodyChars += content.trim().length;
    } else {
      // Not key material — the block was truncated, so end it here and keep
      // whatever the tool printed next.
      closeBlock();
      out.push(line);
    }
  }
  closeBlock();

  return out.join('\n');
}

const NUMERIC = /^[-+]?\d+(?:\.\d+)?$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MEMBER_EXPRESSION = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
/** `a-different-token`, `secret_store_key` — a slug or setting name, not key material. */
const SLUG = /^[a-z]+(?:[-_][a-z]+)+$/;
const PATHISH = /^(?:\.{0,2}\/|~\/)/;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

const CODE_KEYWORDS = new Set([
  'true', 'false', 'null', 'none', 'nil', 'undefined', 'void',
  'string', 'number', 'boolean', 'object', 'any', 'unknown', 'bool', 'str', 'int',
]);

/**
 * Values that a named-credential rule must leave alone. `apiKey: string` is a
 * type annotation, `token: process.env.TOKEN` is a lookup, `secretKeyPath:
 * ./keys/id` is a path — none of them is key material, and rewriting them
 * would corrupt the source the planner is trying to read.
 */
/**
 * Names that mean "this value is the secret" on their own. For the rest —
 * `api_key`, `token`, `access_key` — the name alone is not enough: constants
 * like `API_KEY_HEADER = "x-api-key"` are everywhere, so those additionally
 * require a value that looks like key material.
 */
const UNAMBIGUOUS_CREDENTIAL_NAME = /(?:password|passwd|passphrase|secret|credentials?|private[_-]?key)/i;

function looksLikeKeyMaterial(value: string): boolean {
  const hasDigit = /\d/.test(value);
  const hasAlpha = /[A-Za-z]/.test(value);
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return (hasDigit && hasAlpha) || mixedCase || value.length >= 24;
}

function looksLikeCode(value: string): boolean {
  return NUMERIC.test(value)
    || CODE_KEYWORDS.has(value.toLowerCase())
    || MEMBER_EXPRESSION.test(value)
    || PATHISH.test(value)
    || URLISH.test(value);
}

/** Trailing sentence punctuation swept up by the permissive value charset. */
function trimTrailingPunctuation(value: string): { value: string; tail: string } {
  const match = /[.:!]+$/.exec(value);
  if (!match || match.index === 0) return { value, tail: '' };
  return { value: value.slice(0, match.index), tail: match[0] };
}

/**
 * Replace credential material in `text` with visible markers. Safe to call on
 * any tool output, including output that contains no secrets — text with no
 * match is returned unchanged.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let out = redactPrivateKeyBlocks(text);

  out = out.replace(DOTENV_CREDENTIAL, (full, head: string, quote: string, value: string) => {
    if (looksLikeCode(value) || value.startsWith('$')) return full;
    return `${head}${quote}${marker('credential', value.length)}${quote}`;
  });

  out = out.replace(NAMED_CREDENTIAL, (full, head: string, quote: string, raw: string) => {
    const { value, tail } = trimTrailingPunctuation(raw);
    if (value.length < 8) return full;
    if (looksLikeCode(value) || value.startsWith('$')) return full;
    // An unambiguous name (`password`, `secret`, `privateKey`, ...) means the
    // value is claimed to *be* the secret, not a reference to one — so once it
    // also carries a digit, it stops being the "settings-name pointing at
    // another settings-name" shape the identifier bypass below exists for
    // (`vscodeApiKeyKey: 'qwenApiKey'`), which never carries one.
    //
    // A long-enough unambiguous value is treated as the secret even without a
    // digit (a passphrase like `correcthorsebatterystaple` or a plain word
    // like `batterystaple`), because the name alone already claims it is key
    // material. The length floor keeps short settings-references — e.g.
    // `secretStoreKey: 'cohereKey'` (9 chars) — from being rewritten, since a
    // value that short is far more likely to be a reference than a real
    // secret; the digit rule below still catches a short secret that carries
    // one. This is a deliberate, documented false-negative trade-off for
    // sub-floor no-digit values, chosen to preserve config-file integrity
    // over maximal coverage.
    if (UNAMBIGUOUS_CREDENTIAL_NAME.test(head) && (/\d/.test(value) || value.length >= 12)) {
      return `${head}${quote}${marker('credential', value.length)}${quote}${tail}`;
    }
    // A single camelCase word or a lowercase slug is a variable reference or a
    // setting name (`vscodeApiKeyKey: 'qwenApiKey'`), never key material — and
    // config-shaped code is full of both. The dotenv rule still catches the one
    // real case this gives up, `PASSWORD=correcthorse`.
    if (IDENTIFIER.test(value) || SLUG.test(value)) return full;
    if (!UNAMBIGUOUS_CREDENTIAL_NAME.test(head) && !looksLikeKeyMaterial(value)) return full;
    return `${head}${quote}${marker('credential', value.length)}${quote}${tail}`;
  });

  for (const pattern of PROVIDER_KEY_PATTERNS) {
    out = out.replace(pattern, (hit: string) => marker('api key', hit.length));
  }

  out = out.replace(CLOUD_ACCESS_KEY_ID, (hit: string) => marker('access key id', hit.length));

  return out;
}
