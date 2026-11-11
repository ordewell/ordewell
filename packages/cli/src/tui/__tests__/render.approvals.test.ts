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

  it('says esc must be pressed twice while a turn is in flight', () => {
    const out = screenWith(SHELL, { planner: 'planning', sessionId: 's1' });
    expect(out).toMatch(/esc twice stops planning/i);
    expect(out).toMatch(/n den(y|ies)/i);
  });

  it('names the take-back instead once a prompt is queued, when the first esc takes it back', () => {
    const out = screenWith(SHELL, {
      planner: 'planning',
      sessionId: 's1',
      queuedPrompts: ['a parked thought'],
    });
    expect(out).toMatch(/esc takes back the newest queued prompt/i);
    expect(out).not.toMatch(/esc twice stops planning/i);
  });

  it('says esc drops the newest queued prompt while the composer holds a draft', () => {
    const base = initialState();
    const out = screenWith(SHELL, {
      planner: 'planning',
      sessionId: 's1',
      queuedPrompts: ['a parked thought'],
      editor: { ...base.editor, text: 'typing', cursor: 6 },
    });
    expect(out.replace(/\s+/g, ' ')).toMatch(/esc drops the newest queued prompt/i);
  });

  it('keeps the take-back hint legible at narrow and wide widths', () => {
    for (const cols of [40, 120]) {
      const out = screenWith(SHELL, { planner: 'planning', sessionId: 's1', queuedPrompts: ['held'], cols });
      expect(out.replace(/\s+/g, ' ')).toMatch(/esc takes back the newest queued prompt/i);
    }
  });

  it('keeps the deny wording while no turn is in flight', () => {
    const out = screenWith(SHELL, { queuedPrompts: ['held but not a turn'] });
    expect(out).toMatch(/n or esc denies/i);
    expect(out).not.toMatch(/esc twice stops planning/i);
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

  it('labels a search request as a web search', () => {
    const out = screenWith({ id: 'ap-5', kind: 'web_search', subject: 'tokio changelog', scope: 'web_search:duckduckgo' });
    expect(out).toContain('tokio changelog');
    expect(out).toMatch(/search the web/i);
  });

  it('labels a project server request as starting one', () => {
    const out = screenWith({ id: 'ap-6', kind: 'mcp_server', subject: 'probe: ./serve.sh', scope: 'mcp-server:probe@0123456789ab' });
    expect(out).toContain('probe: ./serve.sh');
    expect(out).toMatch(/start a project MCP server/i);
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

describe('a planner asking to start work (ADR-0029)', () => {
  const START: ApprovalRequestView = { id: 'ap-9', kind: 'task_start', subject: 'Start task #2 "Add the cache"', scope: 'Start task #2 "Add the cache"' };

  it('says what would start, and promises no wider grant, since a start is asked every time', () => {
    const out = screenWith(START);
    expect(out).toContain('The planner wants to start work');
    expect(out).toContain('Start task #2 "Add the cache"');
    expect(out).not.toMatch(/also allows/i);
  });

  describe('a script task start (ADR-0035)', () => {
    const START: ApprovalRequestView = {
      id: 'ap-9', kind: 'task_start', subject: 'Run script task #2 "Push"', scope: 'Run script task #2 "Push"',
      body: 'git tag v1\ngit push origin v1\n\nTime limit: 10 minutes.',
    };

    it('shows the body verbatim, a command to a line, with the time limit', () => {
      const out = screenWith(START);
      expect(out).toMatch(/\n\s+git tag v1 *\n\s+git push origin v1 *\n/);
      expect(out).toContain('Time limit: 10 minutes.');
      expect(out).toMatch(/y or enter allows/);
    });

    it('scrolls a body that does not fit, counting what is out of view and keeping the keys on screen', () => {
      const long = { ...START, body: Array.from({ length: 60 }, (_, i) => `echo line-${i}`).join('\n') };
      const top = screenWith(long);
      expect(top).toContain('echo line-0');
      expect(top).not.toContain('echo line-59');
      expect(top).toMatch(/↓ \d+ more lines below/);
      expect(top).toMatch(/y or enter allows/);

      const end = screenWith(long, { overlay: { kind: 'approval', request: long, scroll: 1000 } });
      expect(end).toContain('echo line-59');
      expect(end).toMatch(/↑ \d+ more lines above/);
      expect(end).toMatch(/y or enter allows/);
    });
  });
});
