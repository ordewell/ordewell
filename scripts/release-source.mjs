// A recovery uses the repaired delivery workflows on main and builds the
// original tag. Everything outside this delivery-only list must be identical
// to main, so main's CI also proves the sources being published.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DELIVERY_FILES = new Set([
  '.github/workflows/release.yml',
  '.github/workflows/desktop-build.yml',
  '.github/workflows/cli-build.yml',
  'scripts/release-source.mjs',
  'scripts/release-source.test.mjs',
  'scripts/desktop-release.test.mjs',
  'scripts/cli-release.test.mjs',
]);

export function verifyReleaseSource(tag, { recovery = false, ref = '', cwd = process.cwd() } = {}) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag ?? '')) {
    throw new Error('A release needs an existing version tag such as v0.14.0.');
  }
  if (recovery && ref !== 'refs/heads/main') throw new Error('Release recovery runs from main only.');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let sourceCommit;
  try {
    sourceCommit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  } catch {
    throw new Error(`Release tag ${tag} does not exist.`);
  }
  const workflowCommit = git('rev-parse', 'HEAD');
  if (!recovery && sourceCommit !== workflowCommit) throw new Error('The release checkout must be the tagged commit.');
  const deliveryChanges = recovery
    ? git('diff', '--name-only', '--no-renames', sourceCommit, workflowCommit).split('\n').filter(Boolean)
    : [];
  const changedSources = deliveryChanges.filter((file) => !DELIVERY_FILES.has(file));
  if (changedSources.length) throw new Error(`Recovery would change released sources: ${changedSources.join(', ')}`);
  return { tag, sourceCommit, workflowCommit, deliveryChanges };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(verifyReleaseSource(process.argv[2], {
      recovery: process.env.RECOVERY === 'true', ref: process.env.RELEASE_REF,
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
