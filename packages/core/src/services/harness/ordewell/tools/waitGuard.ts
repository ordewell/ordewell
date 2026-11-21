/**
 * A change task that waits inside its attempt for another task's work holds
 * one of the run's slots and spends model calls while nothing it can change
 * moves. In a recorded run two slices made 14 and 17 calls of `sleep 240` to
 * `sleep 300` between 33 and 40 polls of the run's branch, for 78 and 84
 * minutes, though their brief told them not to wait. The built-in runner's
 * shell refuses such a command before it runs, saying what to do instead; a
 * short sleep, such as one in a loop that waits for a server it started, runs.
 */

/** The longest one command may sleep in all. */
export const SLEEP_LIMIT_S = 30;

/** The longest one turn of a loop may sleep: a loop that sleeps longer is polling for something outside the task. */
export const POLL_SLEEP_LIMIT_S = 5;

const UNIT_S: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };

/** A number as `sleep` reads one: `240`, `1.5`, `1e3`, or `inf`, which never ends. */
const DURATION = /(inf(?:inity)?)\b|((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([smhd]?)/g;

/** `sleep` where a shell runs it: first on the line, after an operator, or after a keyword that runs what follows. */
const SHELL_SLEEP = /(?:^|[;&|({`\n]|\$\(|\b(?:do|then|else|nohup|exec|time)[ \t])[ \t]*sleep[ \t]+((?:(?:inf(?:inity)?\b|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[smhd]?)[ \t]*)+)/g;

/**
 * The part of a command line that runs: its quoted strings left out, since a
 * `grep "sleep 45"` or a `sed` that edits a sleep out waits for nothing, but
 * for one that `-c` or `-Command` hands a shell or an interpreter, read the
 * same way as a command of its own.
 */
function codeOf(command: string, depth = 0): string {
  let code = '';
  for (let i = 0; i < command.length;) {
    const quote = command[i];
    if (quote !== '"' && quote !== "'") {
      code += quote;
      i++;
      continue;
    }
    let inner = '';
    let j = i + 1;
    for (; j < command.length && command[j] !== quote; j++) {
      if (quote === '"' && command[j] === '\\' && j + 1 < command.length) j++;
      inner += command[j];
    }
    code += depth < 2 && /(?:^|\s)-(?:c|Command)\s+$/i.test(code) ? `;${codeOf(inner, depth + 1)};` : ' ';
    i = j + 1;
  }
  return code;
}

/** Each literal sleep a command line runs, in seconds: `sleep 240`, `sleep 4m`, `time.sleep(300)`, `Start-Sleep -Seconds 60`. */
export function sleepsIn(command: string): number[] {
  const code = codeOf(command);
  const found: number[] = [];
  for (const m of code.matchAll(SHELL_SLEEP)) {
    for (const part of m[1].matchAll(DURATION)) found.push(part[1] ? Infinity : Number(part[2]) * UNIT_S[part[3]]);
  }
  for (const m of code.matchAll(/\btime\.sleep\s*\(\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/g)) found.push(Number(m[1]));
  for (const m of code.matchAll(/\bStart-Sleep\s+(?:-Seconds\s+|-s\s+)?(\d+)/gi)) found.push(Number(m[1]));
  return found;
}

/** A shell loop, or a language's, around the command's sleeps. */
const LOOP = /\b(?:while|until|for)\b[\s\S]*\bdo\b|\bwhile\s*(?:True|true|\(|1\b)|\bwatch\s+-n/;

/**
 * Why `command` is refused as a wait, or null when it runs. `parks`: the
 * task's tools include `wait_for`, which ends the attempt and continues it
 * once the work it names has landed.
 */
export function waitRefusal(command: string, opts: { parks?: boolean } = {}): string | null {
  const sleeps = sleepsIn(command);
  if (sleeps.length === 0) return null;
  const total = sleeps.reduce((a, b) => a + b, 0);
  const polls = LOOP.test(codeOf(command)) && Math.max(...sleeps) > POLL_SLEEP_LIMIT_S;
  if (total <= SLEEP_LIMIT_S && !polls) return null;
  const what = polls ? 'polls in a loop, sleeping between tries' : total === Infinity ? 'sleeps with no end' : `sleeps for ${Math.round(total)} seconds`;
  const instead = opts.parks
    ? 'If you are waiting for work another task has not landed yet, call `wait_for` with those tasks: this attempt ends, its worktree and session are kept, and it continues here once they have landed, with no slot held meanwhile. Otherwise finish your own part and end as your brief says, naming each check that needs that work, and the task whose work it needs, in a finding.'
    : 'If you are waiting for work another task has not landed yet, do not: finish your own part and end as your brief says, naming each check that needs that work, and the task whose work it needs, in a finding.';
  return `Not run: this command ${what}. Waiting inside a task holds one of the run's slots and spends calls while nothing you can change moves. ${instead} To wait for a process you started, use \`wait <PID>\`, or a sleep of at most ${SLEEP_LIMIT_S} seconds.`;
}
