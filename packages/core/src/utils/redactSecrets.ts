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

/**
 * The gutter a line opens with, as its parts: literal text, and `null` for a
 * line number. A file viewer numbers each line (`     1→`, `  1│ `, `cat -n`,
 * `nl`, `grep -n`), `docker compose logs` opens each with its service
 * column, a markdown quote with `> `: the lines of one block repeat it with
 * another number, padded to another width (ADR-0061, G1).
 */
type Gutter = ReadonlyArray<string | null>;

function gutterOf(prefix: string): Gutter {
  return prefix.split(/(\d+)/).map((part, i) => (i % 2 === 1 ? null : part));
}

const isPadding = (char: string | undefined) => char === ' ' || char === '\t';

/**
 * Where `line` starts past `gutter`, or -1 when it opens with something else.
 * By hand rather than as a pattern: several numbers in one gutter, as
 * patterns, backtrack polynomially on a long run of digits.
 */
function pastGutter(gutter: Gutter, line: string, from = 0): number {
  let at = from;
  for (let i = 0; i < gutter.length; i++) {
    const part = gutter[i];
    if (part === null) {
      const from = at;
      while (at < line.length && line[at] >= '0' && line[at] <= '9') at++;
      if (at === from) return -1;
      continue;
    }
    // A number is padded to its width: the spaces either side of it are any run of them.
    let text = part;
    if (gutter[i - 1] === null) {
      while (isPadding(text[0])) text = text.slice(1);
      while (isPadding(line[at])) at++;
    }
    const padded = gutter[i + 1] === null;
    if (padded) text = text.trimEnd();
    if (!line.startsWith(text, at)) return -1;
    at += text.length;
    if (padded) while (isPadding(line[at])) at++;
  }
  return at;
}

/** What a line of a key block holds once its gutter, a known line prefix and a CRLF's `\r` are taken off. */
function blockContent(line: string, gutter: Gutter): string {
  const past = pastGutter(gutter, line);
  return (past < 0 ? line : line.slice(past)).replace(LINE_PREFIX_ANCHORED, '').replace(/\r$/, '');
}

/** Replace the base64 lines that end `out` with one marker: a body whose BEGIN line was cut off, read under the END line's gutter. */
function redactBodyAbove(out: string[], gutter: Gutter): void {
  let lines = 0;
  let chars = 0;
  while (lines < out.length) {
    const content = blockContent(out[out.length - 1 - lines], gutter).trim();
    if (!BASE64_LINE.test(content) || (lines > 0 && content.length < MIN_BODY_LINE)) break;
    chars += content.length;
    lines++;
  }
  if (lines > 0) out.splice(out.length - lines, lines, marker('private key', chars));
}

/** A run of base64 a body line's length that ends a line, whatever opens it. */
const TRAILING_BODY = new RegExp(String.raw`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{${MIN_BODY_LINE},}={0,2}\r?$`);

type OpenBlock = { label: string; gutter: Gutter; chars: number };

/**
 * What `line` is to the key block open above it: its END, a body line (its
 * characters counted), or the first line past a body that was cut short. A
 * line straight after BEGIN that ends in a body line's run of base64 is body
 * under a gutter BEGIN's did not show, and that gutter is the block's from
 * there on: else a block would close as `0 chars` with its body below it
 * (ADR-0061, G1).
 */
function blockLine(block: OpenBlock, line: string): 'end' | 'body' | 'past' {
  const content = blockContent(line, block.gutter);
  if (content.includes(`-----END ${block.label}-----`)) return 'end';
  if (PEM_BODY_LINE.test(content)) {
    block.chars += content.trim().length;
    return 'body';
  }
  const run = block.chars === 0 ? TRAILING_BODY.exec(line) : null;
  if (!run) return 'past';
  block.gutter = gutterOf(line.slice(0, run.index));
  block.chars += run[0].trim().length;
  return 'body';
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
  let block: OpenBlock | null = null;

  const closeBlock = (): void => {
    if (block === null) return;
    out.push(marker('private key', block.chars));
    block = null;
  };

  for (const line of text.split('\n')) {
    if (block === null) {
      const ended = PEM_END.exec(line);
      if (ended) redactBodyAbove(out, gutterOf(line.slice(0, ended.index)));
      out.push(line);
      const begun = PEM_BEGIN.exec(line);
      // A body on the BEGIN line itself was an inline key, already redacted.
      if (begun && !/[A-Za-z0-9+/]/.test(line.slice(begun.index + begun[0].length))) {
        block = { label: begun[1], gutter: gutterOf(line.slice(0, begun.index)), chars: 0 };
      }
      continue;
    }
    if (block.chars === 0 && KEY_MARKER_LINE.test(line)) {
      // A block an earlier pass redacted already: marking it again would say it held nothing.
      out.push(line);
      block = null;
      continue;
    }
    const read = blockLine(block, line);
    if (read === 'body') continue;
    // An END closes the block; any other line means it was truncated, so it
    // ends here and whatever the tool printed next is kept.
    closeBlock();
    out.push(line);
  }
  closeBlock();

  return out.join('\n');
}

/**
 * The start of the BEGIN line of a private key block still open at the end of
 * `head`: a read from there holds body lines with neither BEGIN nor END,
 * which nothing marks as key material, so it has to be redacted from that
 * BEGIN on. A line closes a block here exactly as it does in
 * {@link redactPrivateKeyBlocks}, as both read it with {@link blockLine}.
 */
