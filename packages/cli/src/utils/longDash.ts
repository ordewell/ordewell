// Unicode dashes that keyboards and apps substitute for `--`:
// hyphen, non-breaking hyphen, figure dash, en dash, em dash, horizontal bar, minus sign.
const LONG_DASH_RUN = /^[‐-―−]+/;

const KNOWN_LONG = new Set(['help', 'version', 'workspace', 'port']);
const KNOWN_SHORT = new Set(['h', 'v']);

/**
 * When a top-level argument starts with a run of Unicode dashes where `--` was
 * meant, the option it probably stands for. Parsing stays strict: the caller
 * only uses this to say "did you mean".
 */
export function suggestForLongDash(arg: string): string | undefined {
  const run = LONG_DASH_RUN.exec(arg);
  if (!run) return undefined;
  const name = arg.slice(run[0].length);
  if (run[0].length === 1 && KNOWN_SHORT.has(name)) return `-${name}`;
  return KNOWN_LONG.has(name) ? `--${name}` : undefined;
}
