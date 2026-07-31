import { describe, it, expect, beforeAll } from 'vitest';
import { render } from '../render';
import { style } from '../ansi';
import { initialState, type ApprovalRequestView, type TuiState } from '../state';

beforeAll(() => {
  style.enabled = false;
});

function screenWith(request: ApprovalRequestView, over: Partial<TuiState> = {}): string {
  return render(initialState({ rows: 24, cols: 80, overlay: { kind: 'approval', request }, ...over })).join('\n');
}

const SHELL: ApprovalRequestView = {
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test -- --run',
  scope: 'npm test',
};

describe('approval overlay rendering', () => {
  it('shows the command the planner wants to run', () => {
    const out = screenWith(SHELL);
    expect(out).toContain('npm test -- --run');
  });

  it('states what a yes grants beyond this one call', () => {
    expect(screenWith(SHELL)).toContain('npm test');
    expect(screenWith(SHELL)).toMatch(/also allows|remembers|rest of/i);
  });

  it('offers both answers, with deny as the visible default', () => {
    const out = screenWith(SHELL);
    expect(out).toMatch(/y.*allow/i);
    expect(out).toMatch(/(n|esc).*den(y|ies)/i);
  });

  it('labels a path request as leaving the workspace', () => {
    const out = screenWith({ id: 'ap-2', kind: 'external_path', subject: '/tmp/dump/a.log', scope: '/tmp/dump/*' });
    expect(out).toContain('/tmp/dump/a.log');
    expect(out).toMatch(/outside the workspace/i);
  });

  it('labels a URL request as a network fetch', () => {
    const out = screenWith({ id: 'ap-3', kind: 'url_fetch', subject: 'https://docs.rs/tokio', scope: 'https://docs.rs/*' });
    expect(out).toContain('https://docs.rs/tokio');
    expect(out).toMatch(/fetch/i);
  });

  it('surfaces detail, since an auto-tier command touching an outside path otherwise reads identically to a plain read', () => {
    const out = screenWith({
      id: 'ap-4',
      kind: 'external_path',
      subject: '/etc/hostname',
      scope: '/etc/*',
      detail: 'Planner research wants to run "cat /etc/hostname", which touches /etc/hostname, outside the workspace (/repo).',
    });
    expect(out).toContain('which touches');
    expect(out).toContain('outside the workspace (/repo)');
  });

  it('omits the detail line entirely when the request carries none', () => {
    expect(screenWith(SHELL)).not.toMatch(/undefined/);
  });

  it('says how many more are waiting, so the user knows the prompt will repeat', () => {
    const out = screenWith(SHELL, {
      pendingApprovals: [
        { id: 'ap-9', kind: 'shell_command', subject: 'pytest', scope: 'pytest' },
      ],
    });
    expect(out).toMatch(/1 more/i);
  });

  it('renders within the terminal it was given', () => {
    const lines = render(initialState({ rows: 12, cols: 40, overlay: { kind: 'approval', request: SHELL } }));
    expect(lines).toHaveLength(12);
  });

  it('does not crash on a very narrow terminal', () => {
    expect(() => render(initialState({ rows: 8, cols: 20, overlay: { kind: 'approval', request: SHELL } }))).not.toThrow();
  });
});
