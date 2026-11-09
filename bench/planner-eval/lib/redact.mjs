/**
 * Every line the bench prints or saves goes through `redactor`: a key reaches
 * this process only through its environment, and a planner's error message, a
 * daemon log or a captured terminal can echo it back.
 */

/** Environment names whose values are secrets. */
export const SECRET_NAME = /(API_KEY|_TOKEN|SECRET|PASSWORD)$/i;

// OpenRouter's and Anthropic's key shapes, for a key that arrives under a name the list above misses.
const KEY_SHAPES = [/sk-or-v1-[A-Za-z0-9]{16,}/g, /sk-ant-[A-Za-z0-9_-]{16,}/g];

export const REDACTED = '[redacted]';

export function secretValues(env) {
  return Object.entries(env ?? {})
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value)
    // Longest first, so a key that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
}

/** A function that removes every secret value in `env`, and anything shaped like a key, from text. */
export function redactor(env = process.env, extra = []) {
  const values = [...secretValues(env), ...extra.filter((v) => typeof v === 'string' && v.length >= 8)];
  return (input) => {
    let text = typeof input === 'string' ? input : String(input);
    for (const value of values) text = text.split(value).join(REDACTED);
    for (const shape of KEY_SHAPES) text = text.replace(shape, REDACTED);
    return text;
  };
}

/** `JSON.stringify` through the redactor, for a record about to be written. */
export function redactJson(value, redact, space = 2) {
  return redact(JSON.stringify(value, null, space));
}
