// Pack the files Vitest discovers, across all owed Windows workspaces.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const durationsPath = fileURLToPath(new URL('./windows-durations.json', import.meta.url));
export const fileKey = (root, file) => path.relative(root, file).split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  const [index, count] = match ? match.slice(1).map(Number) : [];
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 1 || index > count) {
    throw new Error(`Invalid SHARD: ${value}; expected an index/count with 1 <= index <= count`);
  }
  return { index, count };
}

/** New files have a small estimate; path order breaks every tie on every OS. */
export function packFiles(files, count, durations = JSON.parse(readFileSync(durationsPath, 'utf8')).files) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Shard count must be positive');
  if (new Set(files).size !== files.length) throw new Error('Duplicate test file');
  const weight = (file) => Number.isFinite(durations[file]) && durations[file] >= 0 ? durations[file] : 1000;
  const shards = Array.from({ length: count }, () => ({ files: [], milliseconds: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || compare(a, b))) {
    const shard = shards.reduce((least, next) => next.milliseconds < least.milliseconds ? next : least);
    shard.files.push(file);
    // Zero-duration skipped files must not all pile into the first shard.
    shard.milliseconds += Math.max(1, weight(file));
  }
  return shards;
}

/** Fail on a new script shape rather than silently losing its selection flags. */
export function suiteArgs(script) {
  if (typeof script !== 'string') throw new Error('Windows suite has no test script');
  const tokens = script.match(/'[^']*'|"[^"]*"|[^\s'"|&;<>]+/g) ?? [];
  if (tokens.join(' ') !== script.trim().replace(/\s+/g, ' ') || tokens[0] !== 'vitest' || tokens[1] !== 'run') {
    throw new Error(`Windows file discovery needs a plain vitest run script: ${script}`);
  }
  return tokens.map((token) => /^['"]/.test(token) ? token.slice(1, -1) : token);
}

export async function suiteFiles(runs, root = process.cwd()) {
  const { createVitest, parseCLI } = await import('vitest/node');
  const suites = [];
  // Each workspace keeps its config, including setup, excludes and environment.
  for (const run of runs) {
    const dir = path.resolve(root, run.dir);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const { options, filter } = parseCLI(suiteArgs(manifest.scripts[run.script]));
    const ctx = await createVitest('test', { ...options, root: dir, maxWorkers: 2, minWorkers: 1 });
    try {
      const specs = await ctx.globTestSpecs(filter);
      suites.push({ ...run, config: ctx.server.config.configFile, files: specs.map(({ moduleId }) => fileKey(root, moduleId)).sort(compare) });
    } finally {
      await ctx.close();
    }
  }
  return suites;
}
