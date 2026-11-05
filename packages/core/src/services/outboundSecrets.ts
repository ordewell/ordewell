/**
 * The outbound secret check (ADR-0027): whether text about to leave the
 * machine on the planner's behalf — a URL, a search query — carries a secret.
 * It narrows exfiltration through a URL; it does not close it. A secret that
 * is base64'd, reversed or split across requests passes.
 */

import { isCredentialVariable } from './harness/credentialEnv';

const SENSITIVE_ENV_NAME = /(?:^|_)(?:KEY|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;
/** Below this, a value is too likely to occur in an ordinary URL (`true`, `1`, `dev`) to mean anything. */
const MIN_SECRET_LENGTH = 8;
const MAX_DECODE_ROUNDS = 3;

export const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\b(?:hf|npm)_[A-Za-z0-9]{20,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z0-9 ]+-----/,
];

/**
 * `sk-` prefixes most LLM provider keys, and also ordinary slugs
 * (`sk-learn-tutorial`). A key's random tail mixes cases and digits; a slug
 * does not.
 */
const SK_KEY = /\bsk-[A-Za-z0-9_-]{20,}/g;

function looksRandom(tail: string): boolean {
  return /[a-z]/.test(tail) && /[A-Z]/.test(tail) && /\d/.test(tail);
}

/** Decode what decodes: one malformed `%zz` must not hide the rest. */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The text as sent and as each layer of percent-encoding would read it. */
function forms(text: string): string[] {
  const seen = [text, text.replace(/\+/g, ' ')];
  let current = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = percentDecode(current);
    if (next === current) break;
    seen.push(next, next.replace(/\+/g, ' '));
    current = next;
  }
  return seen;
}

/**
 * The secret a URL's userinfo carries: its password, or, with none, its user,
 * which is where a DSN puts its key. A tool that fails to connect tends to
 * print the URL with its parts rearranged, so the whole value alone is not enough.
 */
function userinfoSecret(value: string): string | undefined {
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@\s]+)@/i.exec(value)?.[1];
  if (!userinfo) return undefined;
  const colon = userinfo.indexOf(':');
  const secret = colon >= 0 ? userinfo.slice(colon + 1) : userinfo;
  try {
    return decodeURIComponent(secret);
  } catch {
    return secret;
  }
}

/**
 * The values of environment variables named like a credential: by the generic
 * name test, or by the curated names and shapes the native shell withholds
 * (ADR-0036 N2.2), whose `*_URL` and `PGPASSWORD` the generic test cannot know.
 */
export function sensitiveEnvValues(env: Record<string, string | undefined>): string[] {
  // A slash or colon can be part of a secret, so only the name identifies a reference.
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const generic = SENSITIVE_ENV_NAME.test(name) && !/_(?:URL|URI|PATH|FILE|DIR)$/i.test(name);
    if (!generic && !isCredentialVariable(name)) continue;
    values.push(value.trim());
    const part = userinfoSecret(value.trim());
    if (part) values.push(part);
  }
  return values;
}

/** Whether any of `texts`, raw or decoded, contains a held secret or a well-known token. */
export function carriesSecret(texts: readonly string[], held: Iterable<string>): boolean {
  const secrets = [...held].map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET_LENGTH);
  return texts.flatMap(forms).some((text) =>
    secrets.some((secret) => text.includes(secret))
    || TOKEN_SHAPES.some((shape) => shape.test(text))
    || [...text.matchAll(SK_KEY)].some((m) => looksRandom(m[0].slice(3))));
}
