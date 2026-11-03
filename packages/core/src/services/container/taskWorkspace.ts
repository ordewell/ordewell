import { createHash } from 'crypto';
import { posix } from 'path';
import { tryGit, type GitInvoker } from '../gitExec';
import { SELF_REPO } from '../isolationRecord';
import type { LeaseRepo } from '../executionLease';

/*
 * Where a lease's work lives, all of it in the engine's own volumes: on a Mac a
 * host path, a host socket and an APFS clone do not cross into the VM, so none
 * is used (ADR-0059 L6). `/mirror` is one bare repository per repo, read-only to
 * an attempt; `/task` is the task's, kept across its attempts, so a Continue
 * finds the runner's saved session in `/task/home` (L2).
 */
export const MIRROR_ROOT = '/mirror';
export const TASK_ROOT = '/task';
export const WORK_ROOT = `${TASK_ROOT}/work`;
export const HOME_DIR = `${TASK_ROOT}/home`;
/**
 * A task's own copy of a person's sign-in, the only one a runner ever sees. A
 * copy is replaced only when the kept sign-in changed: a runner's refresh writes
 * the copy alone, and a Continue that copied again would hand back a token that
 * no longer works (ADR-0059 L7). The mark is the task's to write, so only a plain
 * file is read: a pipe there would hold the helper, and the attempt's start with it.
 */
export const signInCopy = (mounted: string, copy: string, mark: string): string => String.raw`set -eu
[ -n "$(ls -A ${mounted} 2>/dev/null)" ] || { echo 'the sign-in volume holds no sign-in' >&2; exit 3; }
kept=$(cd ${mounted} && find . -type f -exec cksum {} + 2>/dev/null | sort | cksum)
[ ! -f ${mark} ] || [ -L ${mark} ] || [ "$(cat ${mark})" != "$kept" ] || exit 0
mkdir -p ${copy}
cp -a ${mounted}/. ${copy}/
chmod -R go-rwx ${copy}
rm -rf ${mark}
printf %s "$kept" > ${mark}
`;

/** Claude Code's copy, as code before every runner had one names it. New code asks its runner (ADR-0059 L7). */
export const SIGN_IN_COPY = `${TASK_ROOT}/login/claude`;
/** Which sign-in that copy came from, as a checksum. The task can write it, and only for itself: it holds the copy. */
const SIGN_IN_MARK = `${TASK_ROOT}/login/handed`;

/** Where a repo of the workspace is, in a container. */
export const repoDir = (repo: Pick<LeaseRepo, 'path'>): string => (repo.path === SELF_REPO ? WORK_ROOT : posix.join(WORK_ROOT, repo.path));

/** A repo's mirror, in a container. By a hash of its path: it goes unquoted through `ext::`, and two repos of a group must not share one. */
export const mirrorDir = (repo: Pick<LeaseRepo, 'path'>): string => posix.join(MIRROR_ROOT, `${repo.path === SELF_REPO ? 'self' : createHash('sha256').update(repo.path).digest('hex').slice(0, 16)}.git`);

export const exportRef = (attempt: string): string => `refs/ordewell/export/${attempt}`;

/**
 * Seen from `git receive-pack`, in a helper with the mirror writable and no
 * agent ever in it. Nothing prunes under a lease: on git 2.56 a pruned mirror
 * broke a `--shared` clone with `bad object HEAD` (measured 2026-10-31).
 */
const receiveScript = (mirror: string) => `set -e; [ -d ${mirror} ] || git init -q --bare ${mirror}; cd ${mirror}; git config gc.auto 0; git config gc.pruneExpire never; git config receive.autogc false; exec git receive-pack .`;

/** git's `ext::` transport splits a command on spaces, and has its own escape for one. */
const extArgument = (arg: string): string => arg.replace(/%/g, '%%').replace(/ /g, '% ');

export const pinRefs = (pin: string, head: string, integration: string): string[] => [
  `+${head}:refs/ordewell/pins/${pin}/head`,
  `+${integration}:refs/ordewell/pins/${pin}/integration`,
];

