#!/usr/bin/env node
// Keeps docs/adr honest. Source comments and other docs cite ADRs by number
// ("ADR-0018") and even by rule ("ADR-0023 F1"), so a move, a merge or a
// reorder can orphan a citation without any test noticing. This fails when a
// citation stops resolving, and checks the layout and shape docs/adr/README.md
// promises.
//
//   node scripts/verify-adr.mjs            verify (CI runs every scripts/verify-*.mjs)
//   node scripts/verify-adr.mjs --write    also regenerate the index in docs/adr/README.md
//   node scripts/verify-adr.mjs --next     print the next free ADR number
//   node scripts/verify-adr.mjs --strict   treat warnings as failures

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adrDir = 'docs/adr';
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');

// The single source for the folder list; the README index is generated from it.
const FOLDERS = {
  planner: 'the planner conversation, its harness backends, its research and its skills',
  'planner-envelope': 'what the planner may run, read and reach, and the sandbox under it',
  routing: 'modes, models and runner discovery',
  runners: 'how runners are driven, messaged and given Ordewell tools',
  isolation: 'worktrees, repo groups, conflicts, ops tasks and merge gates',
  supervision: 'the supervisor, run settings, failure policy, consent and research tasks',
  surfaces: 'the TUI and the shared conversation view',
  platform: 'Windows, the per-workspace environment and what Ordewell sends from the machine',
};

