import { randomBytes } from 'crypto';

// Timestamp-based ids let an attacker who knows roughly when planning started
// enumerate the whole identifier space. `randomBytes` collision probability
// under rapid successive creation is negligible, so no timestamp-nudging is
// needed to guarantee uniqueness the way the old `Date.now()` scheme did.
export function mintSessionId(): string {
  return `session-${randomBytes(16).toString('hex')}`;
}
