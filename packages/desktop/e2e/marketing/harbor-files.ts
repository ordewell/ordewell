/**
 * The files of Harbor, the invented service the marketing captures run a plan
 * on, as its history leaves them: what each commit writes is in harbor.ts. The
 * task scenes in fakes/scene.mjs edit these texts by exact match, and the check
 * runs their tests for real, so a change here is a change to that scenario.
 *
 * Harbor runs its TypeScript as it is on Node 22.18 and later, with no build
 * and no dependency, so a task's worktree can run the suite with nothing
 * installed.
 */

export const PACKAGE = (version: string): string => `{
  "name": "harbor",
  "version": "${version}",
  "private": true,
  "description": "A small HTTP service for accounts and sign-in.",
  "type": "module",
  "scripts": {
    "start": "node src/server.ts",
    "test": "node --test --test-reporter=spec"
  },
  "engines": {
    "node": ">=22.18"
  }
}
`;

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
`;

export const GITIGNORE = 'node_modules/\n.env\n';

export const README_FIRST = `# harbor

A small HTTP service for accounts and sign-in.
`;

export const README = `# harbor

A small HTTP service for accounts and sign-in.

## Run it

Harbor runs on Node 22.18 or later, which runs its TypeScript as it is: there
is nothing to build and nothing to install.

\`\`\`sh
npm start     # listens on :8080, or on $PORT
npm test
\`\`\`

A demo account is seeded: \`demo@example.com\`, password \`harbor-demo\`.

## Layout

- \`src/app.ts\` routes each request to its handler.
- \`src/routes/\` holds one handler per endpoint.
- \`src/auth/\` hashes passwords and issues session tokens.

See [docs/api.md](docs/api.md) for the endpoints and
[docs/configuration.md](docs/configuration.md) for the settings.
`;

export const HTTP = `export interface Request {
  method: string;
  path: string;
  body?: unknown;
  /** The client's address, as the socket reports it. */
  ip: string;
}

export interface Response {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body };
}
`;

export const HEALTH = (uptime: string): string => `import { json, type Response } from '../http.ts';

export function health(startedAt: number, now: () => number = Date.now) {
  return async (): Promise<Response> => json(200, { status: 'ok', uptime: ${uptime} });
}
`;
export const UPTIME = '(now() - startedAt) / 1000';
export const UPTIME_WHOLE = 'Math.floor((now() - startedAt) / 1000)';

export const APP_FIRST = `import { json, type Request, type Response } from './http.ts';
import { health } from './routes/health.ts';

export interface AppOptions {
  now?: () => number;
}

type Handler = (request: Request) => Promise<Response>;

export function createApp(options: AppOptions = {}): Handler {
  const now = options.now ?? Date.now;
  const routes: Record<string, Handler> = {
    'GET /health': health(now(), now),
  };
  return async (request) => {
    const route = routes[\`\${request.method} \${request.path}\`];
    return route ? route(request) : json(404, { error: 'not_found' });
  };
}
`;

export const APP = `import { memorySessions, type Sessions } from './auth/sessions.ts';
import { json, type Request, type Response } from './http.ts';
import { health } from './routes/health.ts';
import { signIn } from './routes/signIn.ts';
import type { UserStore } from './users.ts';

export interface AppOptions {
  users: UserStore;
  sessions?: Sessions;
  now?: () => number;
}

type Handler = (request: Request) => Promise<Response>;

export function createApp(options: AppOptions): Handler {
  const now = options.now ?? Date.now;
  const routes: Record<string, Handler> = {
    'GET /health': health(now(), now),
    'POST /sign-in': signIn({ users: options.users, sessions: options.sessions ?? memorySessions() }),
  };
  return async (request) => {
    const route = routes[\`\${request.method} \${request.path}\`];
    return route ? route(request) : json(404, { error: 'not_found' });
  };
}
`;

