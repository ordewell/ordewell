export function iconFor(status: string): string {
  switch (status) {
    case 'completed': return '\x1b[32m✓\x1b[0m';
    case 'in_progress': return '\x1b[34m⟳\x1b[0m';
    case 'failed': return '\x1b[31m✗\x1b[0m';
    case 'blocked': return '\x1b[33m⊘\x1b[0m';
    default: return '\x1b[90m○\x1b[0m';
  }
}
