/**
 * What the first-run specs (firstRun.*.spec.ts) share beyond fixtures.ts: a
 * planner endpoint that holds each turn until the spec lets it go and then
 * answers through bench/live's mock or fails it, a Claude Code that reports
 * itself signed out, the daemon's own answers, and one app launched on a
 * workspace with its window and planner tab ready.
 */
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, openFolder, removeSandbox, runnersKnown, startMock, untilListening, type EnvOptions, type Sandbox } from './fixtures';

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The planner endpoint as a spec drives it. */
export interface HeldPlanner {
  readonly port: number;
  /** Completion requests the daemon has made. */
  requests(): number;
  /** Held requests whose connection the daemon closed before they were let go. */
  abandoned(): number;
  /** Requests answered in full. */
  answered(): number;
  /** Lets every held request, and every later one, through. */
  release(): void;
  /** Holds each later request again, until the next {@link release}. */
  hold(): void;
  /** Fails the next request let through with `message`, as `failWith` fails every one. */
  failNext(message: string): void;
  close(): Promise<void>;
}

/**
 * A planner endpoint between the daemon and bench/live's mock on `upstream`.
 * While `held`, a completion request waits; once released it is forwarded to
 * the mock and its stream piped back, or, with `failWith`, answered as a
 * provider refuses a request (400, which no client retries), with that
 * message: a turn that started and then failed.
 */
