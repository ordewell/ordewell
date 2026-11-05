/**
 * Credential redaction, in two modes named for the text they take.
 *
 * {@link redactSourceText} is for text that may be source code: research tool
 * output, applied once where a result is constructed (see `executeTool`), so a
 * single call covers every sink that result reaches: the persisted session
 * file, the tool result sent to the model provider, the fallback plan prompt,
 * and the live progress stream. Redacting per-sink would mean the provider
 * payload and the session file could drift apart, and a third party would end
 * up with key material the disk copy had scrubbed.
 *
 * {@link redactAgentText} is for what a runner wrote: its stderr, its JSON-RPC
 * errors. That text is never code to keep byte for byte, and a CLI that dumps
 * its settings prints keys of any shape, so a value under a credential-named
 * key goes whatever it looks like.
 *
 * Both take text whole. A cut made before redaction can part a name from its
 * value, or a key's BEGIN line from its body, and the part kept then matches
 * no rule; cut what these return instead (see `LineTail`).
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

import { isCredentialVariable } from '../services/harness/credentialEnv';

export const REDACTION_MARKER = 'REDACTED';

function marker(kind: string, length: number): string {
  return `[${REDACTION_MARKER} ${kind}: ${length} chars]`;
}

/**
 * A marker where a value starts. Text is redacted again on its way on (a
 * task's output, then the report quoting it), and a bare value ends at the
 * marker's first space, so without this a second pass would mark the marker.
 */
const MARKER_AT = new RegExp(String.raw`\[${REDACTION_MARKER} [a-z ]+: \d+ chars\]`, 'y');

/** Tested on the whole line: a log prefix's brackets would take the marker's own. */
const KEY_MARKER_LINE = new RegExp(String.raw`\[${REDACTION_MARKER} private key: \d+ chars\]\s*$`);

function markerAt(text: string, at: number): boolean {
  MARKER_AT.lastIndex = at;
  return MARKER_AT.test(text);
}

/**
 * Research output is line-oriented and usually arrives prefixed: `read_file`
 * emits `  12|content`, ripgrep emits `path:12:content`, and a log opens each
 * line with `[2026-11-05 10:00:00] ` or `[cline] `. A rule anchored to the
 * start of a line has to see past them or it never fires on real output.
 */
// A path opens with no `[`: else, on a line of `[a]` groups, each count of them
// the engine gives back rescans the rest of the line for a `:`, quadratically.
const LINE_PREFIX = String.raw`(?:[ \t]*\[[^\]\n]*\])*(?:[ \t]*\d+\||(?:[^\s:[][^\s:]*)?:\d+:|)[ \t]*`;
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
 *
 * The name is one whole run, entered only where none runs through, and the
 * word is found in it by a lookahead: a run split around the word at every
 * start backtracks cubically, and a 16k stderr line of `-token-token…` hangs
 * the extension host.
 */
