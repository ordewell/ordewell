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
/** A task's own copy of a person's sign-in, the only one a runner ever sees. */
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
 * Run in a helper once the attempt's container has gone, so nothing of the
 * attempt is alive to change what is read. The snapshot holds what the attempt
 * left uncommitted, on top of its last commit, and leaves its index alone.
 */
export const EXPORT_SCRIPT = String.raw`set -eu
cd "$ORDEWELL_REPO_DIR"
export GIT_INDEX_FILE=/tmp/ordewell-export-index
git read-tree HEAD
git -c core.hooksPath=/dev/null add -A -- .
tree=$(git write-tree)
snapshot=$(git -c user.name=ordewell -c user.email=ordewell@localhost commit-tree "$tree" -p HEAD -m "The attempt's work")
git update-ref "$ORDEWELL_REF" "$snapshot"
exec git bundle create -q - "$ORDEWELL_REF" "^$ORDEWELL_BASE"
`;
