/**
 * Finds a tool call a model wrote out as text instead of making through the
 * tool-calling interface (ADR-0070): the one detector behind the built-in
 * runner's turns and the API planner's, so a reply is judged the same way
 * wherever a tool is offered. Models whose tool channel failed, or that were
 * trained on another vendor's call syntax, fall back to a few shapes: a
 * `<tool_call>` block with a JSON body, an `<invoke name="…">` block (bare,
 * inside `<function_calls>`, or DeepSeek's `<｜DSML｜ invoke …>`), and a JSON
 * object that is the whole reply.
 *
 * The rule is narrow on purpose, since a false hit answers a finished reply:
 * code (fenced or inline) is dropped first, so a reply that quotes the syntax
 * is left alone; a tag must open its own line, so one mentioned mid-sentence or
 * quoted is too; and every shape must name a tool the request offered, so the
 * bare tag in prose names none. A JSON object counts only as the whole reply
 * (alone or in one fence), since one inside an answer is a sample or a quoted
 * earlier call. A body is not parsed whole, as a call cut short or badly
 * escaped is still one.
 */
// A fence left open runs to the end of the reply: `(?![\s\S])`, since `$` under the m flag would close it at its first line's end.
const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|$)|(?![\s\S]))/gm;
// A span may wrap lines but not cross a blank one, so a stray backtick cannot swallow the rest of the reply.
const INLINE = /`(?:[^`\n]|\n(?![ \t]*\n))*`/g;
const BLOCK = /^[ \t]*<(?:tool_call|function_call)>\s*\{\s*"name"\s*:\s*"([^"\\]*)"/gm;
// A vendor's tag prefix: DeepSeek's `｜DSML｜` (full-width or ASCII bars, then optional space) or an XML namespace.
const PREFIX = String.raw`(?:[｜|]DSML[｜|]\s*|\w+:)?`;
const INVOKE = new RegExp(
  String.raw`^[ \t]*(?:<${PREFIX}(?:function_calls|tool_calls)>\s*)?<${PREFIX}invoke\s+name\s*=\s*["']([^"'\\]+)["']`,
  'gm',
);
const WHOLE_FENCE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1[`~]*$/;
// `{"name": "X", …`, alone or inside OpenAI's `tool_calls` / `function` wrappers.
const JSON_CALL = /^\{\s*(?:"(?:tool_calls?|function_call)"\s*:\s*\[?\s*\{\s*)?(?:"type"\s*:\s*"function"\s*,\s*)?(?:"function"\s*:\s*\{\s*)?"(?:name|tool|tool_name)"\s*:\s*"([^"\\]*)"/;
// What makes `{"name": …}` a call and not a record that has a name.
const JSON_ARGUMENTS = /"(?:arguments|args|parameters|input)"\s*:/;

function writtenJsonCall(text: string): string | undefined {
  const trimmed = text.trim();
  const body = WHOLE_FENCE.exec(trimmed)?.[2]?.trim() ?? trimmed;
  const name = JSON_CALL.exec(body)?.[1];
  return name !== undefined && JSON_ARGUMENTS.test(body) ? name : undefined;
}

export function writtenToolCall(text: string, offered: ReadonlySet<string>): string | undefined {
  const json = text.includes('{') ? writtenJsonCall(text) : undefined;
  if (json !== undefined && offered.has(json)) return json;
  if (!text.includes('<')) return undefined;
  const prose = text.replace(FENCED, '').replace(INLINE, '');
  for (const pattern of [BLOCK, INVOKE]) {
    for (const match of prose.matchAll(pattern)) {
      const name = match[1] as string;
      if (offered.has(name)) return name;
    }
  }
  return undefined;
}