export async function startHeldPlanner(upstream: number, options: { held?: boolean; failWith?: string } = {}): Promise<HeldPlanner> {
  let held = options.held ?? true;
  let requests = 0;
  let abandoned = 0;
  let answered = 0;
  let failOnce: string | undefined;
  const waiting = new Set<() => void>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end('not found'); return; }
      requests += 1;
      let closed = false;
      res.on('close', () => { if (!res.writableFinished) closed = true; });
      const go = (): void => {
        if (closed) { abandoned += 1; return; }
        const failure = failOnce ?? options.failWith;
        failOnce = undefined;
        if (failure !== undefined) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: failure, type: 'invalid_request_error' } }));
          answered += 1;
          return;
        }
        const body = Buffer.concat(chunks);
        const forward = http.request({
          host: '127.0.0.1', port: upstream, method: 'POST', path: req.url,
          headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        }, (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
          answer.on('end', () => { answered += 1; });
        });
        forward.on('error', () => res.destroy());
        forward.end(body);
      };
      if (!held) { go(); return; }
      waiting.add(go);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the held planner has no address');
  return {
    port: address.port,
    requests: () => requests,
    abandoned: () => abandoned,
    answered: () => answered,
    release: () => {
      held = false;
      for (const go of waiting) go();
      waiting.clear();
    },
    hold: () => { held = true; },
    failNext: (message) => { failOnce = message; },
    close: async () => {
      held = false;
      waiting.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A `claude` that is installed and answers the host's probes as the real CLI
 * does when nobody is logged in. Anything else it is asked to run is a turn,
 * which it records in `turns` and refuses as the real CLI does signed out.
 * Its directory goes on PATH ahead of bench/pipeline's signed-in fake.
 */
export function signedOutClaude(sandbox: Sandbox): { bin: string; turns: string } {
  const bin = path.join(sandbox.tmp, 'signed-out-bin');
  const turns = path.join(sandbox.tmp, 'signed-out-turns.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('2.0.0 (Claude Code)\\n'); process.exit(0); }
if (argv[0] === '--help') { process.stdout.write('Usage: claude [options] [prompt]\\n\\n  --model <model>  Model for the current session.\\n'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none' }) + '\\n'); process.exit(1); }
fs.appendFileSync(${JSON.stringify(turns)}, JSON.stringify(argv) + '\\n');
process.stdout.write('Invalid API key · Please run /login\\n');
process.exit(1);
`, { mode: 0o755 });
  // Windows starts no file by its shebang: the shims npm would write beside it, as bench/pipeline's fake has.
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@node "%~dp0claude" %*\r\n');
  fs.writeFileSync(path.join(bin, 'claude.ps1'), '& node "$PSScriptRoot/claude" $args\r\nexit $LASTEXITCODE\r\n');
  return { bin, turns };
}

/** A call to `port`'s daemon with the token it wrote under the sandbox's HOME. */
export async function daemonCall(sandbox: Sandbox, port: number, route: string): Promise<unknown> {
  const token = fs.readFileSync(path.join(sandbox.home, '.ordewell', `server-${port}.token`), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${token}` } });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`GET ${route} answered ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

/** Every session file saved under `workspace`, as text, for a spec to look for a goal or a plan in. */
export function savedSessions(workspace: string): string[] {
  const dir = path.join(workspace, '.ordewell', 'sessions');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  const texts: string[] = [];
  for (const name of names) {
    try { texts.push(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* a file mid-write is read on the next look */ }
  }
  return texts;
}

/** Holds `check` to true for `ms`, looking every 250 ms: the way to say something never happens. */
export async function holdsFor(ms: number, check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!await check()) throw new Error(`expected ${what} to hold for ${ms / 1000} s, and it stopped holding`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The Sessions sidebar, shown. Clicking the activity already shown collapses it, so it is clicked only when hidden. */
export async function sessionsSidebar(win: Page): Promise<Locator> {
  const sidebar = win.getByRole('navigation', { name: 'Sessions' });
  if (!await sidebar.isVisible()) await win.getByRole('navigation', { name: 'Views' }).getByRole('tab', { name: /^Sessions/ }).click();
  await expect(sidebar).toBeVisible();
  return sidebar;
}

export interface FirstRunOptions extends EnvOptions {
  /** The workspace the window opens, when it is not the sandbox's repository. */
  readonly workspace?: (sandbox: Sandbox) => string;
  /** The planner endpoint's behaviour; omitted, the daemon talks to bench/live's mock directly. */
  readonly planner?: { held?: boolean; failWith?: string };
  /** Environment laid over appEnv's, given the sandbox. */
  readonly env?: (sandbox: Sandbox, base: Record<string, string>) => Record<string, string>;
}

/** One app on one workspace, with what a spec drives and what it tears down. */
export interface FirstRun {
  readonly sandbox: Sandbox;
  readonly app: ElectronApplication;
  readonly win: Page;
  readonly workspace: string;
  readonly daemonPort: number;
  readonly planner?: HeldPlanner;
  /** The centre, where the planner tab and its composer are. */
  readonly editor: Locator;
  readonly composer: Locator;
  /** Screenshots and the trace on failure, then everything closed and removed. */
  finish(testInfo: TestInfo): Promise<void>;
}

/** Launches the app offline on a fresh sandbox, opens the workspace, and opens a new session's planner tab. */
export async function startFirstRun(prefix: string, options: FirstRunOptions = {}): Promise<FirstRun> {
  const sandbox = makeSandbox(prefix);
  let mock: ChildProcess | undefined;
  let planner: HeldPlanner | undefined;
  let app: ElectronApplication | undefined;
  const daemonPort = await freePort();
  const cleanup = async (): Promise<void> => {
    const closed = await closeApp(app).then(() => undefined, (error: unknown) => ({ error }));
    await planner?.close();
    mock?.kill();
    await untilListening(daemonPort, false);
    removeSandbox(sandbox);
    if (closed) throw closed.error;
  };
  try {
    const started = await startMock();
    mock = started.process;
    if (options.planner) planner = await startHeldPlanner(started.port, options.planner);
    const base = appEnv(sandbox, daemonPort, planner?.port ?? started.port, options);
    const env = { ...base, ...options.env?.(sandbox, base) };
    app = await launchApp(sandbox, env);
    await app.context().tracing.start({ screenshots: true, snapshots: true });
    const workspace = options.workspace?.(sandbox) ?? sandbox.repo;
    const welcome = await app.firstWindow();
    const win = await openFolder(app, welcome, workspace);
    await expect(runnersKnown(win)).toBeAttached({ timeout: 60_000 });
    const editor = win.getByRole('main', { name: 'Centre' });
    await win.getByRole('button', { name: 'New session' }).first().click();
    await expect(editor.getByRole('tab', { name: /Planner/ })).toHaveAttribute('aria-selected', 'true');
    const composer = editor.getByRole('textbox', { name: 'Message the planner' });
    const launched = app;
    return {
      sandbox, app: launched, win, workspace, daemonPort, planner, editor, composer,
      finish: async (testInfo) => {
        const failed = testInfo.status !== testInfo.expectedStatus;
        await launched.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined).catch(() => undefined);
        if (failed) {
          for (const [i, page] of launched.windows().entries()) await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined);
        }
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