const NAMED_CREDENTIAL = new RegExp(
  String.raw`((?:^|[^A-Za-z0-9_.\-])["']?(?=[A-Za-z0-9_.\-]*` + CREDENTIAL_WORD + String.raw`)[A-Za-z0-9_.\-]+["']?[ \t]*(?:=>|[:=])[ \t]*)(["'\x60]?)([A-Za-z0-9_\-./+=:~!@#%^&*]{8,})\2`,
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
  // The name found by a lookahead, as in NAMED_CREDENTIAL, or a line of `TOKEN_TOKEN_…` backtracks quadratically.
  String.raw`^(` + LINE_PREFIX + String.raw`(?:export[ \t]+)?(?=[A-Z0-9_]*` + CREDENTIAL_WORD.toUpperCase() + String.raw`)[A-Z0-9_]+[ \t]*=[ \t]*)(["'\x60]?)([^\s"'\x60]{3,})\2[ \t]*$`,
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

const PRIVATE_KEY_LABEL = String.raw`((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)`;
const PEM_BEGIN = new RegExp(`-----BEGIN ${PRIVATE_KEY_LABEL}-----`);
const PEM_END = new RegExp(`-----END ${PRIVATE_KEY_LABEL}-----`);
/** Base64 payload, and the `Proc-Type:`/`DEK-Info:` headers of an encrypted key. */
const PEM_BODY_LINE = /^[A-Za-z0-9+/=:,.\- \t]*$/;
/**
 * Stricter than {@link PEM_BODY_LINE}, for walking up from an END line with no
 * BEGIN to bound the walk: `debug: loading extension manifest` passes the
 * looser test.
 */
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;
/** Below a body line's usual length, so that a one-word line above the key is not taken for part of it. */
const MIN_BODY_LINE = 16;

/**
 * `\n` as JSON escapes it, once or more: up to four levels of JSON inside
 * JSON. Unbounded, a run of backslashes is rescanned from each of its
 * characters, quadratically.
 */
const ESCAPED_BREAK = String.raw`\\{1,16}[nr]`;
const INLINE_BODY_CHARS = String.raw`A-Za-z0-9+/=:,.\- \t\\`;
/**
 * A key held on one line: `\n`-escaped in a JSON value (a service-account
 * file's `private_key`), or flattened with spaces into an environment
 * variable. The body runs to its END, or, cut short, to the first character no
 * body has.
 */
const INLINE_PEM = new RegExp(
  String.raw`(-----BEGIN ${PRIVATE_KEY_LABEL}-----(?:${ESCAPED_BREAK}|[ \t])+)([${INLINE_BODY_CHARS}]*?)(?=${ESCAPED_BREAK}-----END \2-----|-----END|[^${INLINE_BODY_CHARS}]|$)`,
  'g',
);
const PEM_END_ANYWHERE = new RegExp(PEM_END.source, 'g');
const INLINE_BODY_CHAR = /[A-Za-z0-9+/=\\]/;

const bodyLength = (body: string) => body.replace(new RegExp(ESCAPED_BREAK, 'g'), '').replace(/\s/g, '').length;

function redactInlineBodies(text: string): string {
  return text.replace(INLINE_PEM, (full, head: string, _label: string, body: string) => {
    const chars = bodyLength(body);
    if (chars === 0) return full;
    return `${head}${marker('private key', chars)}${/[ \t]*$/.exec(body)?.[0] ?? ''}`;
  });
}

/** Whether `text[at]` is the `n` or `r` that ends an escaped break. */
const endsEscapedBreak = (text: string, at: number) => (text[at] === 'n' || text[at] === 'r') && text[at - 1] === '\\';

/**
 * The body before an END on the same line whose BEGIN was cut off, escaped
 * (`…\nMIIE…\n-----END`) or flattened with spaces (`…MIIE… -----END`):
 * walked back to by hand, which keeps it linear, a token at a time. As with
 * {@link redactBodyAbove}, the token above the END may be short and each one
 * further up must be a body line's length, so the words of a message before
 * the key are kept.
 */
function redactInlineBodiesBeforeEnd(text: string): string {
  let out = '';
  let from = 0;
  for (const end of text.matchAll(PEM_END_ANYWHERE)) {
    let at = end.index;
    let top = at;
    let bottom = -1;
    let chars = 0;
    for (;;) {
      while (at > from && (text[at - 1] === ' ' || text[at - 1] === '\t' || endsEscapedBreak(text, at - 1))) {
        at--;
        if (text[at] !== ' ' && text[at] !== '\t') while (at > from && text[at - 1] === '\\') at--;
      }
      const tokenEnd = at;
      while (at > from && INLINE_BODY_CHAR.test(text[at - 1]) && !endsEscapedBreak(text, at - 1)) at--;
      const token = text.slice(at, tokenEnd).replace(/\\/g, '');
      if (!BASE64_LINE.test(token) || (bottom >= 0 && token.length < MIN_BODY_LINE)) break;
      if (bottom < 0) bottom = tokenEnd;
      top = at;
      chars += token.length;
    }
    if (chars < MIN_BODY_LINE) continue;
    out += text.slice(from, top) + marker('private key', chars);
    from = bottom;
  }
  return out + text.slice(from);
}

/** Replace the base64 lines that end `out` with one marker: a body whose BEGIN line was cut off. */
function redactBodyAbove(out: string[]): void {
  let lines = 0;
  let chars = 0;
  while (lines < out.length) {
    const content = out[out.length - 1 - lines].replace(LINE_PREFIX_ANCHORED, '').trim();
    if (!BASE64_LINE.test(content) || (lines > 0 && content.length < MIN_BODY_LINE)) break;
    chars += content.length;
    lines++;
  }
  if (lines > 0) out.splice(out.length - lines, lines, marker('private key', chars));
}

/**
 * Drop the body of every PEM private key block, keeping its `BEGIN`/`END`
 * lines. Done line by line rather than with one block-spanning regex because a
 * paginated `read_file` truncates mid-key: the block still carries key
 * material, but there is no `END` line to match against, and a regex reaching
 * for the end of the text would swallow whatever followed the truncation. A
 * read that starts mid-key, or a tail whose BEGIN was evicted, has the
 * opposite problem: an `END` line with the body above it.
 */
function redactPrivateKeyBlocks(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text;
  text = redactInlineBodiesBeforeEnd(redactInlineBodies(text));

  const out: string[] = [];
  let label: string | null = null;
  // What the BEGIN line opens with, which each line of its block repeats: a
  // `docker compose logs` service column, a markdown quote's `> `.
  let prefix = '';
  let bodyChars = 0;

  const closeBlock = (): void => {
    if (label === null) return;
    out.push(marker('private key', bodyChars));
    label = null;
    bodyChars = 0;
  };

  for (const line of text.split('\n')) {
    if (label === null) {
      if (PEM_END.test(line)) redactBodyAbove(out);
      out.push(line);
      const begun = PEM_BEGIN.exec(line);
      // A body on the BEGIN line itself was an inline key, already redacted.
      if (begun && !/[A-Za-z0-9+/]/.test(line.slice(begun.index + begun[0].length))) {
        label = begun[1];
        prefix = line.slice(0, begun.index);
      }
      continue;
    }
    const own = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line;
    // A CRLF text keeps its `\r` on each line split at `\n`, and no body line has one.
    const content = own.replace(LINE_PREFIX_ANCHORED, '').replace(/\r$/, '');
    if (content.includes(`-----END ${label}-----`)) {
      closeBlock();
      out.push(line);
    } else if (bodyChars === 0 && KEY_MARKER_LINE.test(line)) {
      // A block an earlier pass redacted already: marking it again would say it held nothing.
      out.push(line);
      label = null;
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

/**
 * The start of the BEGIN line of a private key block still open at `end`, a
 * line start in `text`: a read from `end` holds body lines with neither BEGIN
 * nor END, which nothing marks as key material, so it has to be redacted from
 * that BEGIN on. The same lines close a block here as in
 * {@link redactPrivateKeyBlocks}.
 */
export function openPrivateKeyStart(text: string, end: number): number | undefined {
  const head = text.slice(0, end);
  const at = head.lastIndexOf('-----BEGIN ');
  const begun = at < 0 ? null : PEM_BEGIN.exec(head.slice(at));
  if (!begun || begun.index !== 0) return undefined;
  const start = head.lastIndexOf('\n', at) + 1;
  const lineEnd = head.indexOf('\n', at);
  if (lineEnd < 0 || /[A-Za-z0-9+/]/.test(head.slice(at + begun[0].length, lineEnd))) return undefined;
  const prefix = head.slice(start, at);
  const open = head.slice(lineEnd + 1).split('\n').every((line) => {
    const own = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const content = own.replace(LINE_PREFIX_ANCHORED, '').replace(/\r$/, '');
    return !content.includes('-----END ') && PEM_BODY_LINE.test(content);
  });
  return open ? start : undefined;
}

/**
 * `Authorization: Bearer …`, in a header, a curl line or a log. The token
 * test keeps the scheme words in prose (`Basic authentication`) as they are;
 * after an `Authorization` header's name the scheme is no prose, so its token
 * goes whatever its shape.
 */
const AUTH_SCHEME_CREDENTIAL = /((?<![A-Za-z0-9-])(?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?)?(?<![A-Za-z0-9])(Bearer|Basic|Token)([^\S\n]+)([A-Za-z0-9\-._~+/]{8,}=*)/gi;

/** Past the longest word a scheme is followed by in prose, a token of one case and no digit is still a token. */
const MIN_PLAIN_TOKEN = 20;

function looksLikeToken(value: string): boolean {
  return /\d/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || /[+/=]/.test(value) || value.length >= MIN_PLAIN_TOKEN;
}

/**
 * A key and what assigns it: `"KEY":`, `key =`, `:key =>`, with the key's
 * quotes escaped any number of times, as JSON inside JSON escapes them.
 */
// A name starts only where no name runs through, however many `.` or `-` part
// it from the last, so a run like `a-a-…` or `x--x--…` is scanned once, not
// once per start; the one-char tests first keep the long lookbehind off a run
// of `-` or `\`. An escaped break (`\n`, `\t`) parts the lines of an env dump
// inside a JSON string.
const ASSIGNED_NAME = /(?![.-])(?<!\\)(?:(?<=\\[nrt][.-]*)|(?<![A-Za-z0-9_\\][.-]*))(\\*["'`])?([A-Za-z_][A-Za-z0-9_.-]*)(\\*["'`])?[ \t]*(=>|:|=(?!=))[ \t]*/g;
/**
 * A long flag and the space that parts it from its value: `--api-key v`, as a
 * spawn line or a usage error prints it. A value that opens with `-` is the
 * next flag, and one shorter than a key is as likely the next word of prose
 * (`pass --token to it`).
 */
const SPACED_FLAG = /(?<![A-Za-z0-9_-])(--)([A-Za-z][A-Za-z0-9_-]*)()[ \t]+(?=[^\s-]\S{7})/g;
/**
 * A name and its value laid out as a table row, `| GITHUB_TOKEN | value |`,
 * as an agent's report lists what it set. The one-char lookahead keeps the
 * lookbehind off a run of spaces.
 */
const TABLE_NAME = /(?=[A-Za-z_\x60])(?<=\|[ \t]*)(\x60?)([A-Za-z_][A-Za-z0-9_.-]*)(\x60?)[ \t]*(\|)[ \t]*/g;
/** A name and its value as an element, `<password>value</password>`: a settings.xml, a SOAP fault. */
const ELEMENT_NAME = /<()([A-Za-z_][A-Za-z0-9_.-]*)()(>)/g;
/** A scheme word {@link AUTH_SCHEME_CREDENTIAL} redacts with the token after it, which a bare value would part from it. */
const AUTH_SCHEME_WORD = /^(?:Bearer|Basic|Token)$/i;
/**
 * A name an env dump or a request header prints, `MISTRAL_API_KEY:` or
 * `x-api-key:`, whose bare value after a colon is the value; after a lone word
 * (`password: required`, `apiKey: string`) the value is taken only when it is
 * shaped like a key.
 */
const DUMPED_NAME = /[_-]/;
/** Where an unquoted value after a colon, `=>` or a flag ends. */
const BARE_VALUE_END = /[\s,;&"'`)}\]\\]/;
/**
 * Where an unquoted value assigned with `=` ends: a shell or dotenv value runs
 * to the next space, `,` `;` `)` and all, as `DB_PASSWORD=a,b` assigns `a,b`.
 * A quote or `\` still ends it, as the end of the string it sits in, and `&`
 * as the end of a query parameter.
 */
const ASSIGNED_VALUE_END = /[\s"'`\\&]/;
/** Names that carry a credential however a harness spells its own login, which {@link isCredentialVariable} leaves out. */
const CREDENTIAL_KEY_SUFFIX = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|AUTHORIZATION)$/;
/**
 * What a name carries after its credential word to tell one of several apart:
 * `GITHUB_TOKEN_1`, `api_key_v2`, `OPENAI_API_KEY_BACKUP`. Curated, as the
 * shapes are, so `TOKEN_COUNT` and `MAX_TOKENS` stay counts.
 */
const NAME_QUALIFIER = /_(?:V?\d+|BACKUP|OLD|NEW|PREV|PREVIOUS|NEXT|CURRENT|PRIMARY|SECONDARY|FALLBACK|ROTATED|ALT|PROD|PRODUCTION|DEV|STAGING|TEST|LIVE|LOCAL)$/;

function credentialNamed(key: string): boolean {
  const name = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-.]/g, '_')
    .toUpperCase()
    .replace(NAME_QUALIFIER, '')
    // `apiKeys` holds keys; `MAX_TOKENS` is a count, so only a plural of KEY is one.
    .replace(/KEYS$/, 'KEY');
  return isCredentialVariable(name) || CREDENTIAL_KEY_SUFFIX.test(name);
}

/** A bare value a lone name or a table cell gives, taken only when it reads as a key and not as a word or code. */
function keyShaped(value: string): boolean {
  if (looksLikeCode(value) || value.startsWith('$')) return false;
  if (CAMEL_IDENTIFIER.test(value) && !/\d/.test(value)) return false;
  return looksLikeKeyMaterial(value);
}

type Span = { start: number; end: number };

/** The quoted value at `at`, up to the same quote escaped the same way, or the end of its line when it was cut first. */
function quotedAt(text: string, at: number): Span | undefined {
  let open = at;
  while (text[open] === '\\') open++;
  if (open >= text.length || !`"'\``.includes(text[open])) return undefined;
  const close = text.slice(at, open + 1);
  let end = open + 1;
  while (end < text.length && text[end] !== '\n' && !text.startsWith(close, end)) {
    end += close.length === 1 && text[end] === '\\' && text[end + 1] !== '\n' ? 2 : 1;
  }
  return { start: open + 1, end: Math.min(end, text.length) };
}

function bareUntil(text: string, at: number, ends: RegExp): Span {
  let end = at;
  while (end < text.length && !ends.test(text[end])) end++;
  return { start: at, end };
}

/** Each quoted element of the list at `at`, `["a", "b"]`, as `apiKeys` holds them. */
function listedAt(text: string, at: number): Span[] {
  const spans: Span[] = [];
  let next = at + 1;
  for (;;) {
    while (next < text.length && /[\s,]/.test(text[next])) next++;
    const value = quotedAt(text, next);
    if (!value) return spans;
    spans.push(value);
    next = value.end + 1;
  }
}

/**
 * The values `name` holds after `separator` at `at`: quoted, a list of quoted
 * values, or unquoted, ending where that separator's values end.
 */
function valuesAt(text: string, at: number, name: string, separator: string | undefined): Span[] {
  const quoted = quotedAt(text, at);
  if (quoted) return [quoted];
  if (text[at] === '\\') return [];
  if (text[at] === '[' && (separator === ':' || separator === '=')) return listedAt(text, at);
  if (separator === '>') {
    const value = bareUntil(text, at, /[<\n]/);
    return text.startsWith(`</${name}>`, value.end) ? [value] : [];
  }
  if (separator === '|') {
    const value = bareUntil(text, at, /[\s|]/);
    return wholeCell(text, value.end) && keyShapedCell(text.slice(value.start, value.end)) ? [value] : [];
  }
  const value = bareUntil(text, at, separator === '=' ? ASSIGNED_VALUE_END : BARE_VALUE_END);
  if (separator === ':' && !DUMPED_NAME.test(name) && !keyShaped(text.slice(value.start, value.end))) return [];
  return [value];
}

/** Whether only spaces part `at` from the end of its table cell: a cell of several words is prose (`| GITHUB_TOKEN | your token |`). */
function wholeCell(text: string, at: number): boolean {
  let end = at;
  while (text[end] === ' ' || text[end] === '\t') end++;
  return end >= text.length || text[end] === '|' || text[end] === '\n' || text[end] === '\r';
}

/**
 * A table cell's one value, of a key's length: anything but a word
 * (`required`), code or a reference, since a cell has no quotes to tell a
 * slug of a key from a setting.
 */
function keyShapedCell(value: string): boolean {
  return value.length >= 8 && !/^[A-Za-z]+$/.test(value) && !looksLikeCode(value) && !value.startsWith('$');
}

/**
 * Every value under a credential-named key, whatever its shape: quoted,
 * assigned with `=`, given to a flag, bare after the colon of a dumped name,
 * in a table row or an element.
 */
function redactCredentialNamedValues(text: string): string {
  for (const pattern of [ASSIGNED_NAME, SPACED_FLAG, TABLE_NAME, ELEMENT_NAME]) text = redactNamedValues(text, pattern);
  return text;
}

function redactNamedValues(text: string, pattern: RegExp): string {
  const names = new RegExp(pattern);
  let out = '';
  let from = 0;
  for (let found = names.exec(text); found; found = names.exec(text)) {
    // The name first: a bare value runs on to its end, and on `a=a=a=…` every name would rescan the rest of the text.
    if (!credentialNamed(found[2])) continue;
    const values = valuesAt(text, found.index + found[0].length, found[2], found[4])
      .filter((value) => value.end > value.start && !markerAt(text, value.start) && !AUTH_SCHEME_WORD.test(text.slice(value.start, value.end)));
    for (const value of values) {
      out += text.slice(from, value.start) + marker('credential', value.end - value.start);
      from = value.end;
    }
    if (values.length > 0) names.lastIndex = from;
  }
  return out + text.slice(from);
}

const NUMERIC = /^[-+]?\d+(?:\.\d+)?$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** An identifier whose case turns inside it: `passwordField`, `hashedPassword`. */
const CAMEL_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*[a-z][A-Z][A-Za-z0-9_$]*$/;
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

/** Below this, a held value is too likely to be an ordinary word of the text (`true`, `1`, `dev`). */
const MIN_HELD_LENGTH = 8;

/**
 * Replace credential material in text that may be source code with visible
 * markers. Safe to call on any tool output, including output that contains no
 * secrets — text with no match is returned unchanged. A value that reads as
 * code (`password: passwordField`) is left as it is.
 *
 * `held` are values known to be secret, replaced wherever they occur: a key
 * Ordewell handed a process need not look like any key the rules know.
 */
export function redactSourceText(text: string, held: Iterable<string> = []): string {
  return redact(text, held, false);
}

/**
 * Replace credential material in text a runner wrote — stderr, a JSON-RPC
 * error, a task's output — with visible markers: everything
 * {@link redactSourceText} replaces, and every value under a credential-named
 * key whatever its shape: quoted, assigned with `=`, given to a flag, or bare
 * after the colon of a dumped name (`X-Api-Key: …`, `GITHUB_TOKEN: …`).
 */
export function redactAgentText(text: string, held: Iterable<string> = []): string {
  return redact(text, held, true);
}

function redact(text: string, held: Iterable<string>, agentText: boolean): string {
  if (!text) return text;

  let out = text;
  // Longest first, so a value inside another (a token in its `Bearer` header) leaves none of the longer behind.
  const values = [...new Set([...held].map((v) => v.trim()).filter((v) => v.length >= MIN_HELD_LENGTH))].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(marker('secret', value.length));

  out = redactPrivateKeyBlocks(out);

  if (agentText) out = redactCredentialNamedValues(out);

  out = out.replace(DOTENV_CREDENTIAL, (full, head: string, quote: string, value: string) => {
    if (looksLikeCode(value) || value.startsWith('$')) return full;
    return `${head}${quote}${marker('credential', value.length)}${quote}`;
  });

  out = out.replace(NAMED_CREDENTIAL, (full, head: string, quote: string, raw: string) => {
    const { value, tail } = trimTrailingPunctuation(raw);
    if (value.length < 8) return full;
    if (looksLikeCode(value) || value.startsWith('$')) return full;
    // A camelCase word with no digit is a variable (`password: passwordField`),
    // whatever the name claims; a secret that is one is the false negative
    // given up for source that stays byte for byte, and in agent text the
    // credential-named rule above has already taken a quoted or assigned one.
    if (CAMEL_IDENTIFIER.test(value) && !/\d/.test(value)) return full;
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
    // real case this gives up, `PASSWORD=correcthorse`; in agent text, the
    // credential-named rule above already took every quoted or assigned value
    // this lets through, and every bare colon value under a header- or
    // env-shaped name.
    if (IDENTIFIER.test(value) || SLUG.test(value)) return full;
    if (!UNAMBIGUOUS_CREDENTIAL_NAME.test(head) && !looksLikeKeyMaterial(value)) return full;
    return `${head}${quote}${marker('credential', value.length)}${quote}${tail}`;
  });

  out = out.replace(AUTH_SCHEME_CREDENTIAL, (full, header: string | undefined, scheme: string, space: string, token: string) =>
    header || looksLikeToken(token) ? `${header ?? ''}${scheme}${space}${marker('token', token.length)}` : full);

  for (const pattern of PROVIDER_KEY_PATTERNS) {
    out = out.replace(pattern, (hit: string) => marker('api key', hit.length));
  }

  out = out.replace(CLOUD_ACCESS_KEY_ID, (hit: string) => marker('access key id', hit.length));

  return out;
}
