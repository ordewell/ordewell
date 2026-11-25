#!/usr/bin/env node
// The winget job's submission to microsoft/winget-pkgs (ADR-0063 H11), so a
// release needs no hand on it:
//
//   WINGET_TOKEN=... node scripts/winget-submit.mjs --version <X.Y.Z> \
//     --manifests <dir> --wingetcreate <path to wingetcreate.exe>
//
// 1. Brings the default branch of the token's fork of winget-pkgs up to date
//    with upstream. wingetcreate syncs it too, but reports any refusal as "Sync
//    your fork manually" and drops GitHub's reason: release 0.14.12 stopped
//    there twice until the fork was synced by hand. A fork that does not exist
//    yet is wingetcreate's to create.
// 2. Titles the pull request "New version" once upstream holds the package and
//    "New package" before, and runs `wingetcreate submit`.
// 3. Closes this account's older open submissions of the package as superseded
//    by the new one. The submission has landed by then, so a failure here is
//    a warning and never fails the job.
//
// The token is read from the environment and handed on in the environment
// alone: gh's GH_TOKEN and wingetcreate's WINGET_CREATE_GITHUB_TOKEN, never an
// argument and never printed. Request bodies go to gh on stdin.
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareTags, parseTag } from './release-latest.mjs';

export const UPSTREAM = 'microsoft/winget-pkgs';
export const PACKAGE = 'Ordewell.Ordewell';
const PACKAGE_PATH = 'manifests/o/Ordewell/Ordewell';
const TITLE = /^New (?:package|version): Ordewell\.Ordewell version (\S+)$/;

/** The title this job gives a submission of `version`. */
export const submissionTitle = (version, packageExists) => `${packageExists ? 'New version' : 'New package'}: ${PACKAGE} version ${version}`;

/** The comment that closes an older submission. */
export const supersededComment = (number, version) => `Superseded by #${number} (${PACKAGE} ${version}).`;

/**
 * The open pull requests among search results that this job opened for
 * `login` before #`number`, the submission of `version`: authored by that
 * login, titled exactly as this job titles one, and of a lower version, or of
 * the same version and opened earlier. A re-run of an older release closes
 * nothing newer than itself.
 */
export function supersededBy(items, { login, number, version }) {
  return items.filter((item) => {
    if (item.number === number || item.state !== 'open' || !item.pull_request || item.user?.login !== login) return false;
    const [, older] = TITLE.exec(item.title ?? '') ?? [];
    if (!older || !parseTag(older)) return false;
    const order = compareTags(older, version);
    return order < 0 || (order === 0 && item.number < number);
  });
}

/** What to do about a sync GitHub refused, in one line. */
export function syncAdvice(status, message, fork) {
  const workflow = 'give WINGET_TOKEN the `workflow` scope (classic token) or Workflows: Read and write on that fork (fine-grained token), then re-run this job';
  if (/workflow/i.test(message)) return `GitHub brings upstream's changes to .github/workflows into ${fork} only for a token that may write workflow files: ${workflow}.`;
  if (status === 401) return 'WINGET_TOKEN was refused: it has expired or been revoked, so replace the secret with a new token and re-run this job.';
  if (status === 403 || status === 404) return `WINGET_TOKEN cannot write to ${fork}: it needs the \`public_repo\` scope (classic token) or Contents: Read and write on that fork (fine-grained token).`;
  if (status === 409) return `${fork} has commits upstream does not, so it cannot be fast-forwarded: reset its default branch to upstream's (the submissions live on other branches) and re-run this job.`;
  if (status === 422) return `GitHub would not sync ${fork}. When upstream changed a file under .github/workflows since the last sync, as before release 0.14.12, ${workflow}; otherwise run \`gh repo sync ${fork}\` and re-run this job.`;
  return `Run \`gh repo sync ${fork}\` by hand, or re-run this job if GitHub was unavailable.`;
}

/** The HTTP status gh names in its error line, or null. */
const httpStatus = (stderr) => Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1]) || null;

/** GitHub's own words for a failed call: gh's error line, and the body's message when it adds to it. */
function githubError({ stdout, stderr }) {
  const lines = [stderr.trim()];
  try {
    const { message, errors } = JSON.parse(stdout);
    if (message && !stderr.includes(message)) lines.push(message);
    for (const error of Array.isArray(errors) ? errors : []) lines.push(typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error)));
  } catch {
    // No JSON body: gh's line is all GitHub said.
  }
  return lines.filter(Boolean).join('\n') || 'gh failed without a message';
}

class Failure extends Error {}

