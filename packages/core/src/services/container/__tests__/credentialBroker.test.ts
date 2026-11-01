import { describe, expect, it } from 'vitest';
import { CredentialBroker, parseLogin } from '../credentialBroker';

const key = 'sk-ant-api03-not-a-real-key';

describe('the credential broker (ADR-0059 L7)', () => {
  it('hands a lease the API keys it holds', () => {
    const broker = new CredentialBroker({ ANTHROPIC_API_KEY: key });

    expect(broker.issue(['ANTHROPIC_API_KEY'])).toEqual({ ANTHROPIC_API_KEY: key });
  });

  it('holds cloud credentials as it holds API keys', () => {
    const cloud = { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', CLAUDE_CODE_USE_BEDROCK: '1' };
    const broker = new CredentialBroker(cloud);

    expect(broker.issue(Object.keys(cloud))).toEqual(cloud);
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
