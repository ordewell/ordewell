// Recovery uses repaired workflows on main but builds the original tag. Its
// own successful main CI and npm's immutable gitHead prove which source was
// published, including when newer application changes have landed on main.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mainProof } from './change-scope.mjs';

function findMainRuns(sha) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required to look up the tagged source CI.');
  return execFileSync('gh', [
    'run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push',
    '--commit', sha, '--status', 'success', '--json', 'databaseId,url,headSha,event,headBranch,conclusion',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}

async function publishedCommit(version) {
  const response = await fetch(`https://registry.npmjs.org/@ordewell%2fcore/${encodeURIComponent(version)}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Cannot verify the published source of @ordewell/core@${version}: HTTP ${response.status}.`);
  const pkg = await response.json();
  if (pkg.version !== version || !/^[0-9a-f]{40}$/.test(pkg.gitHead ?? '')) {
    throw new Error(`@ordewell/core@${version} has no verifiable published source commit.`);
  }
  return pkg.gitHead;
}

export async function verifyReleaseSource(tag, {
  recovery = false, ref = '', cwd = process.cwd(),
  findRuns = findMainRuns, readPublishedCommit = publishedCommit,
} = {}) {
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
  const version = tag.slice(1);
  if (JSON.parse(git('show', `${sourceCommit}:package.json`)).version !== version) {
    throw new Error('The tag must match the version in its own sources.');
  }
  if (!recovery) {
    if (sourceCommit !== workflowCommit) throw new Error('The release checkout must be the tagged commit.');
    return { tag, sourceCommit, workflowCommit };
  }
  const proof = mainProof(sourceCommit, findRuns);
  if (!proof.url) throw new Error(`The tagged source has no verified main CI proof: ${proof.why}`);
  const publishedSource = await readPublishedCommit(version);
  if (publishedSource !== sourceCommit) throw new Error('The tag does not match the already-published npm source commit.');
  return { tag, sourceCommit, workflowCommit, proof: proof.url, publishedSource };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await verifyReleaseSource(process.argv[2], {
      recovery: process.env.RECOVERY === 'true', ref: process.env.RELEASE_REF,
    }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
