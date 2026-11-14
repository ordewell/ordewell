import { describe, it, expect } from 'vitest';
import { classifyRunnerStop, readUsageLimitReset, stopsRunner, type AttemptEnd } from '../runnerExit';

describe('classifyRunnerStop', () => {
  it.each([
    'Claude usage limit reached. Your limit will reset at 5pm.',
    'You have hit your usage limit. The limit will reset at 5pm.',
    'ERROR: rate limit exceeded, retry later',
    'Request was rate-limited',
    'Your weekly limit will reset on Monday',
    'quota exceeded for this project',
    'HTTP 429: Too Many Requests',
  ])('reads an account limit from %j', (output) => {
    expect(classifyRunnerStop(output)).toBe('usage-limit');
  });

  // Claude Code names the limit it hit, and not every name is one the words
  // above cover: the 5-hour one stopped task #31 and waited for the user.
  it.each([
    "You've hit your 5-hour limit · resets 3:50pm (Europe/Rome)",
    "You've hit your 5-hour limit · resets Oct 30, 3:50pm (Europe/Rome)",
    "You’ve hit your 5-hour limit · resets 3:50pm (Europe/Rome)",
    "You've hit your Opus limit · resets Oct 26, 8pm (Europe/Rome)",
    "You've hit your limit · resets Jan 2, 2027, 9am (America/New_York)",
    "You've hit your 5-hour limit.",
  ])('reads Claude Code\'s limit from %j', (output) => {
    expect(classifyRunnerStop(output)).toBe('usage-limit');
    expect(classifyRunnerStop({ message: output })).toBe('usage-limit');
  });

  it.each([
    "You've hit your stride: the parser handles every case now.",
    "You've hit your breakpoint in src/index.ts.",
    'The upload enforces a 5-hour limit on each job.',
    'Test exceeded the time limit of 5000ms',
    'Context limit reached; compacting the conversation.',
  ])('does not read a limit from %j', (output) => {
    expect(classifyRunnerStop(output)).toBe('stopped');
  });

  it('believes a runner that said in a field the failure was not its limit, whatever its words', () => {
    expect(classifyRunnerStop({ message: "You've hit your 5-hour limit · resets 3:50pm (Europe/Rome)", usageLimit: false })).toBe('stopped');
  });

  it('treats an ordinary crash as stopped', () => {
    expect(classifyRunnerStop('compilation failed: unexpected token')).toBe('stopped');
    expect(classifyRunnerStop('')).toBe('stopped');
  });

  it('takes a failure the runner marked as its usage limit at its word, whatever it says', () => {
    expect(classifyRunnerStop({ message: 'Codex is not available on this workspace right now.', usageLimit: {} })).toBe('usage-limit');
    expect(classifyRunnerStop({ message: 'compilation failed: unexpected token' })).toBe('stopped');
    expect(classifyRunnerStop({ message: "You've hit your usage limit. Try again later." })).toBe('usage-limit');
  });

  // What the runners end a turn with when their provider failed it, not the
  // account or the task: Claude Code's API error, OpenCode's provider error.
  it.each([
    'API Error: 502 Bad Gateway',
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'Provider returned error',
    '{"error":{"message":"Provider returned error","code":502}}',
    '429 Provider returned error',
    'unexpected status 503 Service Unavailable',
    'stream error: HTTP 504 Gateway Timeout',
  ])('reads a transient provider error from %j', (message) => {
    expect(classifyRunnerStop({ message })).toBe('transient');
  });

  it('reads a rate limit the runner said was not its usage limit as transient', () => {
    expect(classifyRunnerStop({ message: 'Rate limit reached for gpt-5.5.', usageLimit: false })).toBe('transient');
    expect(classifyRunnerStop({ message: 'API Error: 503 Service Unavailable', usageLimit: false })).toBe('transient');
  });

  it('keeps a usage limit apart from a transient error, whatever else its words say', () => {
    expect(classifyRunnerStop({ message: 'API Error: 429 You have hit your usage limit.' })).toBe('usage-limit');
    expect(classifyRunnerStop({ message: 'Provider returned error', usageLimit: {} })).toBe('usage-limit');
  });

  it.each([
    'Tests failed: expected 500 to equal 200',
    'The server returned 404 Not Found',
    'Error: ENOENT: no such file or directory',
    'Invalid API key · Please run /login',
    // A router's error with a 4xx beside it is the request's or the key's: it fails the same way on every try.
    '403 Provider returned error',
    'API Error: 403 Provider returned error',
    '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"maximum context length exceeded"}}}',
    '{"error":{"message":"Provider returned error","code":401}}',
    '{"error":{"message":"Provider returned error","code":"400"}}',
    'Provider returned error (statusCode: 400)',
    'Provider returned error (HTTP 401)',
    'Error 400: Provider returned error',
    "This model's maximum context length is 128000 tokens. Provider returned error",
    'Provider returned error: context_length_exceeded',
  ])('does not read a transient error from %j', (message) => {
    expect(classifyRunnerStop({ message })).toBe('stopped');
  });

  it('does not read a limit signature buried far above the tail', () => {
    const buried = 'usage limit reached\n' + 'x'.repeat(5000);
    expect(classifyRunnerStop(buried)).toBe('stopped');
    expect(classifyRunnerStop('x'.repeat(5000) + '\nusage limit reached')).toBe('usage-limit');
  });
});