/** The server at each step of its history: the port fixed, read from PORT, then each request logged. */
export const SERVER = (stage: 'first' | 'users' | 'port' | 'logged' | 'malformed'): string => {
  const users = stage === 'first' ? '' : `import { hashPassword } from './auth/passwords.ts';\n`;
  const usersImport = stage === 'first' ? '' : `import { memoryUsers } from './users.ts';\n`;
  const app = stage === 'first'
    ? 'const app = createApp();\n'
    : `const app = createApp({
  users: memoryUsers([{ id: 'u_demo', email: 'demo@example.com', passwordHash: hashPassword('harbor-demo') }]),
});
`;
  const body = stage === 'malformed'
    ? `  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'malformed_json' }));
    return;
  }
`
    : '  const body = text ? JSON.parse(text) : undefined;\n';
  const log = stage === 'logged' ? '  console.log(`${req.method} ${req.url} ${response.status}`);\n' : '';
  const port = stage === 'first' || stage === 'users' ? 'const port = 8080;\n' : 'const port = Number(process.env.PORT ?? 8080);\n';
  return `import { createServer } from 'node:http';
import { createApp } from './app.ts';
${users}${usersImport}
${app}
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
${body}  const response = await app({
    method: req.method ?? 'GET',
    path: new URL(req.url ?? '/', 'http://localhost').pathname,
    body,
    ip: req.socket.remoteAddress ?? '',
  });
  res.writeHead(response.status, response.headers);
  res.end(response.body === undefined ? undefined : JSON.stringify(response.body));
${log}});

${port}server.listen(port, () => console.log(\`harbor listening on :\${port}\`));
`;
};

export const USERS = `export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export interface UserStore {
  byEmail(email: string): User | undefined;
}

export function memoryUsers(users: readonly User[]): UserStore {
  const byEmail = new Map(users.map((user) => [user.email.toLowerCase(), user]));
  return { byEmail: (email) => byEmail.get(email.toLowerCase()) };
}
`;

export const PASSWORDS = `import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return \`\${salt.toString('hex')}:\${scryptSync(password, salt, KEY_LENGTH).toString('hex')}\`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}
`;

export const SESSIONS = `import { randomBytes } from 'node:crypto';

export interface Sessions {
  issue(userId: string): string;
}

export function memorySessions(): Sessions {
  const tokens = new Map<string, string>();
  return {
    issue(userId) {
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, userId);
      return token;
    },
  };
}
`;

export const SIGN_IN = `import { verifyPassword } from '../auth/passwords.ts';
import type { Sessions } from '../auth/sessions.ts';
import { json, type Request, type Response } from '../http.ts';
import type { UserStore } from '../users.ts';

export interface SignInDeps {
  users: UserStore;
  sessions: Sessions;
}

export function signIn({ users, sessions }: SignInDeps) {
  return async (request: Request): Promise<Response> => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) return json(400, { error: 'email_and_password_required' });
    const user = users.byEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return json(401, { error: 'invalid_credentials' });
    }
    return json(200, { token: sessions.issue(user.id) });
  };
}
`;

export const HEALTH_TEST = (options: string, uptime: string): string => `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
${options.includes('users') ? "import { memoryUsers } from '../src/users.ts';\n" : ''}
test('reports its uptime', async () => {
  let clock = 1_000;
  const app = createApp({ ${options}now: () => clock });
  clock += 2_500;
  const response = await app({ method: 'GET', path: '/health', ip: '127.0.0.1' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', uptime: ${uptime} });
});
`;

export const SIGN_IN_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { memoryUsers } from '../src/users.ts';

const users = memoryUsers([{ id: 'u_1', email: 'mara@example.com', passwordHash: hashPassword('correct horse') }]);
const app = createApp({ users });
const signIn = (password: string, email = 'mara@example.com') =>
  app({ method: 'POST', path: '/sign-in', body: { email, password }, ip: '203.0.113.7' });

test('signs in with the right password', async () => {
  const response = await signIn('correct horse');
  assert.equal(response.status, 200);
  assert.ok((response.body as { token: string }).token);
});

test('rejects a wrong password', async () => {
  assert.equal((await signIn('wrong')).status, 401);
});

test('rejects an unknown email', async () => {
  assert.equal((await signIn('correct horse', 'nobody@example.com')).status, 401);
});

test('asks for both fields', async () => {
  assert.equal((await signIn('', 'mara@example.com')).status, 400);
});
`;

export const API_DOCS = `# HTTP API

Every request and response body is JSON.

## GET /health