// Level-2 headings, in order. Any other level-2 heading is a topic section:
// design detail too long for Key properties, kept between it and the closing
// sections.
const SECTION_ORDER = ['Problem', 'Decision', 'Key properties', null, 'Testing decisions', 'Out of scope', 'Considered options', 'Consequences', 'History'];
const RANK = new Map(SECTION_ORDER.map((name, i) => [name, i]).filter(([name]) => name));
const TOPIC_RANK = SECTION_ORDER.indexOf(null);
const RENAMED = { Context: 'Problem', Rejected: 'Considered options', Alternatives: 'Considered options', 'Alternatives considered': 'Considered options' };
const STATUSES = ['proposed', 'accepted', 'superseded'];
const IMPLEMENTED = ['full', 'partial', 'none'];
const FRONT_MATTER_KEYS = new Set(['status', 'implemented', 'amends', 'supersedes', 'folds', 'note']);
// An amendment patched into a body paragraph instead of rewriting it: a lead
// like "*Amended 2026-08-11.*", an inline "*Amended by ADR-0030:*", or a dated
// italic line. History is where dates belong.
const AMENDMENT_LEAD = /^\s*[*_]{1,2}\(?(Amended|Superseded by|Added by|Updated|Changed|Extended|Replaced)\b/;
const AMENDMENT_INLINE = /[*_]\(?(Amended|Superseded by|Added by|Updated)\b/;
const AMENDMENT_DATED = /^\s*[*_]{1,2}\(?20\d\d-\d\d-\d\d/;

const problems = [];
const fail = (where, message) => problems.push({ level: 'FAIL', where, message });
const warn = (where, message) => problems.push({ level: strict ? 'FAIL' : 'warn', where, message });

const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
// Untracked files count too, so the check works before `git add`. A conflicted
// file is listed once per stage, and read once it would count as several ADRs.
const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0'))]
  .filter(Boolean)
  .filter((p) => fs.existsSync(path.join(root, p)));
// A Windows checkout under core.autocrlf has CRLF endings, and every rule below
// reads LF: the front matter alone failed in every ADR.
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const isTextFile = (p) => !/\.(png|jpe?g|gif|ico|webp|vsix|woff2?|ttf|zip|gz)$/i.test(p) && !/(^|\/)package-lock\.json$/.test(p);

// ---------------------------------------------------------------- front matter

// A deliberately small YAML subset, so the script needs no dependency:
// `key: value`, `key: ["a", "b"]`, and `key:` followed by `  - item` lines.
function parseFrontMatter(lines, where) {
  const fm = {};
  let listKey = null;
  lines.forEach((raw, i) => {
    const at = `${where}:${i + 2}`;
    if (!raw.trim()) return;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { fm[listKey].push(scalar(item[1], at)); return; }
    const kv = raw.match(/^([a-z]+):\s*(.*)$/);
    if (!kv) { fail(at, `front matter line is not \`key: value\`: ${raw.trim()}`); return; }
    const [, key, value] = kv;
    if (!FRONT_MATTER_KEYS.has(key)) fail(at, `unknown front matter key \`${key}\``);
    listKey = null;
    if (value === '') { fm[key] = []; listKey = key; }
    else if (value.startsWith('[')) {
      const inner = value.replace(/^\[|\]$/g, '').trim();
      fm[key] = inner ? inner.split(',').map((s) => scalar(s.trim(), at)) : [];
    } else fm[key] = scalar(value, at);
  });
  return fm;
}

function scalar(text, where) {
  if (!text.startsWith('"')) return text;
  try { return JSON.parse(text); } catch { fail(where, `unparseable quoted value ${text}`); return text; }
}

// ------------------------------------------------------------------- the ADRs

const adrPaths = files.filter((p) => p.startsWith(`${adrDir}/`) && p !== `${adrDir}/README.md`);
const docs = [];
for (const p of adrPaths) {
  const m = p.match(/^docs\/adr\/([a-z-]+)\/(\d{4})-[a-z0-9-]+\.md$/);
  if (!m) { fail(p, 'an ADR lives at docs/adr/<folder>/NNNN-slug.md'); continue; }
  if (!FOLDERS[m[1]]) { fail(p, `unknown folder \`${m[1]}\` (known: ${Object.keys(FOLDERS).join(', ')})`); continue; }
  docs.push(parseDoc(p, m[1], m[2]));
}

function addRuleIds(set, text) {
  for (const range of text.matchAll(/\b([A-Z])(\d{1,2})\s*[–-]\s*\1(\d{1,2})\b/g)) {
    for (let n = Number(range[2]); n <= Number(range[3]); n++) set.add(`${range[1]}${n}`);
  }
  for (const id of text.matchAll(/\b[A-Z]\d{1,2}\b/g)) set.add(id[0]);
}

function parseDoc(p, folder, num) {
  const lines = read(p).split('\n');
  const doc = { path: p, folder, num, fm: null, title: '', h2: [], headings: [], defined: new Set(), pending: [], markers: [] };
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) fail(`${p}:1`, 'front matter is not closed');
    else { doc.fm = parseFrontMatter(lines.slice(1, end), p); i = end + 1; }
  } else fail(`${p}:1`, 'missing front matter');
  while (i < lines.length && !lines[i].trim()) i += 1;
  const h1 = (lines[i] ?? '').match(/^# (\d{4}) — (.+)$/);
  if (!h1) fail(`${p}:${i + 1}`, 'the title is `# NNNN — Title`');
  else if (h1[1] !== num) fail(`${p}:${i + 1}`, `the title says ${h1[1]}, the file name says ${num}`);
  else doc.title = h1[2];

  let fence = false;
  let section = '';
  let pendingFrom = -1;
  const body = [];
  for (let n = i + 1; n < lines.length; n++) {
    const line = lines[n];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    body.push(line);
    const h = line.match(/^(#{1,6}) +(.*?)\s*$/);
    if (h) {
      doc.headings.push({ level: h[1].length, text: h[2], line: n + 1 });
      if (h[1].length === 2) { section = h[2]; doc.h2.push({ name: h[2], line: n + 1 }); }
    }
    if (/^\*Pending:\*/.test(line)) pendingFrom = n;
    if (pendingFrom >= 0 && !line.trim()) pendingFrom = -1;
    if (pendingFrom >= 0) for (const r of line.matchAll(/ADR-(\d{4})/g)) doc.pending.push(r[1]);
    if (section !== 'History' && (AMENDMENT_LEAD.test(line) || AMENDMENT_INLINE.test(line) || AMENDMENT_DATED.test(line))) doc.markers.push(n + 1);
  }
  // A rule is defined by a parenthesised ID in a bold lead: "**Surfaces (V1, #57).**".
  // The lead may wrap across lines and hold *italics*, so scan the whole body,
  // minus inline code (a glob like `src/**/*.ts` would otherwise unpair every
  // bold span after it).
  const prose = body.map((l) => l.replace(/`[^`\n]*`/g, '')).join('\n');
  for (const span of prose.matchAll(/\*\*((?:(?!\n\n)[\s\S]){1,300}?)\*\*/g)) {
    for (const group of span[1].matchAll(/\(([^()]*)\)/g)) {
      if (!/ADR-\d{4}/.test(group[1])) addRuleIds(doc.defined, group[1]);
    }
  }
  return doc;
}

const live = new Map(docs.map((d) => [d.num, d]));
const aliasHost = new Map();
for (const d of docs) {
  for (const entry of d.fm?.folds ?? []) {
    const m = String(entry).match(/^(\d{4}) — .+/);
    if (!m) { fail(d.path, `folds entry should read "NNNN — Title": ${entry}`); continue; }
    if (live.has(m[1])) fail(d.path, `ADR-${m[1]} is folded into this document but also exists as a file`);
    else if (aliasHost.has(m[1])) fail(d.path, `ADR-${m[1]} is folded into two documents`);
    else aliasHost.set(m[1], d);
  }
}
const numberExists = (n) => live.has(n) || aliasHost.has(n);
const hostOf = (n) => live.get(n) ?? aliasHost.get(n);

// -------------------------------------------------------------- per-ADR checks

for (const d of docs) {
  const at = d.path;
  const fm = d.fm;
  if (fm) {
    if (!STATUSES.includes(fm.status)) fail(at, `status should be one of ${STATUSES.join(', ')} (got ${fm.status})`);
    if (fm.implemented !== undefined && !IMPLEMENTED.includes(fm.implemented)) fail(at, `implemented should be one of ${IMPLEMENTED.join(', ')} (got ${fm.implemented})`);
    for (const key of ['amends', 'supersedes']) {
      for (const n of fm[key] ?? []) {
        if (!/^\d{4}$/.test(n)) fail(at, `${key} entries are four-digit numbers (got ${n})`);
        else if (!numberExists(n)) fail(at, `${key} names ADR-${n}, which does not exist`);
        else if (n === d.num) fail(at, `${key} names the document itself`);
      }
    }
  }

  let last = -1;
  for (const { name, line } of d.h2) {
    if (RENAMED[name]) fail(`${at}:${line}`, `heading \`${name}\` is called \`${RENAMED[name]}\``);
    if (/^(Amendment|Update|Addendum)\b/.test(name)) fail(`${at}:${line}`, `no \`${name}\` section: rewrite the affected part of the ADR and add a History line (AGENTS.md)`);
    const rank = RANK.has(name) ? RANK.get(name) : TOPIC_RANK;
    if (rank < last) fail(`${at}:${line}`, `\`${name}\` is out of order (${SECTION_ORDER.filter(Boolean).join(' > ')}; topic sections sit after Key properties)`);
    last = Math.max(last, rank);
  }
  for (const required of ['Problem', 'Decision']) {
    if (!d.h2.some((h) => h.name === required)) fail(at, `missing \`## ${required}\``);
  }

  for (const n of d.pending) {
    const target = live.get(n);
    if (n === d.num) fail(at, 'a Pending line names the ADR that will change this one, not this one: for a small change it names no ADR');
    else if (!target) fail(at, `Pending names ADR-${n}, which does not exist`);
    else if ((target.fm?.implemented ?? 'full') === 'full') fail(at, `Pending names ADR-${n}, which is fully implemented: fold the change into this ADR and drop the Pending line`);
  }
  for (const line of d.markers) warn(`${at}:${line}`, 'inline amendment marker: rewrite the paragraph to what is true now and put the date in History (AGENTS.md)');
}

// ---------------------------------------------------------------------- index

const byNumber = (a, b) => a.num.localeCompare(b.num);
const relFrom = (target) => path.posix.relative(adrDir, target);
const cellLink = (n) => {
  const host = hostOf(n);
  return host ? `[${n}](${relFrom(host.path)})` : n;
};

function buildIndex() {
  const amendedBy = new Map();
  const supersededBy = new Map();
  for (const d of docs) {
    for (const n of d.fm?.amends ?? []) amendedBy.set(n, [...(amendedBy.get(n) ?? []), d.num]);
    for (const n of d.fm?.supersedes ?? []) supersededBy.set(n, [...(supersededBy.get(n) ?? []), d.num]);
  }
  const cell = (plain, superseding, verb) => {
    const parts = [...[...plain].sort().map(cellLink), ...[...superseding].sort().map((n) => `${verb} ${cellLink(n)}`)];
    return parts.length ? parts.join(', ') : '—';
  };
  const out = [];
  for (const [folder, scope] of Object.entries(FOLDERS)) {
    out.push(`### ${folder}/`, '', `${scope[0].toUpperCase()}${scope.slice(1)}.`, '', '| ADR | Title | Status | Amends | Amended by |', '|---|---|---|---|---|');
    for (const d of docs.filter((x) => x.folder === folder).sort(byNumber)) {
      const impl = { partial: ', partly implemented', none: ', not yet implemented' }[d.fm?.implemented] ?? '';
      out.push(`| [${d.num}](${relFrom(d.path)}) | ${d.title.replace(/\|/g, '\\|')} | ${d.fm?.status ?? '?'}${impl} | ${cell(d.fm?.amends ?? [], d.fm?.supersedes ?? [], 'supersedes')} | ${cell(amendedBy.get(d.num) ?? [], supersededBy.get(d.num) ?? [], 'superseded by')} |`);
    }
    out.push('');
  }
  const retired = [...aliasHost].sort(([a], [b]) => a.localeCompare(b));
  if (retired.length) {
    out.push('### Retired numbers', '', 'Folded into another ADR. The number still resolves, and code that cites it stays valid.', '', '| ADR | Was | Now in |', '|---|---|---|');
    for (const [n, host] of retired) {
      const entry = host.fm.folds.find((f) => f.startsWith(n));
      out.push(`| ${n} | ${entry.replace(/^\d{4} — /, '')} | [${host.num}](${relFrom(host.path)}) |`);
    }
    out.push('');
  }
  return out.join('\n');
}

const START = '<!-- adr-index:start (generated by scripts/verify-adr.mjs --write; do not edit by hand) -->';
const END = '<!-- adr-index:end -->';
const readmePath = `${adrDir}/README.md`;
if (!fs.existsSync(path.join(root, readmePath))) {
  fail(readmePath, 'missing: it holds the template, the rules and the generated index');
} else {
  const readme = read(readmePath);
  const a = readme.indexOf('<!-- adr-index:start');
  const b = readme.indexOf(END);
  if (a < 0 || b < a) fail(readmePath, `missing the ${START} ... ${END} markers`);
  else {
    const fresh = `${readme.slice(0, a)}${START}\n\n${buildIndex()}\n${readme.slice(b)}`;
    if (fresh !== readme) {
      if (args.has('--write')) { fs.writeFileSync(path.join(root, readmePath), fresh); console.log(`  wrote ${readmePath}`); }
      else fail(readmePath, 'the index is out of date: run `node scripts/verify-adr.mjs --write`');
    }
  }
}

// ---------------------------------------- citations from every tracked file

const textFiles = files.filter(isTextFile);
let tokenCount = 0;
let ruleCount = 0;
const citedRules = new Set();
for (const p of textFiles) {
  let text;
  try { text = read(p); } catch { continue; }
  if (text.includes('\0')) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\bADR-(\d{4})\b/g)) {
      tokenCount += 1;
      if (!numberExists(m[1])) fail(`${p}:${i + 1}`, `ADR-${m[1]} does not exist`);
    }
    for (const m of line.matchAll(/\bADR-(\d{4})(?:,|\s)+([A-Z]\d{1,2})\b/g)) {
      const rules = [m[2]];
      const tail = line.slice(m.index + m[0].length);
      for (const more of tail.matchAll(/^(?:\s*(?:[/,]|and)\s*([A-Z]\d{1,2})\b)+/g)) {
        for (const r of more[0].matchAll(/[A-Z]\d{1,2}/g)) rules.push(r[0]);
      }
      for (const rule of rules) {
        const host = hostOf(m[1]);
        if (!host) continue;
        ruleCount += 1;
        citedRules.add(`${m[1]} ${rule}`);
        if (!host.defined.has(rule)) fail(`${p}:${i + 1}`, `cites ADR-${m[1]} ${rule}, which ${host.path} does not define (label it \`(${rule})\` in the bold lead)`);
      }
    }
  });
}

