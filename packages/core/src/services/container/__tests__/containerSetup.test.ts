import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeContainers, containerStatus, describeContainers } from '../containerSetup';
import { CredentialBroker } from '../credentialBroker';
import type { DockerCli, DockerResult } from '../dockerCli';
import { GUARANTEES, type Guarantee, type GuaranteeReport } from '../../executionLease';

const OK = (stdout: string): DockerResult => ({ code: 0, stdout, stderr: '' });
const SAID = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr });

const LOCAL_ENGINE = {
  'context inspect': OK('unix:///var/run/docker.sock\n'),
  version: OK('29.5.2\n'),
  info: OK(`linux|2|${16 * 1024 ** 3}\n`),
};
const NO_DOCKER = { 'context inspect': SAID('spawn docker ENOENT', -1) };
const ENGINE_DOWN = { ...LOCAL_ENGINE, version: SAID('failed to connect to the docker API at unix:///var/run/docker.sock') };
const ALL_THERE = { ...LOCAL_ENGINE, 'image inspect': OK('sha256:1\n'), 'volume inspect': OK('[]\n') };

function docker(answers: Record<string, DockerResult>): DockerCli & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: async (args) => {
      const line = args.join(' ');
      calls.push(line);
      const answer = Object.entries(answers).find(([start]) => line.startsWith(start));
      return answer ? answer[1] : SAID(`nothing answers ${line}`);
    },
    entry: async () => { throw new Error('a status starts nothing of its own'); },
  };
}

function settingsFile(start?: unknown) {
  let saved = start;
  return {
    saved: () => saved,
    updateContainers: (change: (held: unknown) => unknown) => { saved = change(saved); },
  };
}

const proofOf = (proven: readonly Guarantee[]): GuaranteeReport => Object.fromEntries(GUARANTEES.map((guarantee) => [guarantee, { proven: proven.includes(guarantee), by: `measured ${guarantee}`, at: '2026-11-02T10:00:00.000Z' }])) as GuaranteeReport;

const CHOSEN = { image: 'ordewell-task', memory: '2g', login: { kind: 'own-sign-in' } };
const DEFAULT_PROVEN: Guarantee[] = ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata'];

