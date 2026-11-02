import { describe, expect, it } from 'vitest';
import { describeProblems, inspectEngine, inspectReadiness, LOGIN_VOLUME } from '../containerPreflight';
import { CODEX_LOGIN_VOLUME, containerRunner } from '../containerRunners';
import { CredentialBroker } from '../credentialBroker';
import type { DockerCall, DockerCli, DockerResult } from '../dockerCli';

const OK = (stdout: string): DockerResult => ({ code: 0, stdout, stderr: '' });
const SAID = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr });

// What a real docker 29 CLI said against Colima, and against a socket with nothing behind it (2026-11-02).
const COLIMA_SOCKET = 'unix:///Users/someone/.colima/default/docker.sock\n';
const NOTHING_ON_SOCKET = 'failed to connect to the docker API at unix:///tmp/nope.sock; check if the path is correct and if the daemon is running: dial unix /tmp/nope.sock: connect: no such file or directory';
const NOT_INSTALLED = SAID('spawn docker ENOENT', -1);
const GIB = 1024 ** 3;

class FakeDocker implements DockerCli {
  readonly calls: string[] = [];

  constructor(private readonly answers: Record<string, DockerResult>) {}

  async call(args: readonly string[], _opts?: DockerCall): Promise<DockerResult> {
    const line = args.join(' ');
    this.calls.push(line);
    const answer = Object.entries(this.answers).find(([start]) => line.startsWith(start));
    return answer ? answer[1] : SAID(`nothing answers ${line}`);
  }

  async entry(): Promise<never> {
    throw new Error('a check starts nothing');
  }
}

const HEALTHY = {
  'context inspect': OK(COLIMA_SOCKET),
  version: OK('29.5.2\n'),
  info: OK(`linux|2|${16 * GIB}\n`),
};

