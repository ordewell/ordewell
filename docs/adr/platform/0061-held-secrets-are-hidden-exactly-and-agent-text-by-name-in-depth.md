---
status: accepted
---

# 0061 — Held secrets are hidden exactly at every sink; agent text is redacted by name as defence in depth

## Problem

Ordewell hands a task attempt's runner secrets of its own: the attempt's MCP
token, the credentials in the runner's spawn env, and the provider keys and
headers it holds for it. Whatever the runner then writes can quote them. A CLI
dumps its settings, an agent echoes its environment, and a stack trace prints
a header. That text reaches many sinks:

- the *TaskOutputSource*'s live buffer and an ended attempt's tail;
- the task log;
- the handoff and the report the planner reads;
- a stderr tail in a start error;
- a *Script task*'s logged output and saved file.

Redaction used to read runner text only by credential name and value shape, at
each sink, and after that sink had cut the text to its bound. Review of #76
showed what that leaves open:

- A held value with no credential name beside it showed in full.
- A cut could separate a private key's BEGIN line from its body, or a name from
  the value on the lines below it. The part kept then matched no rule.
- A file viewer's line numbers and a terminal's colour escapes broke the anchors
  the rules read.
- A run of everyday name forms slipped past: `:=`, markdown emphasis,
  `{name, value}` pairs, `setx` and YAML block values.

## Decision

**What Ordewell guarantees of runner text: held values are exact and cut-, colour- and gutter-safe; name-based redaction of agent text is defence in depth over a documented list of forms, and a bare unlabelled secret that Ordewell does not hold cannot be recognised.**

Each runner session owns one `HeldSecrets` (`AbstractRunnerSession.secrets`)
for its whole life, respawns included. What Ordewell hands the runner is held
as it is handed:

- the token when it is issued;
- the spawn env's credentials before the process exists, and again for a lease
  placement's env;
- the headers the process withholds.

The session hides what it holds in everything the runner writes before any
sink sees it: plain output, events, the completion report, and why a start
failed. Every reader of the session's output, the output source among them,
redacts with the same record. No sink is handed the values separately.

## Key properties

- **Held values are exact, at every sink (H1).**
  - A held value is matched as the literal string it is, not by its shape.
  - Every part of it of eight characters or more is hidden as well, and a run
    of held text becomes one marker.
  - A part is looked for in the text as written and in the text with its
    terminal escapes read through. An escape whose bytes hold or end a part, a
    window title's OSC payload among them, is hidden with it, and an escape
    inside a run of held text goes into the run's marker.
  - A value too short to tell from a word is not held.
  - Text that arrives in pieces is read on from the piece before it, in one
    pass. The pieces may be a model's deltas, a script's pipe chunks, or the
    lines a session's text channel writes as its runs take turns. Its last few
    characters are held back only while they could still begin a part of a held
    value, as is an escape still open at the end. A run of held text that
    reaches the end is held back whole. Text that can begin no part, a line's
    newline among it, is shown at once. What is held back is written out before
    the turn's end or the session's exit is told.
  - An error from a failed start keeps its class, with its message and stack
    hidden.
- **A cut never makes a secret readable (C1).** A cut that drops the start of a
  value known only by a line above it keeps that line as the buffer's hidden
  head. The value may be a private key's body, a YAML block or a next-line value
  under a credential name, or a sibling `value:` under its `name:`. Redaction
  reads the head together with what remains, and drops it from what it shows.
  A read that resumes inside such a value reads from the line that opens it.
  This holds at each cut that bounds runner output: the live buffer, an ended
  attempt's 16k tail, and a `LineTail`. A trim is a cut as well, so a read is
  trimmed only after it is redacted.
- **Gutters and colour are read through (G1).**
  - A key block's gutter is taken from its BEGIN or END line, with the digits
    generalised, and is stripped from each of the block's lines.
  - A sibling `value:` is matched to its `name:` by the indentation after each
    line's gutter and quote marker, so a gutter's width is not read as nesting.
  - A block never closes as `0 chars` while body-shaped lines follow it.
  - Agent text is redacted with its terminal escapes (CSI, OSC and the charset
    selections) removed, including in `LineTail`'s read.
  - An escape is read only to a bound: a CSI of up to 128 parameter and 16
    intermediate bytes, an OSC payload of up to 4096 characters. Past the bound
    its bytes are plain text, so an escape that never closes holds nothing back
    for long and costs no more to read than its bound.
