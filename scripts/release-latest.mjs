#!/usr/bin/env node
// Which published release should be GitHub's "latest" (ADR-0065 C11).
// release.yml creates each Release without the mark, and release-assets marks
// it once SHA256SUMS is attached, but only when its tag is the highest version
// the repository has released: a re-run of an older tag's release must never
// take latest back from a newer one.
//
//   gh api --paginate 'repos/<repo>/releases?per_page=100' \
//     --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name' \
//     | node scripts/release-latest.mjs <tag>
//
// stdin is the tag of every published, non-draft, non-prerelease release, one
// per line. Prints the highest of them by semantic version. A line that is not
// a version (vX.Y.Z or X.Y.Z, with an optional -prerelease and +build) is not
// a release this repository makes, and is ignored. <tag> must be among them:
// it was published before this runs, so a list without it is a failed or
// partial read, and the script exits 1 rather than let an empty list make any
// tag look the highest.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A tag's version parts, or null when it is not a semantic version. */
export function parseTag(tag) {
  const match = VERSION.exec(tag.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return { core: [major, minor, patch].map(BigInt), pre: pre ? pre.split('.') : [] };
}

const comparePre = (a, b) => {
  // A version without a prerelease is above every prerelease of it.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
};

/** Semantic-version order of two tags: negative, zero or positive. Both must parse. */
export function compareTags(a, b) {
  const [x, y] = [parseTag(a), parseTag(b)];
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

/**
 * The highest version among `published`, which must hold `tag`. On a tie
 * (v1.2.3 and 1.2.3) `tag` wins, so it is marked rather than passed over.
 */
export function highestTag(tag, published) {
  if (!parseTag(tag)) throw new Error(`${tag} is not a version`);
  const tags = published.map((line) => line.trim()).filter(Boolean);
  if (!tags.includes(tag)) throw new Error(`the published releases read do not include ${tag}, which this run published: the list is incomplete`);
  return tags.filter((t) => parseTag(t)).reduce((best, t) => (compareTags(t, best) > 0 ? t : best), tag);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [tag, ...rest] = process.argv.slice(2);
  if (!tag || rest.length > 0) {
    console.error('usage: release-latest.mjs <tag> < published-tags');
    process.exit(2);
  }
  try {
    console.log(highestTag(tag, readFileSync(0, 'utf8').split('\n')));
  } catch (error) {
    console.error(`release-latest: ${error.message}`);
    process.exit(1);
  }
}