describe('inspectEngine', () => {
  it('says a local engine on a supported platform is ready, and what it found', async () => {
    const checked = await inspectEngine({ cli: new FakeDocker(HEALTHY), platform: 'darwin' });

    expect(checked.problems).toEqual([]);
    expect(checked.engine).toEqual({ version: '29.5.2', endpoint: 'unix:///Users/someone/.colima/default/docker.sock', memoryBytes: 16 * GIB });
  });

  it('tells a CLI that is not installed from a daemon that is not running, though both say "no such file"', async () => {
    const missing = await inspectEngine({ cli: new FakeDocker({ 'context inspect': NOT_INSTALLED, version: NOT_INSTALLED }), platform: 'linux' });
    const down = await inspectEngine({ cli: new FakeDocker({ ...HEALTHY, version: SAID(NOTHING_ON_SOCKET) }), platform: 'linux' });

    expect(missing.problems.map((problem) => problem.code)).toEqual(['docker-missing']);
    expect(down.problems.map((problem) => problem.code)).toEqual(['engine-down']);
    expect(down.problems[0].message).toContain(NOTHING_ON_SOCKET);
  });

  it('names the software a person needs on each platform', async () => {
    const missing = { 'context inspect': NOT_INSTALLED };

    const onMac = await inspectEngine({ cli: new FakeDocker(missing), platform: 'darwin' });
    const onLinux = await inspectEngine({ cli: new FakeDocker(missing), platform: 'linux' });

    expect(onMac.problems[0].remedy).toMatch(/Docker Desktop/);
    expect(onMac.problems[0].remedy).toMatch(/colima start/);
    expect(onLinux.problems[0].remedy).toMatch(/Docker Engine/);
    expect(onLinux.problems[0].remedy).not.toMatch(/colima/i);
  });

  it('tells a person how to start the engine they have', async () => {
    const down = { ...HEALTHY, version: SAID(NOTHING_ON_SOCKET) };

    const onMac = await inspectEngine({ cli: new FakeDocker(down), platform: 'darwin' });
    const onLinux = await inspectEngine({ cli: new FakeDocker(down), platform: 'linux' });

    expect(onMac.problems[0].remedy).toMatch(/colima start/);
    expect(onLinux.problems[0].remedy).toMatch(/systemctl start docker/);
  });

  it('tells a socket it may not open from one with nothing behind it, and what the docker group costs', async () => {
    const denied = { ...HEALTHY, version: SAID('permission denied while trying to connect to the docker API at unix:///var/run/docker.sock') };

    const checked = await inspectEngine({ cli: new FakeDocker(denied), platform: 'linux' });

    expect(checked.problems.map((problem) => problem.code)).toEqual(['engine-denied']);
    expect(checked.problems[0].remedy).toMatch(/docker group/);
    expect(checked.problems[0].remedy).toMatch(/root/);
  });

  it.each([
    ['tcp://build-box.example:2376'],
    ['ssh://me@build-box.example'],
    ['tcp://127.0.0.1:2375'],
    ['npipe:////./pipe/docker_engine'],
  ])('refuses an engine at %s: its host paths and loopback are not these, so the proofs would prove nothing', async (endpoint) => {
    const cli = new FakeDocker({ ...HEALTHY, 'context inspect': OK(`${endpoint}\n`) });

    const checked = await inspectEngine({ cli, platform: 'linux' });

    expect(checked.problems.map((problem) => problem.code)).toEqual(['engine-remote']);
    expect(checked.problems[0].message).toContain(endpoint);
    expect(checked.problems[0].remedy).toMatch(/docker context use/);
    expect(checked.engine).toBeUndefined();
  });

  it('refuses a context it cannot read rather than taking it for a local one', async () => {
    const cli = new FakeDocker({ ...HEALTHY, 'context inspect': SAID('context "gone": context not found') });

    const checked = await inspectEngine({ cli, platform: 'linux' });

    expect(checked.problems.map((problem) => problem.code)).toEqual(['engine-remote']);
    expect(checked.problems[0].message).toContain('context "gone"');
  });

  it.each(['win32', 'freebsd'] as const)('says %s has not been proven, and asks Docker nothing', async (platform) => {
    const cli = new FakeDocker(HEALTHY);

    const checked = await inspectEngine({ cli, platform });

    expect(checked.problems.map((problem) => problem.code)).toEqual(['platform-unsupported']);
    expect(cli.calls).toEqual([]);
  });

  it('refuses an engine of Windows containers, whose isolation none of this proves', async () => {
    const cli = new FakeDocker({ ...HEALTHY, info: OK(`windows||${16 * GIB}\n`) });

    const checked = await inspectEngine({ cli, platform: 'linux' });

    expect(checked.problems.map((problem) => problem.code)).toEqual(['platform-unsupported']);
  });

  it('refuses cgroup v1, since the limits are read from cgroup v2 and could never be proven', async () => {
    const cli = new FakeDocker({ ...HEALTHY, info: OK(`linux|1|${16 * GIB}\n`) });

    const checked = await inspectEngine({ cli, platform: 'linux' });

    expect(checked.problems.map((problem) => problem.code)).toEqual(['cgroup-v1']);
    expect(checked.problems[0].remedy).toMatch(/systemd\.unified_cgroup_hierarchy=1/);
  });

  it('counts an engine it cannot read as a problem, not as a pass', async () => {
    const unreadable = await inspectEngine({ cli: new FakeDocker({ ...HEALTHY, info: OK('<no value>\n') }), platform: 'linux' });
    const failed = await inspectEngine({ cli: new FakeDocker({ ...HEALTHY, info: SAID('info: gone away') }), platform: 'linux' });

    expect(unreadable.problems.map((problem) => problem.code)).toEqual(['engine-unreadable']);
    expect(failed.problems.map((problem) => problem.code)).toEqual(['engine-unreadable']);
    expect(failed.problems[0].message).toContain('gone away');
  });

  it('bounds every question, so a hung engine is reported rather than waited on', async () => {
    const asked: (number | undefined)[] = [];
    const cli: DockerCli = {
      call: async (_args, opts) => {
        asked.push(opts?.timeoutMs);
        return SAID('', 137);
      },
      entry: async () => { throw new Error('a check starts nothing'); },
    };

    const checked = await inspectEngine({ cli, platform: 'linux' });

    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((timeout) => timeout !== undefined && timeout <= 30_000)).toBe(true);
    expect(checked.problems.length).toBe(1);
  });
});

