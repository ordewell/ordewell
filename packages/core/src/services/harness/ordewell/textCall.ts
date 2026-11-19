/**
 * Finds a tool call a model wrote out as text instead of making through the
 * tool-calling interface (ADR-0070): a `<tool_call>` block, as models whose
 * tool channel failed fall back to, naming a tool the request offered.
 *
 * The rule is narrow on purpose, since a false hit makes the runner answer a
 * finished reply: code (fenced or inline) is dropped first, so a reply that
 * quotes the syntax is left alone; the tag must open its own line, so one
 * mentioned mid-sentence is too; and the body must begin with a JSON object
 * whose "name" is an offered tool, so the bare tag in prose names none. The body
 * is not parsed whole, as a call cut short or badly escaped is still one.
 */
const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|$)|$)/gm;
// A span may wrap lines but not cross a blank one, so a stray backtick cannot swallow the rest of the reply.
const INLINE = /`(?:[^`\n]|\n(?![ \t]*\n))*`/g;
const BLOCK = /^[ \t]*<(?:tool_call|function_call)>\s*\{\s*"name"\s*:\s*"([^"\\]*)"/gm;

export function writtenToolCall(text: string, offered: ReadonlySet<string>): string | undefined {
  if (!text.includes('<')) return undefined;
  const prose = text.replace(FENCED, '').replace(INLINE, '');
  for (const match of prose.matchAll(BLOCK)) {
    const name = match[1] as string;
    if (offered.has(name)) return name;
  }
  return undefined;
}