// ---------------------------------------------------------------------- links

const headingSlugs = new Map();
function slugsOf(p) {
  if (headingSlugs.has(p)) return headingSlugs.get(p);
  const seen = new Map();
  const set = new Set();
  let fence = false;
  for (const line of read(p).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    const h = !fence && line.match(/^#{1,6} +(.*?)\s*#*\s*$/);
    if (!h) continue;
    const base = h[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    set.add(count ? `${base}-${count}` : base);
  }
  headingSlugs.set(p, set);
  return set;
}

let linkCount = 0;
for (const p of files.filter((f) => f.endsWith('.md'))) {
  let fence = false;
  read(p).split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    // A link inside an inline code span is an example, not a link.
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
      const [filePart, fragment] = target.split('#');
      const abs = filePart ? path.posix.normalize(path.posix.join(path.posix.dirname(p), filePart)) : p;
      if (!(p.startsWith(`${adrDir}/`) || abs.startsWith(adrDir))) continue;
      linkCount += 1;
      const at = `${p}:${i + 1}`;
      if (!fs.existsSync(path.join(root, abs))) { fail(at, `link to ${target} does not resolve`); continue; }
      if (fragment && abs.endsWith('.md') && !slugsOf(abs).has(fragment)) fail(at, `link to ${target}: no heading with that anchor`);
    }
  });
}

if (args.has('--next')) {
  const all = [...live.keys(), ...aliasHost.keys()].map(Number);
  console.log(String(Math.max(0, ...all) + 1).padStart(4, '0'));
  process.exit(0);
}

// --------------------------------------------------------------------- report

for (const { level, where, message } of problems.sort((x, y) => x.where.localeCompare(y.where))) {
  (level === 'FAIL' ? console.error : console.log)(`${level.padEnd(4)}  ${where}  ${message}`);
}
const failures = problems.filter((x) => x.level === 'FAIL').length;
const warnings = problems.length - failures;
console.log(`${failures ? 'FAIL' : '  ok'}  ${docs.length} ADRs in ${Object.keys(FOLDERS).length} folders (${aliasHost.size} retired numbers): ${tokenCount} ADR-NNNN mentions, ${citedRules.size} distinct rule citations (${ruleCount} sites), ${linkCount} links; ${failures} failures, ${warnings} warnings`);
if (failures) console.error('docs/adr/README.md says what an ADR is, where it goes and how to write or change one.');
process.exit(failures ? 1 : 0);