function openPrivateKeyStart(head: string): number | undefined {
  const at = head.lastIndexOf('-----BEGIN ');
  const begun = at < 0 ? null : PEM_BEGIN.exec(head.slice(at));
  if (!begun || begun.index !== 0) return undefined;
  const start = head.lastIndexOf('\n', at) + 1;
  const lineEnd = head.indexOf('\n', at);
  if (lineEnd < 0 || /[A-Za-z0-9+/]/.test(head.slice(at + begun[0].length, lineEnd))) return undefined;
  const block: OpenBlock = { label: begun[1], gutter: gutterOf(head.slice(start, at)), chars: 0 };
  const open = head.slice(lineEnd + 1).split('\n').every((line) => blockLine(block, line) === 'body');
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
 * A key and what assigns it: `"KEY":`, `key =`, `:key =>`, `NAME := v` and
 * the other assignments of a Makefile or Go (`::=` `?=` `+=` `!=`), `NAME -> v`,
 * with the key's quotes escaped any number of times, as JSON inside JSON
 * escapes them, and in markdown's emphasis (`**NAME**:`, `**NAME:**`).
 */
// A name starts only where no name runs through, however many `.` or `-` part
// it from the last, so a run like `a-a-…` or `x--x--…` is scanned once, not
// once per start; the one-char tests first keep the long lookbehind off a run
// of `-` or `\`. An escaped break (`\n`, `\t`) parts the lines of an env dump
// inside a JSON string. Emphasis is at most three `*`, so a run of them is not
// rescanned from each.
const ASSIGNED_NAME = /(?![.-])(?<!\\)(?:(?<=\\[nrt][.-]*)|(?<![A-Za-z0-9_\\][.-]*))\*{0,3}(\\*["'\x60])?\*{0,3}(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\*{0,3}(?:\\*["'\x60])?\*{0,3}[ \t]*(?<sep>::=|:=|\?=|\+=|!=(?!=)|->|=>|:|=(?!=))\*{0,3}[ \t]*/g;
/**
 * A long flag and the space that parts it from its value: `--api-key v`, as a
 * spawn line or a usage error prints it. A value that opens with `-` is the
 * next flag, and one shorter than a key is as likely the next word of prose
 * (`pass --token to it`).
 */
const SPACED_FLAG = /(?<![A-Za-z0-9_-])--(?<name>[A-Za-z][A-Za-z0-9_-]*)[ \t]+(?=[^\s-]\S{7})/g;
/**
 * A name and its value laid out as a table row, `| GITHUB_TOKEN | value |`,
 * as an agent's report lists what it set, the name in code or in bold. The
 * one-char lookahead keeps the lookbehind off a run of spaces.
 */
const TABLE_NAME = /(?=[A-Za-z_\x60*])(?<=\|[ \t]*)\*{0,3}\x60?(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\x60?\*{0,3}[ \t]*(?<sep>\|)[ \t]*/g;
/** A name and its value as an element, `<password>value</password>`: a settings.xml, a SOAP fault. */
const ELEMENT_NAME = /<(?<name>[A-Za-z_][A-Za-z0-9_.-]*)(?<sep>>)/g;
/**
 * A quoted name as a subscript assigned to, `os.environ["GITHUB_TOKEN"] = "v"`,
 * `headers['Authorization'] ||= 'v'`. What is assigned is taken only quoted: a
 * bare one is a variable.
 */
const SUBSCRIPT_NAME = /(?=["'\x60])(?<=\[[ \t]*)(["'\x60])(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*\][ \t]*(?:\|\||\?\?)?=(?!=)[ \t]*/g;
/**
 * A quoted name as the first argument of a call, its value the next one:
 * `os.Setenv("GITHUB_TOKEN", "v")`, `setHeader('api-key', 'v')`. Taken only
 * quoted, as {@link SUBSCRIPT_NAME} is.
 */
const CALLED_NAME = /(?=["'\x60])(?<=\([ \t]*)(["'\x60])(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*,[ \t]*/g;
/**
 * A command that sets a name to the word after it: `setx NAME v`, a
 * Dockerfile's `ENV NAME v`, fish's `set -gx NAME v`, `launchctl setenv NAME v`,
 * `gh secret set NAME --body v`. Prose sets names too (`set GITHUB_TOKEN
 * beforehand`), so a bare word is taken only with a key's length and shape.
 */
const SET_COMMAND = /(?<![A-Za-z0-9_-])(?:setx|setenv|set|ENV)(?:[ \t]+(?:--?|\/)[A-Za-z]+)*[ \t]+(?<name>[A-Za-z_][A-Za-z0-9_.-]*)[ \t]+(?:(?:--body|-b)(?:[ \t]+|=))?/g;
/**
 * How a value is read after its name. `assigned`: `=` and its kin, to the
 * next space; `labelled`: after `:`, a lone word's value only when shaped
 * like a key; `shaped`: after `!=` or `->`, more often a comparison or a
 * pointer than a value, only a key's shape; `bare`: `=>` or a flag's;
 * `cell` and `element` as a table and XML hold one; `quoted`: only in
 * quotes; `spaced`: a command's next word.
 */
type ValueKind = 'assigned' | 'labelled' | 'shaped' | 'bare' | 'cell' | 'element' | 'quoted' | 'spaced';

function kindOf(separator: string | undefined): ValueKind {
  switch (separator) {
    case ':': return 'labelled';
    case '!=': case '->': return 'shaped';
    case '=>': return 'bare';
    default: return 'assigned';
  }
}

/** Each pattern finds a credential's `name`, and its `sep` where the pattern's own kind does not say how its value reads. */
const NAME_RULES: ReadonlyArray<{ pattern: RegExp; kind?: ValueKind }> = [
  { pattern: ASSIGNED_NAME },
  { pattern: SPACED_FLAG, kind: 'bare' },
  { pattern: TABLE_NAME, kind: 'cell' },
  { pattern: ELEMENT_NAME, kind: 'element' },
  { pattern: SUBSCRIPT_NAME, kind: 'quoted' },
  { pattern: CALLED_NAME, kind: 'quoted' },
  { pattern: SET_COMMAND, kind: 'spaced' },
];
/** A scheme word {@link AUTH_SCHEME_CREDENTIAL} redacts with the token after it, which a bare value would part from it. */
const AUTH_SCHEME_WORD = /^(?:Bearer|Basic|Token)$/i;
/**
 * A name an env dump or a request header prints, `MISTRAL_API_KEY:` or
 * `x-api-key:`, whose bare value after a colon is the value; after a lone word
 * (`password: required`, `apiKey: string`) the value is taken only when it is
 * shaped like a key.
 */
const DUMPED_NAME = /[_-]/;
/** A command's next word, below which it is as likely prose as a value. */
const MIN_SPACED_VALUE = 8;
/** Where an unquoted value after a colon, `=>` or a flag ends. */
const BARE_VALUE_END = /[\s,;&"'`)}\]\\]/;
/**
 * Where an unquoted value assigned with `=` ends: a shell or dotenv value runs
 * to the next space, `,` `;` `)` and all, as `DB_PASSWORD=a,b` assigns `a,b`.
 * A quote or `` still ends it, as the end of the string it sits in, and `&`
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
    // `__GITHUB_TOKEN__` is the name in markdown's emphasis.
    .replace(/^_+|_+$/g, '')
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

/** A YAML block scalar's indicator, `|` `>-` `|2+`, ending its line: the value is on the lines below (ADR-0061, N1). */
const BLOCK_INDICATOR = /[|>][1-9+-]{0,2}[ \t]*\r?(?:\n|$)/y;

/**
 * The values `name` holds at `at`, read as `kind` says: quoted, a list of
 * quoted values, or unquoted, ending where that kind's values end. An object
 * or a block scalar is no value on this line: {@link valuesBelowNames} reads
 * what it holds.
 */
function valuesAt(text: string, at: number, name: string, kind: ValueKind): Span[] {
  const quoted = quotedAt(text, at);
  if (quoted) return [quoted];
  if (kind === 'quoted' || text[at] === '\\') return [];
  if (kind === 'element') {
    const value = bareUntil(text, at, /[<\n]/);
    return text.startsWith(`</${name}>`, value.end) ? [value] : [];
  }
  if (kind === 'cell') {
    const value = bareUntil(text, at, /[\s|]/);
    return wholeCell(text, value.end) && keyShapedCell(text.slice(value.start, value.end)) ? [value] : [];
  }
  if (text[at] === '{') return [];
  if (kind === 'labelled') {
    BLOCK_INDICATOR.lastIndex = at;
    if (BLOCK_INDICATOR.test(text)) return [];
  }
  if (text[at] === '[' && (kind === 'labelled' || kind === 'assigned')) return listedAt(text, at);
  const value = bareUntil(text, at, kind === 'assigned' ? ASSIGNED_VALUE_END : BARE_VALUE_END);
  const shown = text.slice(value.start, value.end);
  if (kind === 'labelled' && !DUMPED_NAME.test(name) && !keyShaped(shown)) return [];
  if (kind === 'shaped' && !keyShaped(shown)) return [];
  if (kind === 'spaced' && (shown.length < MIN_SPACED_VALUE || !keyShaped(shown))) return [];
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
 * assigned, given to a flag or a command, bare after the colon of a dumped
 * name, in a table row, an element, a subscript or a call.
 */
function redactCredentialNamedValues(text: string): string {
  for (const rule of NAME_RULES) text = redactNamedValues(text, rule.pattern, rule.kind);
  return text;
}

function redactNamedValues(text: string, pattern: RegExp, ruleKind: ValueKind | undefined): string {
  const names = new RegExp(pattern);
  let out = '';
  let from = 0;
  for (let found = names.exec(text); found; found = names.exec(text)) {
    const name = found.groups?.name ?? '';
    // The name first: a bare value runs on to its end, and on `a=a=a=…` every name would rescan the rest of the text.
    if (!credentialNamed(name)) continue;
    const values = valuesAt(text, found.index + found[0].length, name, ruleKind ?? kindOf(found.groups?.sep))
      .filter((value) => value.end > value.start && !markerAt(text, value.start) && !AUTH_SCHEME_WORD.test(text.slice(value.start, value.end)));
    for (const value of values) {
      out += text.slice(from, value.start) + marker('credential', value.end - value.start);
      from = value.end;
    }
    if (values.length > 0) names.lastIndex = from;
  }
  return out + text.slice(from);
}

/**
 * A credential name that ends its line, its value on the lines below:
 * `NAME:`, `NAME: |`, `NAME: >-`, in quotes or emphasis (ADR-0061, N1).
 */
const TRAILING_NAME = /(?<![A-Za-z0-9_.-])(?<!\\)(\\*["'\x60]?)\*{0,3}(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\*{0,3}\1\*{0,3}[ \t]*:\*{0,3}[ \t]*(?<indicator>[|>][1-9+-]{0,2})?[ \t]*\r?$/;
/** The last character a line {@link TRAILING_NAME} matches can end with: the test that keeps the pattern off every other line. */
const TRAILING_NAME_END = /[:*|>1-9+-][ \t]*\r?$/;
/** A field that names what its sibling `value` holds: `"name": "GITHUB_TOKEN"`, `- name: GITHUB_TOKEN`, `key="ApiKey"`. */
const NAMING_FIELD = /(?<![A-Za-z0-9_.-])(?<!\\)(\\*["'\x60]?)(?:name|key)\1[ \t]*[:=][ \t]*(\\*["'\x60]?)(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\2(?![A-Za-z0-9_.-])/gi;
/** A credential name whose value is an object of its own: `{"GITHUB_TOKEN": {"value": "…"}}`. */
const NESTED_NAME = /(?<![A-Za-z0-9_.-])(?<!\\)(\\*["'\x60]?)(?<name>[A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*[:=][ \t]*\{/g;
/** What ends the search for a sibling `value`: the end of its object or element, a line, or the next entry's own name. */
const SIBLING_STOP = /[{}<>\n]|(?<![A-Za-z0-9_.-])(?<!\\)(\\*["'\x60]?)(?<field>value|name|key)\1[ \t]*[:=][ \t]*/gi;
/** A blank line or the next list item: the entry a sibling would be in has ended. */
const NEXT_ENTRY = /[ \t]*(?:-[ \t]|\r?\n)/y;
/** A markdown quote's `> ` or `>> ` opening a line, as an agent quotes the output it read. */
const QUOTE_PREFIX = /[ \t]*(?:>[ \t]?)+/y;
/** The lines an entry's fields span at most, `valueFrom` and the like between its name and its value. */
const MAX_SIBLING_LINES = 4;

/** A line that opens with a credential name and ends with it, and how the lines of its value open. */
type Opener = { name: string; block: boolean; gutter: Gutter; pad: number };

function openerOf(line: string): Opener | undefined {
  if (!TRAILING_NAME_END.test(line)) return undefined;
  const found = TRAILING_NAME.exec(line);
  const name = found?.groups?.name;
  if (!found || !name || !credentialNamed(name)) return undefined;
  let end = found.index;
  while (end > 0 && isPadding(line[end - 1])) end--;
  // A list item's dash is indentation to the key after it.
  if (end < found.index && line[end - 1] === '-') {
    end--;
    while (end > 0 && isPadding(line[end - 1])) end--;
  }
  // The lines below open with the same gutter, another number in it: what follows its last number is their indentation.
  const gutter = gutterOf(line.slice(0, end));
  const last = gutter.length - 1;
  return {
    name,
    block: found.groups?.indicator !== undefined,
    gutter: gutter[last] === '' && gutter[last - 1] === null ? gutter.slice(0, last) : gutter,
    pad: found.index - end,
  };
}

/** Where `line`'s content starts under `opener`'s gutter, and how far it is indented past it; undefined when the gutter differs. */
function indentUnder(opener: Opener, line: string): { at: number; indent: number } | undefined {
  const past = pastGutter(opener.gutter, line);
  if (past < 0) return undefined;
  let at = past;
  while (isPadding(line[at])) at++;
  return { at, indent: at - past };
}

/** Where `line`'s content ends: before a CRLF's `\r` and any padding. */
function contentEnd(line: string): number {
  let end = line.length;
  while (end > 0 && (isPadding(line[end - 1]) || line[end - 1] === '\r')) end--;
  return end;
}

/**
 * A plain scalar on the line below its name, taken only as one token that
 * reads as a value: not code, a list, a reference or the next key; after a
 * lone word (`password:`) only with a key's shape.
 */
function plainValueBelow(value: string, name: string): boolean {
  if (!value || /[\s()[\]{}<>,;]/.test(value) || /^[-#&*!|>$]/.test(value) || value.endsWith(':')) return false;
  if (looksLikeCode(value) || AUTH_SCHEME_WORD.test(value)) return false;
  return DUMPED_NAME.test(name) || keyShaped(value);
}

/**
 * The values credential names hold on the lines below them, and beside them
 * as a sibling field (ADR-0061, N1):
 * - a YAML block scalar, `NAME: |` or `NAME: >-`, and every line indented past
 *   its name;
 * - a scalar on the next line, `NAME:` and an indented value;
 * - a name given as a value, its value a sibling: `{"name": "NAME", "value":
 *   "…"}`, `- name: NAME` / `  value: …`, `<env name="NAME" value="…"/>`,
 *   `<add key="NAME" value="…"/>`, and `{"NAME": {"value": "…"}}`.
 *
 * `open` is the start of the line of the last such name whose value can still
 * be to come after the text: a cut there leaves a value with no name above it.
 */
function valuesBelowNames(text: string): { spans: Span[]; open?: number } {
  const spans: Span[] = [];
  let open: number | undefined;
  const opened = (at: number): void => { open = Math.max(open ?? 0, text.lastIndexOf('\n', at - 1) + 1); };
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i].length + 1, i++) starts.push(at);
  for (let i = 0; i < lines.length; i++) {
    const opener = openerOf(lines[i]);
    if (!opener) continue;
    if (opener.block) {
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        const under = indentUnder(opener, line);
        const end = contentEnd(line);
        if (line.trim() === '' || (under && end <= under.at)) continue;
        if (!under || under.indent <= opener.pad) break;
        spans.push({ start: starts[j] + under.at, end: starts[j] + end });
      }
      if (j === lines.length) opened(starts[i]);
      // The block's lines are its value, not names of their own.
      i = j - 1;
      continue;
    }
    if (i + 1 >= lines.length || (i + 1 === lines.length - 1 && lines[i + 1] === '')) {
      opened(starts[i]);
      continue;
    }
    const line = lines[i + 1];
    const under = indentUnder(opener, line);
    if (!under || under.indent <= opener.pad) continue;
    const start = starts[i + 1] + under.at;
    const quoted = quotedAt(text, start);
    const value = quoted ?? { start, end: starts[i + 1] + contentEnd(line) };
    if (quoted || plainValueBelow(text.slice(value.start, value.end), opener.name)) spans.push(value);
  }
  for (const pattern of [NAMING_FIELD, NESTED_NAME]) {
    const names = new RegExp(pattern);
    for (let found = names.exec(text); found; found = names.exec(text)) {
      const name = found.groups?.name ?? '';
      if (!credentialNamed(name)) continue;
      const sibling = siblingValue(text, found.index, found.index + found[0].length, name);
      if (sibling === 'open') opened(found.index);
      else spans.push(...sibling);
    }
  }
  return { spans: shownSpans(text, spans), open };
}

/** The markdown quote opening the line at `lineStart`, or '' when it opens with none. */
function quoteAt(text: string, lineStart: number): string {
  QUOTE_PREFIX.lastIndex = lineStart;
  return QUOTE_PREFIX.test(text) ? text.slice(lineStart, QUOTE_PREFIX.lastIndex) : '';
}

/** How the lines of one entry open: a file viewer's gutter, then a quote, then their indentation past both. */
type Frame = { gutter: Gutter; quote: string; lead: number };

/** A gutter's mark after its number, `→`, `│`, `|` or `:`: not a quote's `>`, nor anything a line's content opens with. */
const GUTTER_MARK = /[^\s\w"'\x60\\<>{[(*#$-]/;

const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';

/** Where a gutter whose number ends at `end` of `prefix` ends: past its mark, or at the number, as `cat -n`'s tab is indentation. */
function gutterEndAfter(prefix: string, end: number): number {
  let mark = end;
  while (isPadding(prefix[mark])) mark++;
  const from = mark;
  while (mark < prefix.length && GUTTER_MARK.test(prefix[mark])) mark++;
  return mark > from ? mark : end;
}

/** The entry's frame with its gutter ending `end` characters into the line at `lineStart`. */
function frameAt(text: string, lineStart: number, end: number): Frame {
  const gutter = gutterOf(text.slice(lineStart, lineStart + end));
  const last = gutter.length - 1;
  const quoteStart = lineStart + end;
  const quote = quoteAt(text, quoteStart);
  let lead = quoteStart + quote.length;
  while (isPadding(text[lead])) lead++;
  return {
    // A gutter that ends at its number is followed by the indentation, not padding of its own.
    gutter: gutter[last] === '' && gutter[last - 1] === null ? gutter.slice(0, last) : gutter,
    quote,
    lead: lead - quoteStart - quote.length,
  };
}

/**
 * The frames the lines of the entry named at `at` can open with: a gutter
 * numbered with the line's last number before the name, or its first, then
 * none. A number can be the entry's own (`- id: 3, name: …`), so the line
 * below the name settles which holds (ADR-0061, G1).
 */
function framesOf(text: string, lineStart: number, at: number): Frame[] {
  const prefix = text.slice(lineStart, at);
  let last = prefix.length;
  while (last > 0 && !isDigit(prefix[last - 1])) last--;
  if (last === 0) return [frameAt(text, lineStart, 0)];
  let first = prefix.search(/\d/);
  while (isDigit(prefix[first])) first++;
  const ends = new Set([gutterEndAfter(prefix, last), gutterEndAfter(prefix, first), 0]);
  return [...ends].map((end) => frameAt(text, lineStart, end));
}

/** Where the line at `lineAt` starts past `frame`'s gutter and quote, or -1 when it opens with something else. */
function pastFrame(frame: Frame, text: string, lineAt: number): number {
  const past = pastGutter(frame.gutter, text, lineAt);
  return past >= 0 && text.startsWith(frame.quote, past) ? past + frame.quote.length : -1;
}

/**
 * The value of the `value` field beside the name found at `at`, read on from
 * `from`; 'open' when the text ends before the entry does. Only a `value`
 * after the name: an entry that gives its value first is not read. Each line
 * of the entry is read past the gutter and the quote the name's line opens
 * with, and must be indented as far past them as the name is.
 */
function siblingValue(text: string, at: number, from: number, name: string): Span[] | 'open' {
  const stops = new RegExp(SIBLING_STOP);
  stops.lastIndex = from;
  let lines = 0;
  let frames: Frame[] | undefined;
  for (let found = stops.exec(text); found; found = stops.exec(text)) {
    const field = found.groups?.field?.toLowerCase();
    if (field === 'value') {
      const valueAt = found.index + found[0].length;
      return valueAt >= text.length ? 'open' : valuesAt(text, valueAt, name, 'labelled');
    }
    if (field !== undefined || found[0] !== '\n' || ++lines > MAX_SIBLING_LINES) return [];
    const lineAt = found.index + 1;
    // Computed once a line is crossed: on one long line every name's search ends at the next name.
    frames ??= framesOf(text, text.lastIndexOf('\n', at - 1) + 1, at);
    if (frames.length > 1) frames = [frames.find((frame) => pastFrame(frame, text, lineAt) >= 0) ?? frames[frames.length - 1]];
    const frame = frames[0];
    // The entry's lines all open with its gutter and quote, whose `>` is no end of an element.
    const next = pastFrame(frame, text, lineAt);
    if (next < 0) return text.includes('\n', lineAt) ? [] : 'open';
    stops.lastIndex = next;
    NEXT_ENTRY.lastIndex = next;
    if (NEXT_ENTRY.test(text)) return [];
    let indent = next;
    while (isPadding(text[indent])) indent++;
    if (indent >= text.length) break;
    if (indent - next < frame.lead) return [];
  }
  return 'open';
}

/** `spans` in order, each overlap and empty span dropped, and none that is a marker already or a scheme word the scheme's rule takes with its token. */
function shownSpans(text: string, spans: Span[]): Span[] {
  const shown: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = shown[shown.length - 1];
    if (span.end <= span.start || (last && span.start < last.end)) continue;
    if (markerAt(text, span.start) || AUTH_SCHEME_WORD.test(text.slice(span.start, span.end))) continue;
    shown.push(span);
  }
  return shown;
}

/** Every value {@link valuesBelowNames} finds, as a marker. */
function redactValuesBelowNames(text: string): string {
  let out = '';
  let from = 0;
  for (const span of valuesBelowNames(text).spans) {
    out += text.slice(from, span.start) + marker('credential', span.end - span.start);
    from = span.end;
  }
  return out + text.slice(from);
}

/**
 * The earliest line a read that starts at `end`, a line start in `text`, must
 * be redacted with: an open key's BEGIN line, or the line of a credential name
 * whose value can still be below, as {@link valuesBelowNames} reads it. A read
 * from `end` has that value with no name above it (ADR-0061, C1).
 *
 * Read as agent text is, without its terminal escapes: a reset or an
 * erase-line after `-----BEGIN … KEY-----` is no body on its line.
 */
export function openValueStart(text: string, end: number): number | undefined {
  const head = text.slice(0, end);
  const { plain, at } = head.includes('\x1b') ? withoutEscapes(head) : { plain: head, at: undefined };
  const starts = [openPrivateKeyStart(plain), valuesBelowNames(plain).open].filter((start) => start !== undefined);
  if (starts.length === 0) return undefined;
  const open = Math.min(...starts);
  if (!at) return open;
  // An escape can open the line the value is named on: the line starts before it.
  return open >= at.length ? undefined : head.lastIndexOf('\n', at[open] - 1) + 1;
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
 * The part of a held value that is hidden on its own: the bar a redaction is
 * held to, as a cut, a stream split into deltas, or the runner's own slice
 * (`${TOKEN:0:12}`) can show part of a value without the rest.
 */
const HELD_PART = 8;
/** The chars a part still to come can have begun in: one short of a part. */
const HELD_TAIL = HELD_PART - 1;

/**
 * A terminal's escape sequences: CSI (colour, cursor), OSC (a title, a link)
 * and the charset and keypad selections. A coloured name is a name a reader
 * sees, so the rules read the text without them.
 *
 * Each is bounded, past any a terminal writes (a truecolor fg and bg SGR has
 * 33 param chars): a stream holds back an escape it ends inside, and an
 * unbounded one would let `ESC ]` and endless text hold back all that follows
 * (ADR-0061, H1). The CSI classes are disjoint, so what matches is decided
 * char by char, as the stream reads it.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE = /\x1b\[[0-?]{0,128}[ -/]{0,16}[@-~]|\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)?|\x1b[()][AB012]|\x1b[=>]/g;
const CSI_PARAMS = 128;
const CSI_INTERMEDIATES = 16;
const OSC_PAYLOAD = 4096;

/** `text` without terminal escapes, and where each of its characters sits in `text`. */
function withoutEscapes(text: string, escapes: Iterable<RegExpExecArray> = text.matchAll(TERMINAL_ESCAPE)): { plain: string; at: number[] } {
  const at: number[] = [];
  let plain = '';
  let from = 0;
  const take = (to: number): void => {
    for (let i = from; i < to; i++) at.push(i);
    plain += text.slice(from, to);
  };
  for (const escape of escapes) {
    take(escape.index);
    from = escape.index + escape[0].length;
  }
  take(text.length);
  return { plain, at };
}

/** What held values are matched by: see {@link heldParts}. */
interface HeldParts {
  /** Every {@link HELD_PART}-char part of a held value. A value is at least one part long, so its parts cover it whole. */
  parts: ReadonlySet<string>;
  /** Each part's first 1 to {@link HELD_TAIL} chars: what a part still to come can have begun as. */
  begun: ReadonlySet<string>;
}

const derivedParts = new WeakMap<object, { from: readonly string[]; derived: HeldParts }>();

/**
 * The parts of the values in `held`, derived once for as long as it holds
 * the same values: a stream asks on every write, and a key of a few thousand
 * chars has as many parts. Compared value by value, as a set that gains one
 * is the same object.
 */
function heldParts(held: Iterable<string>): HeldParts {
  const from = [...held];
  const cached = typeof held === 'object' ? derivedParts.get(held) : undefined;
  if (cached && cached.from.length === from.length && cached.from.every((value, i) => value === from[i])) return cached.derived;
  const parts = new Set<string>();
  const begun = new Set<string>();
  for (const value of new Set(from.map((v) => v.trim()))) {
    if (value.length < MIN_HELD_LENGTH) continue;
    for (let at = 0; at + HELD_PART <= value.length; at++) {
      const part = value.slice(at, at + HELD_PART);
      parts.add(part);
      for (let n = 1; n < HELD_PART; n++) begun.add(part.slice(0, n));
    }
  }
  const derived = { parts, begun };
  if (typeof held === 'object') derivedParts.set(held, { from, derived });
  return derived;
}

/**
 * Every held value in `text`, whole and in every part of {@link HELD_PART}
 * chars, each run of them as one marker (ADR-0061, H1). Matched exactly, not
 * by shape, so no rule's reading of the text decides it.
 *
 * Read twice: in its raw chars, where a value can sit in an escape's payload
 * (a title, a link) or start in an escape's last byte, and as a terminal shows
 * it, where a value can be coloured mid-value. An escape that holds a char of
 * a part goes with the marker, as do the escapes between the parts of a run:
 * an escape only after the run stays, so a reset still resets.
 *
 * A part of a wordy held value (`changeme-development`) is a word the text may
 * have anyway, and is hidden there too: the bar is that no part of what
 * Ordewell holds is shown, not that every word of the text stays.
 */
export function hideHeld(text: string, held: Iterable<string>): string {
  if (text.length < HELD_PART) return text;
  const { parts } = heldParts(held);
  if (parts.size === 0) return text;
  const hidden = new Uint8Array(text.length);
  let found = false;
  for (let at = 0; at + HELD_PART <= text.length; at++) {
    if (!parts.has(text.slice(at, at + HELD_PART))) continue;
    hidden.fill(1, at, at + HELD_PART);
    found = true;
  }
  const escapes = text.includes('\x1b') ? [...text.matchAll(TERMINAL_ESCAPE)] : [];
  if (escapes.length > 0) {
    const { plain, at } = withoutEscapes(text, escapes);
    for (let k = 0; k + HELD_PART <= plain.length; k++) {
      if (!parts.has(plain.slice(k, k + HELD_PART))) continue;
      for (let i = k; i < k + HELD_PART; i++) hidden[at[i]] = 1;
      found = true;
    }
  }
  if (!found) return text;
  // Read token by token, as heldStream does: an escape whole, or one char.
  let out = '';
  let from = 0;
  let chars = 0;
  let runEnd = -1;
  let next = 0;
  for (let i = 0; i < text.length; ) {
    const escape = escapes[next]?.index === i ? escapes[next++][0] : undefined;
    const end = i + (escape?.length ?? 1);
    let count = 0;
    for (let j = i; j < end; j++) count += hidden[j];
    if (count > 0) {
      if (runEnd < 0) out += text.slice(from, i);
      chars += count;
      runEnd = end;
    } else if (escape === undefined && runEnd >= 0) {
      out += marker('secret', chars);
      from = runEnd;
      runEnd = -1;
      chars = 0;
    }
    i = end;
  }
  if (runEnd >= 0) {
    out += marker('secret', chars);
    from = runEnd;
  }
  return out + text.slice(from);
}

/** A stream of text hidden as it arrives: see {@link heldStream}. */
export interface HeldStream {
  /** What is safe to show of `text`, read on from what was written before it. */
  write(text: string): string;
  /** The rest, `text` with it, once the stream has no more. */
  end(text?: string): string;
}

/** A token read and not yet shown: an escape whole, or one char of the text. */
interface Token {
  text: string;
  /** Where it ends in what the stream has read. */
  end: number;
  /** Its place among the chars a terminal shows, or -1 for an escape. */
  shown: number;
}

/** An escape still being read, as {@link TERMINAL_ESCAPE} reads it. */
type OpenEscape =
  | { kind: 'esc' | 'charset' }
  | { kind: 'csi'; params: number; intermediates: number }
  | { kind: 'osc'; payload: number; escaped: boolean };

const inRange = (c: string, low: number, high: number): boolean => c.charCodeAt(0) >= low && c.charCodeAt(0) <= high;

/**
 * A stream's text, hidden as it arrives (ADR-0061, H1): what it shows,
 * however it was split, is what {@link hideHeld} shows of the whole.
 *
 * It reads each char once. A token is shown once no part still to come can
 * reach it: a part can only have begun in the last {@link HELD_TAIL} chars,
 * read raw or as a terminal shows them, and only where they begin one. An
 * escape the text ends inside is held back until it ends, as until then its
 * bytes are not known to be no part of the text; escapes are bounded
 * ({@link TERMINAL_ESCAPE}), so that is bounded too. Text that can start no
 * part, a line's newline among it, is shown at once: a script that prints
 * `ready` and waits is not kept waiting.
 *
 * A run of held text that reaches what is shown can still grow, so it is
 * kept as its length alone, and the escapes after it, until a char that is no
 * part of it: it becomes one marker however the stream was split.
 *
 * `held` is read on each write: a value held after the stream started is
 * hidden from then on.
 */
export function heldStream(held: Iterable<string>): HeldStream {
  let parts: ReadonlySet<string> = new Set();
  /** Chars read, raw, and the last {@link HELD_PART} of them. */
  let read = 0;
  let readTail = '';
  /** Chars a terminal shows, the last {@link HELD_PART} of them, and where each sits in what was read. */
  let shown = 0;
  let shownTail = '';
  let shownAt: number[] = [];
  /** For each char read and not yet let go, whether a part holds it; `hid[0]` is char `hidFrom`. */
  let hid: number[] = [];
  let hidFrom = 0;
  /** Where the tokens let go end: no part can reach before it. */
  let released = 0;
  let tokens: Token[] = [];
  let first = 0;
  let escape: OpenEscape | null = null;
  let escapeText = '';
  /** The run of hidden chars let go and not yet shown, and the escapes since its last part. */
  let run = 0;
  let gap = '';
  let out = '';

  const mark = (at: number): void => {
    if (at >= released) hid[at - hidFrom] = 1;
  };

  const take = (token: Token): void => {
    tokens.push(token);
  };

  const takeShown = (c: string, at: number): void => {
    shownTail = (shownTail + c).slice(-HELD_PART);
    shownAt.push(at);
    if (shownAt.length > HELD_PART) shownAt.shift();
    if (shownTail.length === HELD_PART && parts.has(shownTail)) for (const i of shownAt) mark(i);
    take({ text: c, end: at + 1, shown: shown++ });
  };

  /** An escape that turned out to be none: its chars are text, and `c`, at `at`, is read afresh. */
  const unescape = (c: string, at: number): void => {
    const from = at - escapeText.length;
    const chars = escapeText;
    escape = null;
    escapeText = '';
    for (let k = 0; k < chars.length; k++) takeShown(chars[k], from + k);
    tokenize(c, at);
  };

  const closeEscape = (end: number): void => {
    take({ text: escapeText, end, shown: -1 });
    escape = null;
    escapeText = '';
  };

  const tokenize = (c: string, at: number): void => {
    if (escape === null) {
      if (c === '\x1b') {
        escape = { kind: 'esc' };
        escapeText = c;
      } else {
        takeShown(c, at);
      }
      return;
    }
    switch (escape.kind) {
      case 'esc':
        if (c === '[') escape = { kind: 'csi', params: 0, intermediates: 0 };
        else if (c === ']') escape = { kind: 'osc', payload: 0, escaped: false };
        else if (c === '(' || c === ')') escape = { kind: 'charset' };
        else if (c !== '=' && c !== '>') return unescape(c, at);
        escapeText += c;
        if (c === '=' || c === '>') closeEscape(at + 1);
        return;
      case 'charset':
        if (!'AB012'.includes(c)) return unescape(c, at);
        escapeText += c;
        return closeEscape(at + 1);
      case 'csi':
        if (inRange(c, 0x30, 0x3f) && escape.intermediates === 0 && escape.params < CSI_PARAMS) escape.params++;
        else if (inRange(c, 0x20, 0x2f) && escape.intermediates < CSI_INTERMEDIATES) escape.intermediates++;
        else if (!inRange(c, 0x40, 0x7e)) return unescape(c, at);
        escapeText += c;
        if (inRange(c, 0x40, 0x7e)) closeEscape(at + 1);
        return;
      case 'osc':
        if (escape.escaped) {
          if (c === '\\') {
            escapeText += c;
            return closeEscape(at + 1);
          }
          // The payload ended before an ESC that is no terminator: it starts what follows.
          escapeText = escapeText.slice(0, -1);
          closeEscape(at - 1);
          tokenize('\x1b', at - 1);
          return tokenize(c, at);
        }
        if (c === '\x07') {
          escapeText += c;
          return closeEscape(at + 1);
        }
        if (c === '\x1b') escape.escaped = true;
        else if (escape.payload < OSC_PAYLOAD) escape.payload++;
        else {
          closeEscape(at);
          return tokenize(c, at);
        }
        escapeText += c;
        return;
    }
  };

  /** Where a part still to come can start, in `tail`, the last chars of `length`: past them when nothing there begins one. */
  const frontier = (tail: string, length: number, begun: ReadonlySet<string>): number => {
    for (let n = Math.min(HELD_TAIL, tail.length); n > 0; n--) if (begun.has(tail.slice(-n))) return length - n;
    return length;
  };

  /** Show the tokens no part still to come can reach: all of them once the stream has ended. */
  const release = (readFrom: number, shownFrom: number): void => {
    while (first < tokens.length) {
      const token = tokens[first];
      if (token.end > readFrom || token.shown >= shownFrom) break;
      first++;
      let count = 0;
      for (let at = token.end - token.text.length; at < token.end; at++) count += hid[at - hidFrom] ?? 0;
      released = token.end;
      if (count > 0) {
        run += count;
        gap = '';
      } else if (run === 0) {
        out += token.text;
      } else if (token.shown < 0) {
        gap += token.text;
      } else {
        out += marker('secret', run) + gap + token.text;
        run = 0;
        gap = '';
      }
    }
    // Let go of what is shown, now and then rather than on each token, so a long stream is read once.
    if (first > 1024 && first * 2 > tokens.length) {
      tokens = tokens.slice(first);
      first = 0;
    }
    if (released - hidFrom > 1024 && (released - hidFrom) * 2 > hid.length) {
      hid = hid.slice(released - hidFrom);
      hidFrom = released;
    }
  };

  const write = (text: string): string => {
    const derived = heldParts(held);
    parts = derived.parts;
    if (parts.size === 0 && escape === null && first === tokens.length && run === 0) {
      // Nothing held, nothing held back: a value held later is read from where it starts.
      readTail = '';
      shownTail = '';
      shownAt = [];
      return text;
    }
    for (let k = 0; k < text.length; k++) {
      const at = read++;
      hid.push(0);
      readTail = (readTail + text[k]).slice(-HELD_PART);
      if (readTail.length === HELD_PART && parts.has(readTail)) for (let i = at - HELD_TAIL; i <= at; i++) mark(i);
      tokenize(text[k], at);
    }
    release(frontier(readTail, read, derived.begun), frontier(shownTail, shown, derived.begun));
    const shownNow = out;
    out = '';
    return shownNow;
  };

  const end = (text = ''): string => {
    let shownNow = write(text);
    if (escape !== null) {
      // An escape the text ends inside: an OSC ends with it, any other is text.
      if (escape.kind === 'osc') {
        const escaped = escape.escaped;
        if (escaped) escapeText = escapeText.slice(0, -1);
        closeEscape(read - (escaped ? 1 : 0));
        if (escaped) takeShown('\x1b', read - 1);
      } else {
        const from = read - escapeText.length;
        const chars = escapeText;
        escape = null;
        escapeText = '';
        for (let k = 0; k < chars.length; k++) takeShown(chars[k], from + k);
      }
    }
    release(Infinity, Infinity);
    if (run > 0) out += marker('secret', run) + gap;
    shownNow += out;
    read = 0;
    readTail = '';
    shown = 0;
    shownTail = '';
    shownAt = [];
    hid = [];
    hidFrom = 0;
    released = 0;
    tokens = [];
    first = 0;
    run = 0;
    gap = '';
    out = '';
    return shownNow;
  };

  return { write, end };
}

/** Text as a terminal shows it, its escapes dropped: what agent text is redacted as. */
export function withoutTerminalEscapes(text: string): string {
  return text.includes('\x1b') ? text.replace(TERMINAL_ESCAPE, '') : text;
}

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

  // Agent text is read as a terminal shows it: a coloured name is still a name.
  let out = hideHeld(agentText ? withoutTerminalEscapes(text) : text, held);

  out = redactPrivateKeyBlocks(out);

  if (agentText) out = redactCredentialNamedValues(redactValuesBelowNames(out));

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