/**
 * Push refs into a repo's mirror, as git negotiates it, so only what the mirror
 * lacks crosses. `helper` is the `docker run` arguments of a throwaway container
 * with the mirror writable. A concurrent first push can lose the race on the
 * mirror's config, so it is tried once more.
 */
export async function pushToMirror(invoker: GitInvoker, repo: LeaseRepo, helper: readonly string[], refspecs: readonly string[]): Promise<void> {
  const remote = `ext::${['docker', ...helper, 'sh', '-c', receiveScript(mirrorDir(repo))].map(extArgument).join(' ')}`;
  const push = () => tryGit(invoker, repo.root, ['-c', 'protocol.ext.allow=always', '-c', 'core.hooksPath=/dev/null', 'push', '-q', '--no-verify', remote, ...refspecs]);
  const pushed = await push();
  if (pushed.ok) return;
  const again = await push();
  if (!again.ok) throw new Error(`Could not update the repository's mirror: ${again.stderr.trim() || pushed.stderr.trim()}`);
}

/**
 * Asks the harness whether what `/login` keeps is a login, which files there do
 * not say: an abandoned sign-in leaves some. It answers from those files with no
 * network, so it proves a login is held and never that one still works. Its
 * answer, which can name the account, stays in the helper, and it runs from a
 * home of its own, so nothing a task wrote reaches it as settings.
 */
export const ASK_SIGN_IN = 'cd /tmp && HOME=/tmp CLAUDE_CONFIG_DIR=/login/claude claude auth status >/dev/null 2>&1';

/**
 * Run in a helper with the kept sign-in read-only at `/login`. A task's copy is
 * replaced only by a new sign-in: a refresh writes to the copy alone and can leave
 * what is kept dead, so a Continue that copied again would hand back a token that
 * no longer works (measured with the real binary 2026-11-02, ADR-0059 L7). The mark
 * is the task's to write, so only a plain file is read: a pipe there would hold the
 * helper, and the attempt's start with it.
 */
export const COPY_SIGN_IN = String.raw`set -eu
(${ASK_SIGN_IN}) || { echo 'the sign-in volume holds no sign-in' >&2; exit 3; }
kept=$(cat /login/claude/.credentials.json /login/claude/.claude.json 2>/dev/null | cksum)
[ ! -f ${SIGN_IN_MARK} ] || [ -L ${SIGN_IN_MARK} ] || [ "$(cat ${SIGN_IN_MARK})" != "$kept" ] || exit 0
mkdir -p ${SIGN_IN_COPY}
cp -a /login/claude/. ${SIGN_IN_COPY}/
chmod -R go-rwx ${SIGN_IN_COPY}
rm -rf ${SIGN_IN_MARK}
printf %s "$kept" > ${SIGN_IN_MARK}
`;

/**
 * Where Codex looks for a sign-in under the task's home, so its sessions stay
 * there too, for a Continue. A task's copy, not the person's: see {@link COPY_CODEX_SIGN_IN}.
 */
export const CODEX_SIGN_IN_FILE = `${HOME_DIR}/.codex/auth.json`;

/**
 * Codex's refresh token rotates: two tasks spending one lose the sign-in, and
 * OpenAI forbids sharing an auth.json between jobs. So a task's copy holds no
 * refresh token: every task can use the kept access token at once, and none can
 * spend what a person has to sign in again to replace. It is stamped as fresh, or
 * Codex would try a refresh that cannot work while the token still can. An API
 * key does not belong in this volume, and an access token past its time is a
 * refusal here, not a task that fails on its first turn. Written anew with its
 * name removed first, so whatever an earlier attempt left there is not followed.
 */
