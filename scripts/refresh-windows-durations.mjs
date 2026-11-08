#!/usr/bin/env node
// Refresh: node scripts/refresh-windows-durations.mjs <run-id> [<run-id> ...]
// Uses each file's maximum observed milliseconds; accepts raw or gh-formatted
// job logs. GitHub's job-log API is a fallback when gh run view returns empty.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { durationsPath } from './windows-shards.mjs';

export function parseDurations(log) {
  let workspace;
  const files = {};
  for (const line of log.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const group = /group(?:::|\])(?:test|test:quick) in (packages\/\w+)/.exec(line);
    if (group) workspace = group[1];
    const result = /[✓↓×❯] (.+\.test\.tsx?)\s+\(.*\)\s+(\d+)ms/.exec(line);
    if (workspace && result) {
      const key = [workspace, result[1].replaceAll('\\', '/')].join('/');
      files[key] = Math.max(files[key] ?? 0, Number(result[2]));
    }
  }
  return files;
}

export function collectDurations(logs) {
  const files = {};
  for (const log of logs) for (const [file, duration] of Object.entries(parseDurations(log))) {
    files[file] = Math.max(files[file] ?? 0, duration);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runs = process.argv.slice(2);
  if (!runs.length || runs.some((run) => !/^\d+$/.test(run))) throw new Error('Pass one or more CI run IDs');
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const { nameWithOwner: repo } = JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner'));
  const logs = [];
  for (const run of runs) {
    const { jobs } = JSON.parse(gh('run', 'view', run, '--json', 'jobs'));
    const shards = jobs.filter((job) => /^windows \(\d+\/\d+\)$/.test(job.name));
    if (!shards.length || shards.some((job) => job.conclusion !== 'success')) throw new Error(`Run ${run} has no complete successful Windows matrix`);
    for (const { databaseId } of shards) {
      const log = gh('run', 'view', run, '--job', String(databaseId), '--log')
        || gh('api', `repos/${repo}/actions/jobs/${databaseId}/logs`);
      if (!Object.keys(parseDurations(log)).length) throw new Error(`No file durations in job ${databaseId}`);
      logs.push(log);
    }
  }
  const files = collectDurations(logs);
  writeFileSync(durationsPath, `${JSON.stringify({ runs, statistic: 'maximum milliseconds per file', files }, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(files).length} durations to ${durationsPath}`);
}
