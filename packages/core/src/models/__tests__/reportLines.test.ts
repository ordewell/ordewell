import { describe, expect, it } from 'vitest';
import {
  boundedHandoffLines, handoffDigest, handoffLines, handoffPreviewLines, handoffReferenceText, handoffWakeLines, heldHandoff, patchLines, storedHandoff,
  type HandoffEvidence, type HandoffFinding, type HandoffPatch, type StoredHandoff, type SubtreeReport,
} from '../Handoff';
import { onOneLine, quotedLine, splitLines } from '../lineBreaks';
import { capConflictFiles } from '../../services/conflictFiles';
import { subtreeView } from '../../taskRow/delegated';

/*
 * No text an author or a branch chose may start a line of Ordewell's
 * (ADR-0057 R3), so this renders a whole report with a line break in every field
 * that holds one, for every break a reader could honour.
 */

const BREAKS = ['\n', '\r', '\r\n', '\v', '\f', String.fromCharCode(0x85), String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/** What follows a break in a field of one line: it may start no line, however far indented. */
const VALUE = 'FORGED-VALUE';
/** What follows a break in a field of many lines: it may start only a line that is held. */
const WORDS = 'FORGED-WORDS';

function whole(br: string): StoredHandoff {
  const value = `src/a.ts${br}${VALUE}`;
  const words = `Fine.${br}${WORDS}`;
  const evidence: HandoffEvidence[] = [
    { kind: 'file', path: value, line: 4 },
    { kind: 'file', path: value },
    { kind: 'commit', sha: 'abc1234', repo: value },
    { kind: 'url', url: `https://example.com/${br}${VALUE}` },
    { kind: 'task', node: 'root/1', task: value, label: value, finding: 'F1' },
  ];
  const finding: HandoffFinding = { id: 'F1', severity: 'major', title: value, detail: words, evidence };
  const patch: HandoffPatch = {
    kind: 'patch', path: '.ordewell/1.patch', attempt: 1, base: 'abc1234', files: 1, added: 1, removed: 0, binary: 0, bytes: 10, sha256: 'x',
    flags: [{ kind: 'excluded', count: 2, paths: [value] }],
  };
  return {
    commit: { subject: value, body: words },
    summary: words,
    findings: [finding],
    findingCount: 1,
    artifacts: [...evidence, patch],
    report: words,
  };
}

const subtreeOf = (br: string): SubtreeReport => ({
  node: 'root/1',
  counts: { done: 1, failed: 0, blocked: 0, skipped: 0, commits: 1, tokens: 10 },
  findings: { blocker: 0, major: 1, minor: 0, info: 0 },
  open: whole(br).findings.map((finding) => ({ ref: { kind: 'task', node: 'root/1', task: 'a', label: '#1', attempt: 1, finding: 'F1' }, finding })),
  promoted: whole(br).findings.map((finding) => ({ finding: { ...finding, id: 'F2' } })),
  outsideScope: { paths: [`src/a.ts${br}${VALUE}`], count: 3 },
});

/** Every text the report reaches a reader as. */
function rendered(handoff: StoredHandoff): string[] {
  const digest = handoffDigest(handoff);
  return [
    boundedHandoffLines(digest, (more) => `+${more} more`).join('\n'),
    handoffWakeLines(digest).join('\n'),
    handoffLines(handoff).join('\n'),
    handoffPreviewLines(digest).join('\n'),
  ];
}

const startingWith = (text: string, what: string, trim: boolean) => splitLines(text).filter((line) => (trim ? line.trimStart() : line).startsWith(what));

describe.each(BREAKS.map((br) => [JSON.stringify(br), br]))('a report with a line break %s in every field', (_name, br) => {
  it("keeps every path and title on its line, and every line of a delegated task's words held", () => {
    const report = { ...whole(br), subtree: subtreeOf(br) };
    for (const text of rendered(report)) {
      expect(startingWith(text, VALUE, true)).toEqual([]);
      expect(startingWith(text, WORDS, false)).toEqual([]);
    }
  });

  it('holds them the same with no subtree to say whose they are', () => {
    for (const text of rendered(heldHandoff({ type: 'delegated' }, whole(br)))) {
      expect(startingWith(text, VALUE, true)).toEqual([]);
      expect(startingWith(text, WORDS, false)).toEqual([]);
    }
  });

  it("keeps a path on its line in any task's references", () => {
    const { findings, artifacts } = whole(br);
    for (const reference of [...findings[0].evidence ?? [], ...artifacts ?? []]) {
      expect(splitLines(handoffReferenceText(reference))).toHaveLength(1);
    }
    expect(startingWith(patchLines(artifacts!.at(-1) as HandoffPatch).join('\n'), VALUE, true)).toEqual([]);
  });

  it('keeps every surface text of a subtree on one line', () => {
    const view = subtreeView(subtreeOf(br));
    const shown = [view.summary, view.outsideScope ?? '', ...[...view.open, ...view.promoted].flatMap((item) => [item.heading, item.reference ?? ''])];
    for (const text of shown) expect(splitLines(text)).toHaveLength(1);
  });

  it('keeps a changed file on one line in a notice', () => {
    expect(splitLines(capConflictFiles([`a${br}${VALUE}`, 'b']))).toHaveLength(1);
  });

  it('stays readable, and stays the same text under a quote', () => {
    const quoted = quotedLine(`a${br}b`);
    expect(splitLines(quoted)).toHaveLength(1);
    expect(JSON.parse(quoted)).toBe(`a${br}b`);
    expect(onOneLine(`a${br}b`)).toBe(quoted);
  });
});

describe('a path with no line break', () => {
  it('reads as it always did', () => {
    expect(onOneLine('src/a b.ts')).toBe('src/a b.ts');
    expect(handoffReferenceText({ kind: 'file', path: 'src/a.ts', line: 4, resolved: true })).toBe('src/a.ts:4');
  });
});

describe("a delegated task's handoff with no report", () => {
  it('is marked, and an ordinary task\'s is not', () => {
    const handoff = storedHandoff({ summary: 'Done.' })!;
    expect(heldHandoff({ type: 'delegated' }, handoff).held).toBe(true);
    expect(heldHandoff({ type: 'ai' }, handoff).held).toBeUndefined();
    expect(heldHandoff({ type: 'delegated' }, { ...handoff, subtree: subtreeOf('\n') }).held).toBeUndefined();
  });
});