beforeEach(() => { vi.stubEnv('ORDEWELL_CONTAINERS', '1'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('turning containers on', () => {
  it('turns on with nothing chosen when Docker answers, leaving the image and login for later', async () => {
    const settings = settingsFile();

    const refused = await changeContainers({ on: true }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(refused).toEqual([]);
    expect(settings.saved()).toEqual({});
  });

  it('saves nothing while the docker command is missing, and says what to install', async () => {
    const settings = settingsFile();

    const refused = await changeContainers({ on: true }, { settings, cli: docker(NO_DOCKER), platform: 'darwin' });

    expect(refused.map(({ code }) => code)).toEqual(['docker-missing']);
    expect(refused[0].remedy).toContain('Colima');
    expect(settings.saved()).toBeUndefined();
  });

  it('saves nothing while the engine is down, which is not the same as Docker missing', async () => {
    const settings = settingsFile();

    const refused = await changeContainers({ on: true }, { settings, cli: docker(ENGINE_DOWN), platform: 'linux' });

    expect(refused.map(({ code }) => code)).toEqual(['engine-down']);
    expect(settings.saved()).toBeUndefined();
  });

  it('keeps what a person chose when it is turned on again while on', async () => {
    const settings = settingsFile(CHOSEN);

    await changeContainers({ on: true }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(settings.saved()).toEqual(CHOSEN);
  });

  it('turns off without asking Docker, which may be why a person is turning it off', async () => {
    const settings = settingsFile(CHOSEN);
    const cli = docker(NO_DOCKER);

    const refused = await changeContainers({ on: false }, { settings, cli, platform: 'linux' });

    expect(refused).toEqual([]);
    expect(settings.saved()).toBeUndefined();
    expect(cli.calls).toEqual([]);
  });

  it('refuses every change in a build that does not offer containers, so no surface can reach past the gate', async () => {
    vi.stubEnv('ORDEWELL_CONTAINERS', '');
    const settings = settingsFile();

    const refused = await changeContainers({ on: true }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(refused.map(({ code }) => code)).toEqual(['not-offered']);
    expect(settings.saved()).toBeUndefined();
  });
});

describe('choosing the image and login afterwards', () => {
  it('sets the image on what is already there, with no engine asked: it may not be built yet', async () => {
    const settings = settingsFile({ login: { kind: 'own-sign-in' } });
    const cli = docker(NO_DOCKER);

    const refused = await changeContainers({ image: 'ordewell-task' }, { settings, cli, platform: 'linux' });

    expect(refused).toEqual([]);
    expect(settings.saved()).toEqual({ login: { kind: 'own-sign-in' }, image: 'ordewell-task' });
    expect(cli.calls).toEqual([]);
  });

  it('sets a login, which reads no credential', async () => {
    const settings = settingsFile({});

    await changeContainers({ login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(settings.saved()).toEqual({ login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } });
  });

  it('refuses an image that would read as a docker option', async () => {
    const settings = settingsFile({});

    const refused = await changeContainers({ image: '--privileged' }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(refused.map(({ code }) => code)).toEqual(['setting-refused']);
    expect(settings.saved()).toEqual({});
  });

  it('refuses a login of no known kind', async () => {
    const settings = settingsFile({});

    const refused = await changeContainers({ login: { kind: 'host' } }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(refused.map(({ code }) => code)).toEqual(['setting-refused']);
    expect(settings.saved()).toEqual({});
  });

  it('refuses both while containers are off: a choice must not be what turns them on', async () => {
    const settings = settingsFile();

    const refused = await changeContainers({ image: 'ordewell-task' }, { settings, cli: docker(LOCAL_ENGINE), platform: 'linux' });

    expect(refused.map(({ code }) => code)).toEqual(['containers-off']);
    expect(settings.saved()).toBeUndefined();
  });
});

describe('containerStatus', () => {
  const broker = new CredentialBroker({});

  it('reports off, with what stands between this host and turning on', async () => {
    const status = await containerStatus(undefined, { cli: docker(NO_DOCKER), broker, platform: 'linux' });

    expect(status).toMatchObject({ on: false, ready: false });
    expect(status.problems.map(({ code }) => code)).toEqual(['docker-missing']);
  });

  it('reports on and not ready with nothing chosen, each thing to choose as its own item', async () => {
    const status = await containerStatus({}, { cli: docker(LOCAL_ENGINE), broker, platform: 'linux' });

    expect(status).toMatchObject({ on: true, ready: false, engine: { version: '29.5.2' } });
    expect(status.problems.map(({ code }) => code)).toEqual(['image-unset', 'login-unset']);
  });

  it('says nothing has been proven until a check runs: a setting that reads well is not a guarantee', async () => {
    const status = await containerStatus(CHOSEN, { cli: docker(ALL_THERE), broker, platform: 'linux' });

    expect(status).toMatchObject({ on: true, ready: true, image: 'ordewell-task', memory: '2g', login: 'your own sign-in' });
    expect(status.guarantees).toBeUndefined();
    expect(describeContainers(status).join('\n')).toMatch(/Nothing has been proven yet/);
  });

  it('reports what a check proved, and what it did not, one by one', async () => {
    const proof = vi.fn(async () => proofOf(DEFAULT_PROVEN));

    const status = await containerStatus(CHOSEN, { cli: docker(ALL_THERE), broker, platform: 'linux', proof });

    expect(status.ready).toBe(true);
    expect(status.guarantees?.find(({ guarantee }) => guarantee === 'net.allowlist')).toEqual({ guarantee: 'net.allowlist', proven: true, by: 'measured net.allowlist', required: true });
    expect(status.guarantees?.find(({ guarantee }) => guarantee === 'cred.unreadable')).toEqual({ guarantee: 'cred.unreadable', proven: false, by: 'measured cred.unreadable', required: false });
  });

  it('is not ready when a required guarantee could not be proven', async () => {
    const proof = async () => proofOf(['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.noMetadata']);

    const status = await containerStatus(CHOSEN, { cli: docker(ALL_THERE), broker, platform: 'linux', proof });

    expect(status.ready).toBe(false);
    expect(status.problems.map(({ code, message }) => [code, message])).toEqual([['guarantee-unproven', expect.stringContaining('net.allowlist')]]);
  });

  it('is not ready when the proof itself could not run, and says why', async () => {
    const proof = async () => { throw new Error('its probe said nothing readable'); };

    const status = await containerStatus(CHOSEN, { cli: docker(ALL_THERE), broker, platform: 'linux', proof });

    expect(status.ready).toBe(false);
    expect(status.problems[0]).toMatchObject({ code: 'proof-failed', message: expect.stringContaining('its probe said nothing readable') });
  });

  it('leaves a required `cred.unreadable` to the lease: only a container holding the login can prove it', async () => {
    const status = await containerStatus({ ...CHOSEN, required: ['cred.unreadable'] }, { cli: docker(ALL_THERE), broker, platform: 'linux', proof: async () => proofOf([]) });

    expect(status.ready).toBe(true);
    expect(status.guarantees?.find(({ guarantee }) => guarantee === 'cred.unreadable')).toMatchObject({ proven: false, required: true });
  });

  it('runs no proof over a setting that is not ready', async () => {
    const proof = vi.fn(async () => proofOf(GUARANTEES));

    await containerStatus({}, { cli: docker(LOCAL_ENGINE), broker, platform: 'linux', proof });

    expect(proof).not.toHaveBeenCalled();
  });

  it('names the variables of a broker login, and never their values', async () => {
    const withKey = new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-secret' });

    const status = await containerStatus({ ...CHOSEN, login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } }, { cli: docker(ALL_THERE), broker: withKey, platform: 'linux' });

    expect(status.login).toBe('broker: ANTHROPIC_API_KEY');
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(describeContainers(status).join('\n')).not.toContain('secret');
  });

  it('states the hosts a task may reach, and the memory it holds to', async () => {
    const status = await containerStatus({ ...CHOSEN, allow: ['github.com'] }, { cli: docker(ALL_THERE), broker, platform: 'linux' });

    expect(status.allow).toEqual(['github.com']);
    expect(describeContainers(status).join('\n')).toContain('github.com');
  });

  it('keeps assumptions apart from proofs, and owns up to a shared kernel and to a sign-in the runner can read', async () => {
    const status = await containerStatus(CHOSEN, { cli: docker(ALL_THERE), broker, platform: 'linux', proof: async () => proofOf(DEFAULT_PROVEN) });

    const text = describeContainers(status).join('\n');
    expect(text.indexOf('Proven by this check')).toBeLessThan(text.indexOf('Not proven'));
    expect(text.indexOf('Not proven')).toBeLessThan(text.indexOf('Assumed'));
    expect(status.assumptions.join(' ')).toMatch(/share one kernel/);
    expect(status.assumptions.join(' ')).toMatch(/can read your sign-in/);
    expect(status.assumptions.join(' ')).toMatch(/Codex.*no refresh token.*sign in again/);
  });

  it('owns up to a key handed over by name, which a runner can read, only under a broker login', async () => {
    const own = await containerStatus(CHOSEN, { cli: docker(ALL_THERE), broker, platform: 'linux' });
    const brokered = await containerStatus({ ...CHOSEN, login: { kind: 'broker', variables: ['AWS_SECRET_ACCESS_KEY'] } }, { cli: docker(ALL_THERE), broker: new CredentialBroker({ AWS_SECRET_ACCESS_KEY: 'x' }), platform: 'linux' });

    expect(own.assumptions.join(' ')).not.toMatch(/handed over/);
    expect(brokered.assumptions.join(' ')).toMatch(/handed over/);
  });
});

describe('describeContainers', () => {
  it('says that a change waits for a new session', async () => {
    const status = await containerStatus({}, { cli: docker(LOCAL_ENGINE), broker: new CredentialBroker({}), platform: 'linux' });

    expect(describeContainers(status).join('\n')).toMatch(/new sessions/i);
  });

  it('gives each problem its remedy', async () => {
    const status = await containerStatus(undefined, { cli: docker(ENGINE_DOWN), broker: new CredentialBroker({}), platform: 'linux' });

    expect(describeContainers(status).join('\n')).toMatch(/does not answer.*systemctl start docker/s);
  });
});
