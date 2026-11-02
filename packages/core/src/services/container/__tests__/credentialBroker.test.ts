import { describe, expect, it } from 'vitest';
import { CredentialBroker, parseLogin } from '../credentialBroker';

const key = 'sk-ant-api03-not-a-real-key';

describe('the credential broker (ADR-0059 L7)', () => {
  it('keeps an API key back for the gateway, so no runner holds it', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key });

    expect(broker.issue(['ANTHROPIC_API_KEY'])).toEqual({ gated: { key, upstream: 'https://api.anthropic.com' }, handed: {} });
  });

  it('sends model traffic where the login says, once it names a base URL', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://llm.example.com/anthropic' });

    expect(broker.issue(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])).toEqual({ gated: { key, upstream: 'https://llm.example.com/anthropic' }, handed: {} });
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
