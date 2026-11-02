// What bench/scale/target.mjs reads and says, kept pure so its tests need no run.
// A comparison reports figures and never a verdict: ADR-0058 says no test
// asserts a rate, and a threshold here would be one by another name.

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

function cell(text) {
  const match = /^(-?\d+(?:\.\d+)?)(?: (B|KB|MB|GB))?$/.exec(text.trim());
  return match ? Number(match[1]) * (UNITS[match[2]] ?? 1) : null;
}

/** The last table ops.mjs prints: every operation, by name, at each size it reached. */
export function parseOpsTable(text) {
  const lines = text.split('\n');
  const header = lines.findLastIndex((line) => /^\| operation \|/.test(line));
  if (header < 0) throw new Error('ops.mjs printed no table of operations');
  const sizes = lines[header].split('|').map((c) => /^n=(\d+)$/.exec(c.trim())?.[1]).filter(Boolean);
  const rows = {};
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const [name, ...cells] = line.split('|').slice(1, -1).map((c) => c.trim());
    const values = {};
    sizes.forEach((size, i) => {
      const value = cell(cells[i] ?? '-');
      if (value !== null) values[size] = value;
    });
    if (Object.keys(values).length > 0) rows[name] ??= values;
  }
  return rows;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

/** Each number across repeats by its median; anything else, as the first repeat said it. */
export function medianOf(repeats) {
  const [first] = repeats;
  const out = {};
  for (const [key, value] of Object.entries(first)) {
    const peers = repeats.map((repeat) => repeat[key]);
    if (typeof value === 'number') out[key] = median(peers.filter((peer) => typeof peer === 'number'));
    else if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = medianOf(peers.filter(Boolean));
    else out[key] = value;
  }
  return out;
}

export function unfinished(target, repeats) {
  return repeats.flatMap((repeat, i) => [
    ...(repeat.finished < target.tasks ? [`repeat ${i + 1} finished ${repeat.finished} of ${target.tasks} tasks`] : []),
    ...(repeat.mcp?.failures > 0 ? [`repeat ${i + 1} had ${repeat.mcp.failures} failed MCP calls`] : []),
  ]);
}

function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, inner]) => {
    if (typeof inner === 'number') return [[`${prefix}${key}`, inner]];
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? flatten(inner, `${prefix}${key}.`) : [];
  });
}

const figures = (run) => new Map([
  ...flatten(run.live ?? {}).map(([name, value]) => [`live: ${name}`, value]),
  ...Object.entries(run.ops ?? {}).flatMap(([name, sizes]) => Object.entries(sizes).map(([size, value]) => [`ops n=${size}: ${name}`, value])),
]);

const sameMachine = (a, b) => JSON.stringify(a.host) === JSON.stringify(b.host);

export function compareRuns(before, after) {
  const warnings = [
    ...(JSON.stringify(before.target) === JSON.stringify(after.target) ? [] : ['The two runs had a different target, so their figures do not describe the same load.']),
    ...(sameMachine(before, after) ? [] : ['The two runs were on a different machine or Node, so a time here says little.']),
    ...(before.problems ?? []).map((problem) => `before: ${problem}`),
    ...(after.problems ?? []).map((problem) => `after: ${problem}`),
  ];
  const was = figures(before);
  const now = figures(after);
  const rows = [...new Set([...was.keys(), ...now.keys()])].map((name) => {
    const a = was.get(name) ?? null;
    const b = now.get(name) ?? null;
    return { name, before: a, after: b, ratio: a && b !== null ? b / a : null };
  });
  return { before: before.commit, after: after.commit, warnings, rows };
}

export function describeComparison({ before, after, warnings, rows }) {
  const shown = (value) => value ?? '-';
  return [
    `before ${before}, after ${after}; ratio is after / before.`,
    ...warnings.map((warning) => `WARNING: ${warning}`),
    '',
    'figure | before | after | ratio',
    '--- | --- | --- | ---',
    ...rows.map((row) => `${row.name} | ${shown(row.before)} | ${shown(row.after)} | ${row.ratio === null ? '-' : row.ratio.toFixed(2)}`),
  ];
}