- **Names, in a documented list of forms (N1).** A value is redacted when a
  credential name labels it in one of the forms below, and when its shape
  passes the form's test. A form not in the list is not covered.

## The forms N1 reads

| Form | Examples |
|---|---|
| Assignment, any quoting or escaping, in emphasis | `KEY=v`, `"key": "v"`, `NAME := v`, `::=` `?=` `+=`, `**NAME**: v` |
| A comparison or pointer, only for a key's shape | `NAME != v`, `NAME -> v` |
| A long flag | `--api-key v`, `--token=v` |
| A table row or an element | `\| GITHUB_TOKEN \| v \|`, `<password>v</password>` |
| A quoted subscript or call argument | `os.environ["GITHUB_TOKEN"] = "v"`, `setHeader('api-key', 'v')` |
| A command that sets a name | `setx NAME v`, Dockerfile `ENV NAME v`, `set -gx NAME v`, `gh secret set NAME --body v` |
| A naming field with its sibling value | JSON and ACP `{"name": "NAME", "value": "v"}`, YAML `- name: NAME` / `value: v`, XML `name="NAME" value="v"` |
| A value below its name | YAML `NAME: \|` with its block, `NAME:` with the value on the next line |
| An auth scheme, a provider's or cloud's key shape, a private key block | `Bearer v`, `sk-…`, `AKIA…`, `-----BEGIN … PRIVATE KEY-----` |

## Testing decisions

- **A cut is tested at every offset.** `redactionAtEveryCut.test.ts` redacts
  each case whole as the control. It then moves each cut site over every offset
  of the case and asserts that no eight-character part of the secret shows.
  Copy it for a new cut site or a new value-below-a-line form.
- **A held value is tested through a real session.** The value is fake and has
  no rule's shape, so only the held record can hide it. It goes through a
  `StructuredRunner` on a real MCP server, its listener alone stubbed, and
  through a `ScriptRunner` step that prints it in chunks. The assertions cover
  every sink and the exact text shown around it.
- **The bar is an eight-character part of the secret.** A form test also keeps
  its controls, the text that must stay unchanged. Every adversarial input of
  64k characters must finish under 1 s in both modes.

## Out of scope

- A secret Ordewell never held that has no credential name and no known shape.
- A runner's own transcript files and PTY, which are not runner text that
  Ordewell keeps.

## Considered options

- **Hand each sink the held values as a parameter.** Rejected: each sink would
  have to be found and threaded, and a sink added later would be left out.
  One record per session that every reader shares makes the seam the session.
- **Redact at each sink after its cut (the design until 2026-11-05).** Rejected:
  a cut can separate a value from the line that names it, and no rule can then
  find it. Redacting whole first and then cutting is safe only when the cut is
  redacted with the line it dropped, so the cut keeps that line hidden.
- **Hold back a fixed seven-character tail of every stream.** Rejected: a script
  that prints a line and then waits would have the line kept from its reader
  until the step ends. The hold-back takes only what can still begin a part of
  a held value.
- **Recognise any long, high-entropy string as a secret.** Rejected: commit
  SHAs, content hashes, base64 data and build IDs have the same shape. The
  planner would lose the output it reasons on, and still could not tell a
  secret from a hash.

## Consequences

- A held value that reads as words is hidden wherever any eight-character part
  of it appears.
- Prose of letters only that follows a truncated key block is redacted as body.
- A pause right after a possible part of a held value delays that part until
  more text arrives or the pipe ends.
- A line too long for the buffer stands as a note, and the note closes an open
  block.
- A fragment of fewer than eight characters can show where one stream gives way
  to another, as where a turn ends inside a value.
- Some sibling forms are not covered:
  - a reversed `{value, name}` order;
  - a sibling `value:` given as a block or on the next line;
  - a nested mapping under a name;
  - more than the first line of a next-line plain scalar.
- A `value:` field between a name and its value can be redacted as well.
- A `{` inside a string between a name and its value stops the scan.
- `null` and numbers under a credential name are redacted.

## History

- 2026-11-05 — accepted.
- 2026-11-05 — parts are found inside escapes and through them, escapes are read to a bound, the text channel is one stream, sibling values are read past the gutter, and a read is trimmed after it is redacted.