describe('readUsageLimitReset', () => {
  // 17:00 UTC: 19:00 in Rome (CEST), 13:00 in New York (EDT).
  const now = new Date('2026-10-11T17:00:00Z');

  describe('Claude Code (2.1.296)', () => {
    // The first is the message as Claude Code printed it (#79, #84); the rest
    // follow the template in 2.1.296: "You've hit your <limit> · resets <time>
    // (<zone>)", the date shown beyond a day and the year only when it differs.
    it.each([
      ["You've hit your session limit · resets 8:10pm (Europe/Rome)", '2026-10-11T18:10:00.000Z'],
      ["You've hit your weekly limit · resets 9pm (Europe/Rome) · progress saved", '2026-10-11T19:00:00.000Z'],
      ["You've hit your usage limit · resets Oct 14, 8:10pm (Europe/Rome)", '2026-10-14T18:10:00.000Z'],
      ["You've hit your Opus limit · resets Oct 26, 8pm (Europe/Rome)", '2026-10-26T19:00:00.000Z'],
      ["You've hit your limit · resets Jan 2, 2027, 9am (America/New_York)", '2027-01-02T14:00:00.000Z'],
      ["You've hit your team's shared budget · ask your admin to raise it · your session limit resets 11:30pm (UTC)", '2026-10-11T23:30:00.000Z'],
      // Over an hour past 3:50pm in Rome, still on summer time (UTC+2): tomorrow's.
      ["You've hit your 5-hour limit · resets 3:50pm (Europe/Rome)", '2026-10-12T13:50:00.000Z'],
    ])('reads %j', (message, expected) => {
      expect(readUsageLimitReset('claude-code', `Working…\n${message}\n`, now)?.toISOString()).toBe(expected);
      // A reset it can read is no use to a limit the stop was not classified as.
      expect(classifyRunnerStop({ message })).toBe('usage-limit');
    });

    it('places a bare time that has passed on the next day', () => {
      expect(readUsageLimitReset('claude-code', "You've hit your session limit · resets 2am (Europe/Rome)", now)?.toISOString())
        .toBe('2026-10-12T00:00:00.000Z');
    });

    it('reads the last limit message when the stream repeats it (#79)', () => {
      const output = "You've hit your session limit · resets 8pm (UTC)\nYou've hit your session limit · resets 9pm (UTC)\n";
      expect(readUsageLimitReset('claude-code', output, now)?.toISOString()).toBe('2026-10-11T21:00:00.000Z');
    });

    it('reads nothing from a zone it cannot place, or a message with no reset', () => {
      expect(readUsageLimitReset('claude-code', "You've hit your session limit · resets 8pm (Mars/Olympus)", now)).toBeNull();
      expect(readUsageLimitReset('claude-code', "You've hit your usage limit · contact your admin to increase it", now)).toBeNull();
      expect(readUsageLimitReset('claude-code', 'Claude usage limit reached. Your limit will reset at 5pm.', now)).toBeNull();
    });
  });

  describe('Codex (0.162.0)', () => {
    // The wording in codex-cli 0.162.0: "… usage limit. Try again at <time>."
    // or "… or try again at <time>.", the time in the process's local zone as
    // "%-I:%M %p" the same day, else "%b %-d<st|nd|rd|th>, %Y %-I:%M %p".
    it.each([
      ["You've hit your usage limit. Try again at 8:10 PM.", new Date(2026, 9, 11, 20, 10)],
      ["You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:05 AM.", new Date(2026, 9, 14, 9, 5)],
      ["You've hit your usage limit. Try again at Nov 1st, 2026 12:00 AM.", new Date(2026, 10, 1, 0, 0)],
      ["You've hit your usage limit for gpt-6-sol. Switch to another model now, or try again at Oct 22nd, 2026 12:30 PM.", new Date(2026, 9, 22, 12, 30)],
    ])('reads %j', (message, expected) => {
      const localNow = new Date(2026, 9, 11, 19, 0);
      expect(readUsageLimitReset('codex', message, localNow)?.getTime()).toBe(expected.getTime());
    });

    it('takes the reset Codex reported for the used-up window over the words, and the words without one', () => {
      expect(readUsageLimitReset('codex', { message: "You've hit your usage limit. Try again later.", usageLimit: { resetsAt: '2026-10-11T20:42:55.000Z' } }, now)?.toISOString()).toBe('2026-10-11T20:42:55.000Z');
      const localNow = new Date(2026, 9, 11, 19, 0);
      expect(readUsageLimitReset('codex', { message: "You've hit your usage limit. Try again at 8:10 PM.", usageLimit: {} }, localNow)?.getTime()).toBe(new Date(2026, 9, 11, 20, 10).getTime());
    });

    it('reads nothing when Codex has no time to give', () => {
      expect(readUsageLimitReset('codex', "You've hit your usage limit. Try again later.", now)).toBeNull();
      expect(readUsageLimitReset('codex', 'You have hit your usage limit. Try again after 09:00.', now)).toBeNull();
    });
  });

  it('reads nothing for OpenCode (2.0.26), which passes its provider\'s error through with no reset time of its own', () => {
    expect(readUsageLimitReset('opencode', 'AI_APICallError: usage limit exceeded', now)).toBeNull();
    expect(readUsageLimitReset('opencode', "You've hit your session limit · resets 8:10pm (Europe/Rome)", now)).toBeNull();
  });

  it('reads nothing from a reset long past: those words are not this stop\'s', () => {
    expect(readUsageLimitReset('claude-code', "You've hit your usage limit · resets Oct 1, 8pm (UTC)", now)).toBeNull();
  });
});

describe('attempt-end disposition', () => {
  const reasons: AttemptEnd[] = ['verdict', 'usage-limit', 'cancel', 'release', 'complete', 'retry', 'spawn-failed', 'stop', 'load'];

  it('stops the runner for every reason that ends only that attempt, its verdict included', () => {
    expect(reasons.filter((r) => stopsRunner(r))).toEqual(['verdict', 'usage-limit', 'cancel', 'release', 'complete', 'retry', 'spawn-failed']);
  });

  it('leaves stop and load to the whole-run reset', () => {
    expect(stopsRunner('stop')).toBe(false);
    expect(stopsRunner('load')).toBe(false);
  });
});
