/**
 * The tips an empty planner chat composer shows (#137), one table for every
 * surface so the TUI and the webview agree on the wording and how often each
 * comes round. A surface offers only the tips for the commands it answers.
 */

export interface ComposerTip {
  /** The built-in planner chat command the tip names, without its slash. */
  command: string;
  /** How many times per cycle the tip comes round. */
  weight: number;
  /** Short enough to fit after the prompt and caret on an 80-column terminal. */
  text: string;
}

export const COMPOSER_TIPS: readonly ComposerTip[] = [
  // The per-runner model allowlist (ADR-0003) is the easiest command to miss.
  { command: 'allowlist', weight: 3, text: 'Tip: Use /allowlist to limit which models the planner assigns per runner.' },
  { command: 'planner', weight: 1, text: "Tip: Use /planner to pick the planner's harness, model and effort." },
  { command: 'runners', weight: 1, text: 'Tip: Use /runners to turn runners on or off.' },
  { command: 'settings', weight: 1, text: 'Tip: Use /settings for autonomy, supervisor, merging, autorun and more.' },
  { command: 'help', weight: 1, text: 'Tip: Use /help to list every command.' },
];

/**
 * One cycle of `tips`, each appearing exactly its weight times. Every slot takes
 * the tip with the most weight left other than the one just taken, so a heavy
 * tip is spread out rather than shown twice running; only when nothing else
 * has weight left does it repeat.
 */
export function tipCycle(tips: readonly ComposerTip[]): ComposerTip[] {
  const left = tips.map((tip) => tip.weight);
  const cycle: ComposerTip[] = [];
  let last = -1;
  for (let slot = 0, total = left.reduce((a, b) => a + b, 0); slot < total; slot++) {
    let pick = -1;
    for (let i = 0; i < tips.length; i++) {
      if (left[i] <= 0 || (i === last && left.some((n, j) => j !== last && n > 0))) continue;
      if (pick < 0 || left[i] > left[pick]) pick = i;
    }
    left[pick]--;
    cycle.push(tips[pick]);
    last = pick;
  }
  return cycle;
}

/**
 * The tip for the `seq`-th time the composer has been empty, among those for
 * the commands the surface answers, or null when it answers none of them. The
 * same `seq` always gives the same tip, so the surface decides when a new one
 * shows by when it moves `seq` on, and its rendering stays a function of state.
 */
export function composerTip(seq: number, answers: ReadonlySet<string>): string | null {
  const cycle = tipCycle(COMPOSER_TIPS.filter((tip) => answers.has(tip.command)));
  if (cycle.length === 0) return null;
  return cycle[((seq % cycle.length) + cycle.length) % cycle.length].text;
}
