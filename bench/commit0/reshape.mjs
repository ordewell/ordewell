#!/usr/bin/env node
// Offline, no key: a recorded one-shot plan shaped again by this build's core,
// and the properties checked. The recorded plan (a run's plan.json or a
// plan-only run's plan-saved.json, any { tasks } plan) carries the notes of the
// build that planned it, so each brief is cut at its first appended
// "Plan shape:" note, a "Plan revision:" note kept, and the plan goes through
// core's own shapeFanOut, the order a planner's plan is shaped in: merge, read,
// order, note (packages/core/src/services/PlanFanOut.ts, bundled here with
// esbuild, as the bench imports no core build that exports it). The slices are
// sized from the run's repository, the arm-workdir beside the plan file when
// there is one, read as the planner reads; without one nothing is read, so
// nothing merges and only the tasks before the slices move.
//
//   node bench/commit0/reshape.mjs [--base-broken] [--limit N] <plan.json> ...
//
// --limit is the run's parallel limit, which only the slice merge reads.
// One JSON line a plan: the recorded shape and the new one, the log lines
// shaping wrote, the properties of the shaped plan, and the checks below;
// exit 1 when any check fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fanOutProperties, fanOutShape } from './fanout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** This build's PlanFanOut.ts, bundled to a scratch directory and imported. */
export async function loadCore() {
  const { build } = await import('esbuild');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-reshape-')), 'PlanFanOut.mjs');
  await build({ entryPoints: [path.join(ROOT, 'packages/core/src/services/PlanFanOut.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
  return import(pathToFileURL(out).href);
}

const NOTE = '\n\nPlan shape:';
const bare = (t) => (typeof t.prompt === 'string' && t.prompt.includes(NOTE) ? { ...t, prompt: t.prompt.slice(0, t.prompt.indexOf(NOTE)) } : t);
const ids = (ts) => ts.map((t) => t.id);

/** What the recorded run told each role, read from the notes its briefs carry. */
function told(plan) {
  const has = (t, text) => (t.prompt ?? '').includes(text);
  return {
    opening: plan.tasks.filter((t) => has(t, 'wait for this task to land before any of them starts')).map((t) => t.id),
    slices: plan.tasks.filter((t) => has(t, 'Plan shape: this task is one of')).map((t) => t.id),
    closing: plan.tasks.filter((t) => has(t, 'Plan shape: this check runs after')).map((t) => t.id),
  };
}

/** The checks a build task holds each recorded plan to; `null` where a check does not apply. */
export function reshapeChecks(recorded, renoted, { baseBroken = false } = {}) {
  const was = told(recorded);
  const now = fanOutShape(renoted);
  const p = fanOutProperties(renoted, { baseBroken });
  const by = new Map(renoted.tasks.map((t) => [t.id, t]));
  const old = new Map(recorded.tasks.map((t) => [t.id, t]));
  const level = levels(renoted);
  const noted = now.wide && now.closers.length > 0;
  return {
    was,
    now: { width: now.width, before: ids(now.gates), opening: now.opening?.id ?? null, slices: now.slices.length, faults: now.faults },
    properties: p,
    checks: {
      // A plan the recorded run noted is still noted, with the same closing check.
      stillNoted: was.slices.length ? noted : null,
      sameCloser: was.closing.length ? was.closing.every((id) => renoted.tasks.find((t) => t.id === id)?.prompt?.includes('Plan shape: this check runs after')) : null,
      // No slice is one that a fan-out of deeper slices all wait for.
      noneMissed: now.wide ? now.slices.every((s) => {
        const deeper = now.slices.filter((o) => level.get(o.id) > level.get(s.id));
        return deeper.length < 4 || !deeper.every((o) => ancestorOf(renoted, s.id, o.id));
      }) : null,
      // With no task before the slices nothing restores the import: reported in now.faults as no-opening, not checked here.
      importCriterion: noted && now.gates.length ? p.P8_beforeSlicesImport : null,
      // A slice is told it starts after a task only when it waits for it.
      slicesToldTruly: noted ? now.slices.every((s) => {
        const names = [...(by.get(s.id).prompt ?? '').matchAll(/that start once (.*?) (?:has|have) landed/g)].flatMap((m) => [...m[1].matchAll(/\(([^()\s]+)\)/g)].map((x) => x[1]));
        return names.every((id) => ancestorOf(renoted, id, s.id));
      }) : null,
      // Nothing but the notes, the order and the slice merge changed: every recorded task is in one task, and each
      // task waits for what its first recorded task waited for, a merged slice named by the task that covers it.
      sameGraph: sameGraph(recorded, renoted),
      // The licence to edit any file is the opening task's alone.
      licenceOnOpening: noted && now.gates.length ? licensed(renoted).join() === (now.opening ? now.opening.id : '') : null,
      // Where the recorded run had one task before its slices and the new reading too, each slice's note is as recorded.
      slicesUnchanged: was.opening.length === 1 && now.gates.length === 1 && was.slices.length === now.slices.length
        ? now.slices.every((s) => by.get(s.id).prompt === old.get(s.id).prompt) : null,
    },
  };
}

const LICENCE = 'For that alone you may edit any file';
const licensed = (plan) => plan.tasks.filter((t) => (t.prompt ?? '').includes(LICENCE)).map((t) => t.id);

function sameGraph(recorded, renoted) {
  const into = new Map();
  for (const t of renoted.tasks) for (const id of [t.id, ...(t.mergedSlices ?? [])]) into.set(id, into.has(id) ? null : t.id);
  if (recorded.tasks.some((t) => !into.get(t.id)) || into.size !== recorded.tasks.length) return false;
  const old = new Map(recorded.tasks.map((t) => [t.id, t]));
  const set = (ids) => JSON.stringify([...new Set(ids)].sort());
  return renoted.tasks.every((t) => old.has(t.id) && set(t.dependencies ?? []) === set((old.get(t.id).dependencies ?? []).map((d) => into.get(d) ?? d)));
}

function levels(plan) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const level = new Map();
  const visit = (t) => {
    if (level.has(t.id)) return level.get(t.id);
    level.set(t.id, 0);
    const l = 1 + Math.max(0, ...(t.dependencies ?? []).filter((d) => byId.has(d)).map((d) => visit(byId.get(d))));
    level.set(t.id, l);
    return l;
  };
  for (const t of plan.tasks) visit(t);
  return level;
}

const OFFLINE = { readFile: async () => ({ success: false, output: 'not read offline', truncated: false }) };

/** The run's repository read as the planner's file systems answer: numbered lines, a size cap in KB, a line limit, nothing outside it. */
export function repositoryReader(root) {
  return {
    readFile: async (p, opts = {}) => {
      const abs = path.resolve(root, p);
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { success: false, output: `${p} is outside the workspace`, truncated: false, refused: true };
      let content;
      try { content = fs.readFileSync(abs); } catch { return { success: false, output: `Error reading ${p}: ENOENT`, truncated: false }; }
      if (content.length > (opts.maxBytes ?? 1024) * 1024) return { success: true, output: `File too large. Maximum is ${opts.maxBytes ?? 1024} KB.`, truncated: false };
      const all = content.toString('utf8').split('\n');
      if (all[all.length - 1] === '') all.pop();
      const limit = opts.limit ?? 2000;
      const shown = all.slice(0, limit).map((l, i) => `${String(i + 1).padStart(String(all.length).length)}|${l}`).join('\n');
      return { success: true, output: shown, truncated: limit < all.length };
    },
  };
}

/** A recorded plan's briefs cut at their notes, shaped again by core, and checked. */
export async function reshape(core, recorded, { baseBroken = false, workdir, limit } = {}) {
  const shaped = await core.shapeFanOut(recorded.tasks.map(bare), workdir ? repositoryReader(workdir) : OFFLINE, limit);
  const renoted = { ...recorded, tasks: shaped.tasks };
  const r = reshapeChecks(recorded, renoted, { baseBroken });
  const gatesFirst = Number(/slice order: (\d+) tasks? the slices wait for/.exec(shaped.log.join('\n'))?.[1] ?? 0);
  return { ...r, log: shaped.log, gatesFirst, licensed: licensed(renoted), failed: Object.entries(r.checks).filter(([, v]) => v === false).map(([k]) => k), renoted };
}

function ancestorOf(plan, a, b) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const seen = new Set();
  const walk = (id) => (byId.get(id)?.dependencies ?? []).some((d) => d === a || (!seen.has(d) && (seen.add(d), walk(d))));
  return walk(b);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const baseBroken = args.includes('--base-broken');
  const at = args.indexOf('--limit');
  const limit = at >= 0 ? Number(args[at + 1]) : undefined;
  const core = await loadCore();
  let failed = false;
  for (const file of args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1))) {
    const workdir = path.join(path.dirname(file), 'arm-workdir');
    const r = await reshape(core, JSON.parse(fs.readFileSync(file, 'utf8')), { baseBroken, limit, ...(fs.existsSync(workdir) ? { workdir } : {}) });
    if (r.failed.length) failed = true;
    console.log(JSON.stringify({ file, ...r, renoted: undefined }));
  }
  process.exit(failed ? 1 : 0);
}
