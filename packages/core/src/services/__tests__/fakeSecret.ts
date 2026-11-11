/**
 * Fake credentials in real token shapes, assembled at runtime so no source
 * file holds a literal that GitHub push protection (or any scanner) would
 * flag. `fakeSecretsGuard.test.ts` fails if a literal creeps back in.
 */

const PARTS = {
  github: ['ghp_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8'],
  githubFineGrained: ['github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
  google: ['AIza', 'SyD-9fK2mQ7xR1tV4wY6zB8cE0gJ3lN5pS7u'],
  gitlab: ['glpat-', 'B7nQ2xR9mP4vK8tW6cH1'],
  stripeLive: ['sk_live_', 'a1b2c3d4e5f6g7h8i9j0k1l2'],
  stripeRestricted: ['rk_live_', 'a1b2c3d4e5f6g7h8i9j0k1l2'],
  huggingFace: ['hf_', 'B7nQ2xR9mP4vK8tW6cH1zL5dF0gA3sE'],
  npm: ['npm_', 'B7nQ2xR9mP4vK8tW6cH1zL5dF0gA3sE'],
  aws: ['AKIA', 'IOSFODNN7EXAMPLE'],
  slack: ['xoxb-', '123456789012-1234567890123-aBcDeFgHiJkLmNoP'],
  openai: ['sk-', 'proj-T3BlbkFJa1b2c3d4e5f6g7h8i9j0k1l2'],
  anthropic: ['sk-', 'ant-api03-9fK2mQ7xR1tV4wY6zB8cE0gJ3lN5pS7u'],
  openrouter: ['sk-or-v1-', '0123456789abcdef'.repeat(4)],
  jwt: ['eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
} as const;

export type FakeSecretKind = keyof typeof PARTS;

export function fakeSecret(kind: FakeSecretKind): string {
  return PARTS[kind].join('');
}
