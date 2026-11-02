import { describe, expect, it } from 'vitest';
import { CredentialBroker, parseLogin } from '../credentialBroker';
import { ANTHROPIC_API, OPENAI_API } from '../modelGateway';

const key = 'sk-ant-api03-not-a-real-key';

describe('the credential broker (ADR-0059 L7)', () => {
  it('keeps an API key back for the gateway, so no runner holds it', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key });

    expect(broker.issue(['ANTHROPIC_API_KEY'])).toEqual({ gated: { key, upstream: 'https://api.anthropic.com', api: ANTHROPIC_API }, handed: {} });
  });

  it('sends model traffic where the login says, once it names a base URL', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://llm.example.com/anthropic' });

    expect(broker.issue(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])).toEqual({ gated: { key, upstream: 'https://llm.example.com/anthropic', api: ANTHROPIC_API }, handed: {} });
  });

  it('ignores a base URL the login does not name: a person chooses what a lease takes', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://llm.example.com' });

    expect(broker.issue(['ANTHROPIC_API_KEY']).gated?.upstream).toBe('https://api.anthropic.com');
  });

  it.each([['not a url'], ['file:///etc/passwd']])('refuses a base URL it cannot use: %s', (url) => {
    expect(() => new CredentialBroker({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: url }).issue(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it('hands over by name what no gateway can carry: a cloud provider signs its own requests', () => {
    const cloud = { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', CLAUDE_CODE_USE_BEDROCK: '1' };
    const broker = new CredentialBroker(cloud);

    expect(broker.issue(Object.keys(cloud))).toEqual({ gated: null, handed: cloud });
  });

  it.each([
    ['ANTHROPIC_AUTH_TOKEN', 'a-gateway-of-their-own'],
    ['CLAUDE_CODE_USE_BEDROCK', '1'],
    ['CLAUDE_CODE_USE_VERTEX', '1'],
    ['CLAUDE_CODE_USE_FOUNDRY', '1'],
  ])('refuses %s beside an API key: Claude Code would use it over the key, so the gateway would carry nothing', (variable, value) => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key, [variable]: value });

    expect(() => broker.issue(['ANTHROPIC_API_KEY', variable])).toThrow(new RegExp(`${variable} outranks ANTHROPIC_API_KEY`));
  });

  it('keeps from a Codex task what only Claude Code ranks over a key: it does not undo the OpenAI key, and is not Codex\'s to hold', () => {
    const broker = new CredentialBroker({ OPENAI_API_KEY: 'sk-proj-a-key', ANTHROPIC_AUTH_TOKEN: 'a-gateway-of-their-own' });

    expect(broker.issue(['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], OPENAI_API).handed).toEqual({});
  });

  it('tells a surface with no runner in mind of a login a task of that runner would refuse', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key, CLAUDE_CODE_USE_VERTEX: '1' });

    expect(() => broker.check(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_VERTEX'])).toThrow(/CLAUDE_CODE_USE_VERTEX outranks ANTHROPIC_API_KEY/);
  });

  it('hands over the same variable without an API key: nothing is gated, and the lease reports what its runner can read', () => {
    const broker = new CredentialBroker({ ANTHROPIC_AUTH_TOKEN: 'a-gateway-of-their-own' });

    expect(broker.issue(['ANTHROPIC_AUTH_TOKEN'])).toEqual({ gated: null, handed: { ANTHROPIC_AUTH_TOKEN: 'a-gateway-of-their-own' } });
  });

  it('refuses a variable it does not hold, so a lease never starts without its login', () => {
    expect(() => new CredentialBroker({}).issue(['ANTHROPIC_API_KEY'])).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it.each([
    ['the subscription variable, whatever it holds', 'CLAUDE_CODE_OAUTH_TOKEN', 'anything'],
    ['an OAuth access token under another name', 'ANTHROPIC_API_KEY', 'sk-ant-oat01-abcdef'],
    ['an OAuth refresh token under another name', 'ANTHROPIC_AUTH_TOKEN', 'sk-ant-ort01-abcdef'],
    ['a credentials file pasted into a variable', 'ANYTHING', '{"claudeAiOauth":{"accessToken":"x"}}'],
  ])('never holds a Claude subscription token: %s', (_case, variable, value) => {
    expect(() => new CredentialBroker({ [variable]: value }).issue([variable])).toThrow(/subscription/);
  });
});

describe('a login read for one runner', () => {
  const BOTH = { ANTHROPIC_API_KEY: 'sk-ant-api03-a', OPENAI_API_KEY: 'sk-proj-b' };

  it("gates that runner's key, with its API", () => {
    const { gated, handed } = new CredentialBroker(BOTH).issue(['OPENAI_API_KEY'], OPENAI_API);

    expect(gated).toEqual({ key: 'sk-proj-b', upstream: 'https://api.openai.com/v1', api: OPENAI_API });
    expect(handed).toEqual({});
  });

  it("never hands a runner another runner's key in the clear", () => {
    const issued = new CredentialBroker(BOTH).issue(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], OPENAI_API);

    expect(issued.gated?.key).toBe('sk-proj-b');
    expect(JSON.stringify(issued.handed)).not.toContain('sk-ant-api03-a');
  });

  it("does not take a runner down over another runner's variable", () => {
    const issued = new CredentialBroker({ OPENAI_API_KEY: 'sk-proj-b' }).issue(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], OPENAI_API);

    expect(issued.gated?.key).toBe('sk-proj-b');
  });

  it("does not send a runner where another runner's base URL says", () => {
    const issued = new CredentialBroker({ ...BOTH, ANTHROPIC_BASE_URL: 'https://proxy.example' }).issue(['ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'], OPENAI_API);

    expect(issued).toEqual({ gated: { key: 'sk-proj-b', upstream: 'https://api.openai.com/v1', api: OPENAI_API }, handed: {} });
  });

  it("refuses a login that holds only another runner's key, and names what is missing", () => {
    expect(() => new CredentialBroker(BOTH).issue(['ANTHROPIC_API_KEY'], OPENAI_API)).toThrow(/OPENAI_API_KEY/);
    expect(() => new CredentialBroker(BOTH).issue(['OPENAI_API_KEY'], ANTHROPIC_API)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('refuses cloud credentials for a runner that reaches its model through a key alone', () => {
    const source = { AWS_SECRET_ACCESS_KEY: 'aws' };

    expect(() => new CredentialBroker(source).issue(['AWS_SECRET_ACCESS_KEY'], OPENAI_API)).toThrow(/OPENAI_API_KEY/);
    expect(new CredentialBroker(source).issue(['AWS_SECRET_ACCESS_KEY'], ANTHROPIC_API).handed).toEqual({ AWS_SECRET_ACCESS_KEY: 'aws' });
  });
});

describe('a login read for no one runner', () => {
  it('asks only that each variable is there: which runner it serves is known at the start', () => {
    expect(() => new CredentialBroker({ OPENAI_API_KEY: 'k' }).check(['OPENAI_API_KEY'])).not.toThrow();
    expect(() => new CredentialBroker({}).check(['OPENAI_API_KEY'])).toThrow(/OPENAI_API_KEY is not set/);
  });

  it('still refuses a subscription token', () => {
    expect(() => new CredentialBroker({ CLAUDE_CODE_OAUTH_TOKEN: 't' }).check(['CLAUDE_CODE_OAUTH_TOKEN'])).toThrow(/subscription/);
  });
});

describe('the login a person chooses', () => {
  it('has no default', () => {
    expect(parseLogin(undefined)).toMatchObject({ refused: expect.stringMatching(/choose/) });
  });

  it('reads a broker login', () => {
    expect(parseLogin({ kind: 'broker', variables: ['ANTHROPIC_API_KEY'] })).toEqual({ kind: 'broker', variables: ['ANTHROPIC_API_KEY'] });
  });

  it("reads the person's own sign-in", () => {
    expect(parseLogin({ kind: 'own-sign-in' })).toEqual({ kind: 'own-sign-in' });
  });

  it.each([
    [{ kind: 'broker' }],
    [{ kind: 'broker', variables: [] }],
    [{ kind: 'broker', variables: [1] }],
    [{ kind: 'keychain' }],
    ['broker'],
  ])('refuses %j', (raw) => {
    expect(parseLogin(raw)).toMatchObject({ refused: expect.any(String) });
  });
});
