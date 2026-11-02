import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ContainerChangeResponse, ContainerStatus, DockerCli } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { settingsRoute } from '../settings';

const OK = (stdout: string) => ({ code: 0, stdout, stderr: '' });

function dockerAnswering(answers: Record<string, string>): DockerCli {
  return {
    call: async (args) => {
      const line = args.join(' ');
      const answer = Object.entries(answers).find(([start]) => line.startsWith(start));
      return answer ? OK(answer[1]) : { code: 1, stdout: '', stderr: `nothing answers ${line}` };
    },
    entry: async () => { throw new Error('no change starts a container'); },
  };
}

const LOCAL_ENGINE = { 'context inspect': 'unix:///var/run/docker.sock\n', version: '29.5.2\n', info: `linux|2|${16 * 1024 ** 3}\n` };
const NOT_INSTALLED: DockerCli = { call: async () => ({ code: -1, stdout: '', stderr: 'spawn docker ENOENT' }), entry: async () => { throw new Error('not installed'); } };

describe('the containers setting over the daemon', () => {
  let dir: string;
  let file: string;
  let pools: OrchestratorPool[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-containers-route-'));
    file = path.join(dir, 'settings.json');
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', file);
    vi.stubEnv('AI_PROVIDER', 'claude-code');
    vi.stubEnv('ORDEWELL_CONTAINERS', '1');
    pools = [];
  });

  afterEach(() => {
    for (const pool of pools) pool.destroyAll();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function daemon(dockerCli: DockerCli): Hono {
    const pool = new OrchestratorPool({ dockerCli });
    pools.push(pool);
    return new Hono().route('/api/settings', settingsRoute(pool));
  }

  const patch = (app: Hono, body: unknown) => app.request('/api/settings/containers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const saved = (): unknown => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

  it('turns containers on through to the file, and then wants the image and login', async () => {
    const response = await patch(daemon(dockerAnswering(LOCAL_ENGINE)), { on: true, workspace: dir });

    const { refused, status } = await response.json() as ContainerChangeResponse;
    expect(response.status).toBe(200);
    expect(refused).toEqual([]);
    expect(saved()).toEqual({ containers: {} });
    expect(status.problems.map(({ code }) => code)).toEqual(['image-unset', 'login-unset']);
  });

  it('refuses to turn on without Docker, with the remedy, and writes nothing', async () => {
    const response = await patch(daemon(NOT_INSTALLED), { on: true });

    const { refused, status } = await response.json() as ContainerChangeResponse;
    expect(refused.map(({ code }) => code)).toEqual(['docker-missing']);
    expect(status.on).toBe(false);
    expect(saved()).toEqual({});
  });

  it('answers a change of more than one thing with nothing changed', async () => {
    const response = await patch(daemon(dockerAnswering(LOCAL_ENGINE)), { on: true, image: 'ordewell-task' });

    expect(response.status).toBe(400);
    expect(saved()).toEqual({});
  });

  it('reports the status a surface shows', async () => {
    fs.writeFileSync(file, JSON.stringify({ containers: {} }));

    const response = await daemon(dockerAnswering(LOCAL_ENGINE)).request('/api/settings/containers');

    const status = await response.json() as ContainerStatus;
    expect(status).toMatchObject({ on: true, ready: false, engine: { version: '29.5.2' } });
  });

  it('counts a host setup command against a task, as a start would', async () => {
    vi.stubEnv('ORDEWELL_WORKTREE_SETUP', 'npm ci');
    fs.writeFileSync(file, JSON.stringify({ containers: {} }));

    const response = await daemon(dockerAnswering(LOCAL_ENGINE)).request('/api/settings/containers');

    const status = await response.json() as ContainerStatus;
    expect(status.problems.map(({ code }) => code)).toContain('setup-command');
  });

  it('is no route at all in a build that does not offer containers, so nothing reaches the setting', async () => {
    vi.stubEnv('ORDEWELL_CONTAINERS', '');
    const app = daemon(dockerAnswering(LOCAL_ENGINE));

    expect((await app.request('/api/settings/containers')).status).toBe(404);
    expect((await patch(app, { on: true })).status).toBe(404);
    expect(saved()).toEqual({});
  });
});