export async function submit({ version, manifests, wingetcreate, env = process.env, log = console.log, error = console.error }) {
  const token = env.WINGET_TOKEN;
  if (!token) throw new Failure('WINGET_TOKEN is not set.');
  if (!parseTag(version)) throw new Failure(`${version} is not a version.`);
  const ghEnv = { ...env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' };
  const gh = (args, body) => {
    const result = spawnSync('gh', args, { env: ghEnv, encoding: 'utf8', input: body === undefined ? '' : JSON.stringify(body), maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw new Failure(`gh could not start: ${result.error.message}`);
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: httpStatus(result.stderr ?? '') };
  };
  const json = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const user = gh(['api', 'user']);
  const login = user.ok ? json(user.stdout)?.login : null;
  if (!login) {
    error(githubError(user));
    throw new Failure(user.status === 401 ? syncAdvice(401, '', '') : 'Could not read which account WINGET_TOKEN belongs to.');
  }
  const fork = `${login}/winget-pkgs`;

  const repo = gh(['api', `repos/${fork}`]);
  if (!repo.ok && repo.status === 404) {
    log(`${fork} does not exist yet: wingetcreate forks ${UPSTREAM} there.`);
  } else if (!repo.ok) {
    error(githubError(repo));
    throw new Failure(`Could not read ${fork}. ${syncAdvice(repo.status, '', fork)}`);
  } else {
    const { fork: isFork, parent, default_branch: branch } = json(repo.stdout) ?? {};
    if (!isFork || parent?.full_name !== UPSTREAM) throw new Failure(`${fork} is not a fork of ${UPSTREAM}, so wingetcreate cannot submit from it: rename or delete it.`);
    const sync = gh(['api', '-X', 'POST', `repos/${fork}/merge-upstream`, '--input', '-'], { branch });
    if (!sync.ok) {
      const said = githubError(sync);
      error(`GitHub refused to sync ${fork}:${branch} with ${UPSTREAM}:\n${said}`);
      throw new Failure(syncAdvice(sync.status, said, fork));
    }
    log(`${fork}:${branch}: ${json(sync.stdout)?.message ?? 'synced with upstream'}.`);
  }

  const existing = gh(['api', '--silent', `repos/${UPSTREAM}/contents/${PACKAGE_PATH}`]);
  if (!existing.ok && existing.status !== 404) {
    error(githubError(existing));
    throw new Failure(`Could not read whether ${UPSTREAM} already holds ${PACKAGE}.`);
  }
  const title = submissionTitle(version, existing.ok);
  log(`Submitting "${title}".`);

  const { code, output } = await runTee(resolve(wingetcreate), ['submit', '--no-open', '--prtitle', title, manifests], { ...env, WINGET_CREATE_GITHUB_TOKEN: token });
  if (code !== 0) throw new Failure(`wingetcreate exited with ${code}: the submission was not opened.`);
  const number = Number(new RegExp(`https://github\\.com/${UPSTREAM}/pull/(\\d+)`).exec(output)?.[1]);
  if (!number) {
    log(`::warning::wingetcreate named no pull request on ${UPSTREAM}, so no older submission of ${PACKAGE} was closed.`);
    return { login, title, number: null, closed: [] };
  }

  const closed = [];
  const query = `repo:${UPSTREAM} is:pr is:open author:${login} in:title "${PACKAGE} version"`;
  const search = gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=100']);
  const items = search.ok ? json(search.stdout)?.items : null;
  if (!Array.isArray(items)) {
    log(`::warning::#${number} is open, but the older submissions of ${PACKAGE} could not be listed, so none was closed: ${githubError(search).replace(/\n/g, ' ')}`);
    return { login, title, number, closed };
  }
  for (const { number: older } of supersededBy(items, { login, number, version })) {
    const comment = gh(['api', '-X', 'POST', `repos/${UPSTREAM}/issues/${older}/comments`, '--input', '-'], { body: supersededComment(number, version) });
    const close = comment.ok ? gh(['api', '-X', 'PATCH', `repos/${UPSTREAM}/pulls/${older}`, '--input', '-'], { state: 'closed' }) : comment;
    if (close.ok) {
      closed.push(older);
      log(`Closed #${older}, superseded by #${number}.`);
    } else {
      log(`::warning::#${older} is still open: it could not be ${comment.ok ? 'closed' : 'commented on'} as superseded by #${number}: ${githubError(close).replace(/\n/g, ' ')}`);
    }
  }
  return { login, title, number, closed };
}

/** Runs a program with its output passed through as it comes, and kept. */
function runTee(command, args, env) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', (cause) => fail(new Failure(`${command} could not start: ${cause.message}`)));
    child.on('close', (code) => done({ code: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { version: { type: 'string' }, manifests: { type: 'string' }, wingetcreate: { type: 'string' } } });
  if (!values.version || !values.manifests || !values.wingetcreate) {
    console.error('usage: WINGET_TOKEN=... winget-submit.mjs --version <X.Y.Z> --manifests <dir> --wingetcreate <path>');
    process.exit(2);
  }
  try {
    await submit(values);
  } catch (cause) {
    if (!(cause instanceof Failure)) throw cause;
    console.log(`::error::${cause.message}`);
    process.exit(1);
  }
}