describe('inspectReadiness', () => {
  const IMAGE = 'image inspect';
  const SIGN_IN = 'volume inspect';
  const READY = { ...HEALTHY, [IMAGE]: OK('sha256:abc\n'), [SIGN_IN]: OK('[]\n') };
  const OWN = { image: 'ordewell-task', login: { kind: 'own-sign-in' } };
  const KEY = { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } };
  const noBroker = new CredentialBroker({});
  const keyBroker = new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
  const codes = (checked: { problems: { code: string }[] }) => checked.problems.map((problem) => problem.code);

  it('passes a setting whose image and login are there, and hands back what it read', async () => {
    const checked = await inspectReadiness(OWN, { cli: new FakeDocker(READY), platform: 'linux', broker: noBroker });

    expect(checked.problems).toEqual([]);
    expect(checked.settings).toMatchObject({ image: 'ordewell-task', login: { kind: 'own-sign-in' } });
    expect(checked.engine?.version).toBe('29.5.2');
  });

  it('lists all that is still to do, for containers that are on and not yet configured', async () => {
    const checked = await inspectReadiness({}, { cli: new FakeDocker(READY), platform: 'linux', broker: noBroker });

    expect(codes(checked)).toEqual(['image-unset', 'login-unset']);
    expect(checked.settings).toBeUndefined();
  });

  it('names what is wrong with the setting as well as what is wrong with Docker', async () => {
    const down = { ...READY, version: SAID(NOTHING_ON_SOCKET) };

    const checked = await inspectReadiness({ login: { kind: 'own-sign-in' } }, { cli: new FakeDocker(down), platform: 'linux', broker: noBroker });

    expect(codes(checked)).toEqual(['engine-down', 'image-unset']);
  });

  it('refuses a setting it cannot read rather than falling back to anything', async () => {
    const checked = await inspectReadiness({ ...OWN, memory: 'lots' }, { cli: new FakeDocker(READY), platform: 'linux', broker: noBroker });

    expect(codes(checked)).toEqual(['setting-refused']);
    expect(checked.problems[0].message).toMatch(/containers\.memory/);
    expect(checked.settings).toBeUndefined();
  });

  it('never pulls: an image that is not here is reported, with how to build it', async () => {
    const cli = new FakeDocker({ ...READY, [IMAGE]: SAID('No such image: ordewell-task') });

    const checked = await inspectReadiness(OWN, { cli, platform: 'linux', broker: noBroker });

    expect(codes(checked)).toEqual(['image-missing']);
    expect(checked.problems[0].remedy).toMatch(/docs\/containers\.md/);
    expect(cli.calls.some((line) => line.startsWith('pull') || line.startsWith('image pull'))).toBe(false);
  });

  it('asks after the sign-in of the runner a task is on, and not another\'s', async () => {
    const cli = new FakeDocker({ ['run --rm']: OK(''), [`${SIGN_IN} ${LOGIN_VOLUME}`]: OK('[]\n'), [`${SIGN_IN} ${CODEX_LOGIN_VOLUME}`]: SAID('no such volume'), ...READY });

    const checked = await inspectReadiness(OWN, { cli, platform: 'darwin', broker: noBroker, runner: containerRunner('codex')! });

    expect(codes(checked)).toEqual(['sign-in-missing']);
    expect(checked.problems[0].message).toContain('for codex');
    expect(checked.problems[0].remedy).toContain(CODEX_LOGIN_VOLUME);
  });

  it('with no task to ask for, takes either runner\'s sign-in as one made', async () => {
    const cli = new FakeDocker({ [`${SIGN_IN} ${LOGIN_VOLUME}`]: SAID('no such volume'), [`${SIGN_IN} ${CODEX_LOGIN_VOLUME}`]: OK('[]\n'), ...READY });

    const checked = await inspectReadiness(OWN, { cli, platform: 'darwin', broker: noBroker });

    expect(codes(checked)).toEqual([]);
  });

  it('refuses a broker login that holds nothing for the runner, naming the variable', async () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-api03-a-key' });
    const cli = new FakeDocker({ ['run --rm']: OK(''), ...READY });
    const login = { image: 'ordewell-task', login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY'] } };

    const checked = await inspectReadiness(login, { cli, platform: 'darwin', broker, runner: containerRunner('codex')! });

    expect(codes(checked)).toEqual(['login-unavailable']);
    expect(checked.problems[0].message).toContain('OPENAI_API_KEY');
  });

  it('checks that a sign-in was made, by the volume that keeps it and never by reading it', async () => {
    const cli = new FakeDocker({ ...READY, [SIGN_IN]: SAID(`no such volume: ${LOGIN_VOLUME}`) });

    const checked = await inspectReadiness(OWN, { cli, platform: 'linux', broker: noBroker });

    expect(codes(checked)).toEqual(['sign-in-missing']);
    expect(checked.problems[0].remedy).toContain(LOGIN_VOLUME);
    expect(cli.calls).toContain(`volume inspect ${LOGIN_VOLUME}`);
    expect(cli.calls.filter((line) => line.startsWith('run'))).toEqual([]);
  });

  it("asks for a task's own runner's sign-in, not another's", async () => {
    const cli = new FakeDocker({ ...READY, 'run --rm': OK(''), [SIGN_IN]: SAID('no such volume') });

    const opencode = await inspectReadiness(OWN, { cli, platform: 'linux', broker: noBroker, runner: containerRunner('opencode')! });

    expect(codes(opencode)).toEqual(['sign-in-missing']);
    expect(opencode.problems[0].remedy).toContain('ordewell-login-opencode');
    expect(cli.calls).toContain('volume inspect ordewell-login-opencode');
    expect(cli.calls).not.toContain(`volume inspect ${LOGIN_VOLUME}`);
  });

  it('reports an image that cannot start the task\'s runner, before a worktree is made', async () => {
    const cli = new FakeDocker({ ...READY, 'run --rm': SAID('exec: "opencode": executable file not found', 127) });

    const checked = await inspectReadiness(KEY, { cli, platform: 'linux', broker: keyBroker, runner: containerRunner('opencode')! });

    expect(codes(checked)).toEqual(['runner-missing']);
    expect(checked.problems[0].message).toContain('opencode');
    expect(checked.problems[0].remedy).toMatch(/docs\/containers\.md/);
  });

  it('asks no runner of an image when it knows none, and starts no container', async () => {
    const cli = new FakeDocker(READY);

    const checked = await inspectReadiness(KEY, { cli, platform: 'linux', broker: keyBroker });

    expect(codes(checked)).toEqual([]);
    expect(cli.calls.filter((line) => line.startsWith('run'))).toEqual([]);
  });

  it('holds a script to no login: its container has none, so a missing one cannot stop it', async () => {
    const cli = new FakeDocker({ ...READY, [SIGN_IN]: SAID('no such volume') });

    const own = await inspectReadiness(OWN, { cli, platform: 'linux', broker: noBroker, agent: false });
    const key = await inspectReadiness(KEY, { cli, platform: 'linux', broker: noBroker, agent: false });

    expect(own.problems).toEqual([]);
    expect(key.problems).toEqual([]);
  });

  it('reports a broker login whose variable is unset', async () => {
    const checked = await inspectReadiness(KEY, { cli: new FakeDocker(READY), platform: 'linux', broker: noBroker });

    expect(codes(checked)).toEqual(['login-unavailable']);
    expect(checked.problems[0].message).toContain('ANTHROPIC_API_KEY');
  });

  it('never lets a broker carry a subscription, and points at the login that may', async () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: 'sk-ant-oat01-a-subscription-token' });

    const checked = await inspectReadiness(KEY, { cli: new FakeDocker(READY), platform: 'linux', broker });

    expect(codes(checked)).toEqual(['login-unavailable']);
    expect(checked.problems[0].message).toMatch(/subscription/);
    expect(checked.problems[0].message).not.toContain('sk-ant-oat01');
    expect(checked.problems[0].remedy).toMatch(/own-sign-in/);
  });

  it('refuses a memory limit past what the engine has, which would be no limit at all', async () => {
    const small = { ...READY, info: OK(`linux|2|${2 * GIB}\n`) };

    const onMac = await inspectReadiness({ ...OWN, memory: '4g' }, { cli: new FakeDocker(small), platform: 'darwin', broker: noBroker });
    const onLinux = await inspectReadiness({ ...OWN, memory: '4g' }, { cli: new FakeDocker(small), platform: 'linux', broker: noBroker });
    const fits = await inspectReadiness({ ...OWN, memory: '2g' }, { cli: new FakeDocker(small), platform: 'darwin', broker: noBroker });

    expect(codes(onMac)).toEqual(['memory-over-engine']);
    expect(onMac.problems[0].remedy).toMatch(/colima start --memory/);
    expect(onMac.problems[0].remedy).toMatch(/Docker Desktop/);
    expect(onLinux.problems[0].remedy).not.toMatch(/colima/i);
    expect(onLinux.problems[0].remedy).toMatch(/containers\.memory/);
    expect(fits.problems).toEqual([]);
  });

  it('refuses a worktree setup command: it would run on this host, in what a container wrote', async () => {
    const checked = await inspectReadiness(OWN, { cli: new FakeDocker(READY), platform: 'linux', broker: noBroker, setupCommand: 'npm ci' });

    expect(codes(checked)).toEqual(['setup-command']);
    expect(checked.problems[0].remedy).toMatch(/ORDEWELL_WORKTREE_SETUP/);
  });

  it('asks nothing of an engine it has refused', async () => {
    const cli = new FakeDocker({ ...READY, 'context inspect': OK('tcp://elsewhere.example:2376\n') });

    await inspectReadiness(OWN, { cli, platform: 'linux', broker: noBroker });

    expect(cli.calls).toEqual(['context inspect --format {{.Endpoints.docker.Host}}']);
  });

  it('writes each problem with its remedy, for an error a person reads', async () => {
    const text = describeProblems([{ code: 'a', message: 'It is off.', remedy: 'Turn it on.' }, { code: 'b', message: 'It is far.', remedy: '' }]);

    expect(text).toBe('It is off. Turn it on. It is far.');
  });
});
