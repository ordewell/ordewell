import { tryGit, type GitInvoker } from './gitExec';

// Every way git says it will not commit for want of a name or an email: the
// banner it prints first, and the fatal line, which varies with what it could not guess.
const NO_IDENTITY = /(Author|Committer) identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email address|no (name|email) was given and auto-detection is disabled/i;

/** Whether what git said refuses a commit because it knows no author or committer. */
export function lacksIdentity(gitSaid: string | undefined): boolean {
  return gitSaid !== undefined && NO_IDENTITY.test(gitSaid);
}

/**
 * The fix, in the user's hands: Ordewell never makes up an identity for the
 * work it commits on their behalf, since the commits land on their branch.
 */
export const IDENTITY_FIX = 'git has no author identity to commit with: set one with `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` (without --global for this repository alone)';

/**
 * Why git cannot commit in `cwd`, in git's own last line, asked before a run commits anything: null
 * when it knows both who authors and who commits there. `git var` resolves
 * them as `git commit` would, from the environment and every config git reads.
 */
export async function identityRefusal(invoker: GitInvoker, cwd: string): Promise<string | null> {
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const asked = await tryGit(invoker, cwd, ['var', ident]);
    if (asked.ok) continue;
    const said = asked.stderr.trim();
    // A refusal for some other reason (no repository, no git) is not this check's to report.
    if (!lacksIdentity(said)) continue;
    // Git's banner tells the fix the caller tells; its last line says what was missing.
    return said.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? said;
  }
  return null;
}
