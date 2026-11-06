import { describe, expect, it } from 'vitest';
import { webLink } from '../link';

describe('webLink', () => {
  it('passes http and https addresses, normalised', () => {
    expect(webLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(webLink('http://localhost:3000')).toBe('http://localhost:3000/');
  });

  it('refuses every other scheme, credentials, and anything that is not an address', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.y', 'vscode://x', 'data:text/html,hi', 'https://u:p@example.com', 'example.com', '', 'https://' + 'a'.repeat(5000), 3, null, undefined]) {
      expect(webLink(bad), String(bad).slice(0, 40)).toBeUndefined();
    }
  });
});
