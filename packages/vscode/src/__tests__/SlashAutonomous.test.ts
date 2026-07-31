import { describe, it, expect } from 'vitest';
import { resolveAutonomousQuickPickItems, applyAutonomousChoice } from '../SlashAutonomous';

describe('resolveAutonomousQuickPickItems', () => {
  it('lists Autonomous first, with per-runner resolved mode in the detail', () => {
    const runners = ['claude-code', 'opencode'];
    const modesByRunner = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', autonomous: false, safe: true },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true, safe: false },
      ],
      'opencode': [
        { id: 'build', label: 'Build', description: 'full access', autonomous: true, safe: true },
      ],
    };

    const items = resolveAutonomousQuickPickItems(runners, modesByRunner);

    expect(items[0].label).toMatch(/^Autonomous/);
    // Resolved modes appear per runner in the detail
    expect(items[0].detail).toContain('claude-code: bypassPermissions');
    expect(items[0].detail).toContain('opencode: build');
    expect(items[1].label).toMatch(/^Standard/);
    expect(items[1].detail).toContain('claude-code: default');
    expect(items[1].detail).toContain('opencode: build');
    // Each item carries its boolean value for persistence
    expect(items[0].picked).toBe(true);
    expect(items[1].picked).toBe(false);
  });

  it('preselects the item matching the current toggle value', () => {
    const runners = ['claude-code'];
    const modesByRunner = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', autonomous: false, safe: true },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips', autonomous: true, safe: false },
      ],
    };

    const onItems = resolveAutonomousQuickPickItems(runners, modesByRunner, true);
    expect(onItems[0].picked).toBe(true);
    expect(onItems[1].picked).toBe(false);

    const offItems = resolveAutonomousQuickPickItems(runners, modesByRunner, false);
    expect(offItems[0].picked).toBe(false);
    expect(offItems[1].picked).toBe(true);
  });

  it('gracefully handles a runner with no manifest modes by listing "(default)"', () => {
    const runners = ['unknown-runner'];
    const items = resolveAutonomousQuickPickItems(runners, {});
    // Both autonomous and standard should still appear, with "(default)" for the unknown
    expect(items[0].label).toMatch(/^Autonomous/);
    expect(items[0].detail).toContain('unknown-runner: (default)');
  });
});

describe('applyAutonomousChoice', () => {
  it('returns the echo string naming the resolved modes per runner', () => {
    const runners = ['claude-code', 'opencode'];
    const modesByRunner = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', autonomous: false, safe: true },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips', autonomous: true, safe: false },
      ],
      'opencode': [
        { id: 'build', label: 'Build', description: 'full access', autonomous: true, safe: true },
      ],
    };

    const onEcho = applyAutonomousChoice(true, runners, modesByRunner);
    expect(onEcho).toContain('Autonomous mode enabled');
    expect(onEcho).toContain('claude-code: bypassPermissions');
    expect(onEcho).toContain('opencode: build');

    const offEcho = applyAutonomousChoice(false, runners, modesByRunner);
    expect(offEcho).toContain('Autonomous mode disabled');
    expect(offEcho).toContain('claude-code: default');
  });
});