export const COPY_CODEX_SIGN_IN = String.raw`
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { dirname } = require('path');
const refuse = (why) => { console.error(why); process.exit(3); };
const decoded = (text) => JSON.parse(Buffer.from(text, 'base64url').toString());
let kept;
try { kept = JSON.parse(readFileSync('/login/codex/auth.json', 'utf8')); } catch { refuse('the sign-in volume holds no sign-in'); }
if (kept.OPENAI_API_KEY) refuse('the sign-in volume holds an API key, which belongs in a broker login');
const { id_token, access_token, account_id } = kept.tokens ?? {};
if (typeof id_token !== 'string' || typeof access_token !== 'string') refuse('the sign-in volume holds no ChatGPT sign-in');
let expires = 0;
try { expires = decoded(access_token.split('.')[1]).exp * 1000; } catch { refuse('the kept sign-in cannot be read'); }
if (!(expires > Date.now())) refuse('the kept sign-in has expired');
const file = ${JSON.stringify(CODEX_SIGN_IN_FILE)};
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
rmSync(file, { force: true, recursive: true });
writeFileSync(file, JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { id_token, access_token, refresh_token: '', account_id },
  last_refresh: new Date().toISOString(),
}), { mode: 0o600, flag: 'wx' });
`;

/** Where OpenCode keeps its providers' logins under the task's home, its own copy of what a person signed in to. */
export const OPENCODE_SIGN_IN_COPY = `${TASK_ROOT}/login/opencode`;

/** Which sign-in that copy came from, as a checksum: OpenCode's own, beside Claude Code's. */
const OPENCODE_SIGN_IN_MARK = `${TASK_ROOT}/login/handed-opencode`;

/** OpenCode's copy: the sign-in volume's data directory, read-only to the helper and writable only in the task's own volume. */
export const COPY_OPENCODE_SIGN_IN = signInCopy('/login/opencode', OPENCODE_SIGN_IN_COPY, OPENCODE_SIGN_IN_MARK);

/**
 * Run in the attempt's container, before its runner. The clone shares the
 * mirror's objects, and a clone a later attempt finds is put back on what the
 * host holds: the host is what a Continue or a repair restored. Ignored files
 * stay, so what an earlier attempt installed is still there.
 */
export const SEED_SCRIPT = String.raw`set -eu
mkdir -p "$ORDEWELL_REPO_DIR" "$HOME"
cd "$ORDEWELL_REPO_DIR"
[ -e .git ] || git clone -q --shared --no-checkout "$ORDEWELL_MIRROR" . 2>/dev/null
git config user.name "$ORDEWELL_GIT_NAME"
git config user.email "$ORDEWELL_GIT_EMAIL"
git fetch -q origin "+refs/ordewell/pins/$ORDEWELL_PIN/*:refs/ordewell/seed/*"
git checkout -q -f -B "$ORDEWELL_BRANCH" refs/ordewell/seed/head
[ "$ORDEWELL_INTEGRATION" = HEAD ] || git branch -q -f "$ORDEWELL_INTEGRATION" refs/ordewell/seed/integration
git clean -fdq
`;

/**
 * Run in a helper once the attempt's container has gone, so no process of the
 * attempt is alive. The snapshot holds what the attempt left uncommitted, on top
 * of its last commit, and leaves its index alone.
 *
 * The repository is the attempt's, `.git` included, so git here does what that
 * says: the wrapper stops its hooks, an index write's and a ref update's among
 * them, and its fsmonitor, but no flag reaches a filter, whose name it chose. So
 * a clean filter it configured runs here, and could change what is read. It runs
 * in a helper with no network and the mirror read-only, and what it leaves goes
 * through the push gate like any other work (ADR-0059 L6).
 */
export const EXPORT_SCRIPT = String.raw`set -eu
cd "$ORDEWELL_REPO_DIR"
export GIT_INDEX_FILE=/tmp/ordewell-export-index
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
git read-tree HEAD
git add -A -- .
tree=$(git write-tree)
snapshot=$(git -c user.name=ordewell -c user.email=ordewell@localhost commit-tree "$tree" -p HEAD -m "The attempt's work")
git update-ref "$ORDEWELL_REF" "$snapshot"
git bundle create -q - "$ORDEWELL_REF" "^$ORDEWELL_BASE"
`;