Answers \`200\` with \`{ "status": "ok", "uptime": <seconds> }\`.

## POST /sign-in

Signs in with an email and a password, and answers with a session token to
send as \`Authorization: Bearer <token>\`.

\`\`\`json
{ "email": "mara@example.com", "password": "correct horse" }
\`\`\`

| Status | Body | When |
| --- | --- | --- |
| 200 | \`{ "token": "…" }\` | The email and the password match. |
| 400 | \`{ "error": "email_and_password_required" }\` | A field is missing. |
| 401 | \`{ "error": "invalid_credentials" }\` | The email or the password is wrong. |
`;

export const CONFIG_DOCS = (server: string): string => `# Configuration

Harbor reads its settings from the environment.

| Variable | Default | What it sets |
| --- | --- | --- |
| \`PORT\` | \`8080\` | The port the ${server} listens on. |
`;

export const CHANGELOG = (unreleased: readonly string[]): string => `# Changelog

## Unreleased

${unreleased.map((line) => `- ${line}\n`).join('')}${unreleased.length ? '\n' : ''}## 0.1.0

- \`POST /sign-in\` signs in with an email and a password and answers with a session token.
- Passwords are hashed with scrypt.
- \`PORT\` sets the port the server listens on.
- \`GET /health\` reports the service's uptime.
`;
export const LOGGED = 'Each request is logged with its method, path and status.';

export const CI = (on: string): string => `name: ci
on: ${on}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
`;

export const RESET_TOKENS = `import { randomBytes } from 'node:crypto';

export interface ResetTokens {
  issue(userId: string): string;
  redeem(token: string): string | undefined;
}

export function memoryResetTokens(ttlMs: number, now: () => number = Date.now): ResetTokens {
  const tokens = new Map<string, { userId: string; expires: number }>();
  return {
    issue(userId) {
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, { userId, expires: now() + ttlMs });
      return token;
    },
    redeem(token) {
      const found = tokens.get(token);
      tokens.delete(token);
      return found && found.expires > now() ? found.userId : undefined;
    },
  };
}
`;

export const MAIL = `export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export const consoleMailer: Mailer = {
  async send({ to, subject }) {
    console.log(\`mail to \${to}: \${subject}\`);
  },
};
`;

export const PASSWORD_RESET = `import type { ResetTokens } from '../auth/resetTokens.ts';
import { json, type Request, type Response } from '../http.ts';
import type { Mailer } from '../mail.ts';
import type { UserStore } from '../users.ts';

export interface ResetDeps {
  users: UserStore;
  tokens: ResetTokens;
  mailer: Mailer;
  baseUrl: string;
}

export function requestReset({ users, tokens, mailer, baseUrl }: ResetDeps) {
  return async (request: Request): Promise<Response> => {
    const { email } = (request.body ?? {}) as { email?: string };
    const user = email ? users.byEmail(email) : undefined;
    if (user) {
      const link = \`\${baseUrl}/reset?token=\${tokens.issue(user.id)}\`;
      await mailer.send({ to: user.email, subject: 'Reset your harbor password', text: \`Open \${link} within the hour.\` });
    }
    // The same answer either way, so the endpoint does not tell who has an account.
    return json(202, { status: 'sent_if_known' });
  };
}
`;

/** The files on main once its history is written, before any task runs: what the offline check of the scenes starts from. */
export function mainFiles(): Record<string, string> {
  return {
    'package.json': PACKAGE('0.1.0'),
    'tsconfig.json': TSCONFIG,
    '.gitignore': GITIGNORE,
    'README.md': README,
    'CHANGELOG.md': CHANGELOG([LOGGED]),
    '.github/workflows/ci.yml': CI('push'),
    'docs/api.md': API_DOCS,
    'docs/configuration.md': CONFIG_DOCS('sever'),
    'src/http.ts': HTTP,
    'src/app.ts': APP,
    'src/server.ts': SERVER('logged'),
    'src/users.ts': USERS,
    'src/auth/passwords.ts': PASSWORDS,
    'src/auth/sessions.ts': SESSIONS,
    'src/routes/health.ts': HEALTH(UPTIME),
    'src/routes/signIn.ts': SIGN_IN,
    'test/health.test.ts': HEALTH_TEST('users: memoryUsers([]), ', '2.5'),
    'test/signIn.test.ts': SIGN_IN_TEST,
  };
}
