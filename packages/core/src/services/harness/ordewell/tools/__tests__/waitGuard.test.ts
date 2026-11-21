import { describe, expect, it } from 'vitest';
import { sleepsIn, waitRefusal } from '../waitGuard';

describe('sleepsIn', () => {
  it('reads each literal sleep a command spells, in seconds', () => {
    expect(sleepsIn('sleep 240 && git fetch')).toEqual([240]);
    expect(sleepsIn('sleep 4m; sleep 1.5')).toEqual([240, 1.5]);
    expect(sleepsIn('python3 -c "import time; time.sleep(300)"')).toEqual([300]);
    expect(sleepsIn('Start-Sleep -Seconds 60')).toEqual([60]);
    expect(sleepsIn('npm test')).toEqual([]);
  });

  it('reads a sleep only where it runs: in command position, or in the code a -c string or a heredoc holds', () => {
    expect(sleepsIn('grep -rn "sleep 45" src/')).toEqual([]);
    expect(sleepsIn('git log --grep "sleep 120"')).toEqual([]);
    expect(sleepsIn("sed -i 's/time.sleep(60)/time.sleep(0)/' worker.py")).toEqual([]);
    expect(sleepsIn('echo "sleep 300 then retry" >> notes.md')).toEqual([]);
    expect(sleepsIn("bash -c 'git fetch; sleep 300'")).toEqual([300]);
    expect(sleepsIn('python3 - <<EOF\nimport time\ntime.sleep(300)\nEOF')).toEqual([300]);
    expect(sleepsIn('while true; do sleep 60; done')).toEqual([60]);
  });

  it('reads a sleep with no end, or spelt with an exponent, at its length', () => {
    expect(sleepsIn('sleep infinity')).toEqual([Infinity]);
    expect(sleepsIn('sleep inf')).toEqual([Infinity]);
    expect(sleepsIn('sleep 1e3')).toEqual([1000]);
  });
});

describe('waitRefusal', () => {
  it('refuses the waits a recorded slice made, and says what to do instead', () => {
    const refusal = waitRefusal('sleep 270; git log --oneline HEAD..ordewell/run');
    expect(refusal).toContain('sleeps for 270 seconds');
    expect(refusal).toContain('finish your own part');
    expect(refusal).not.toContain('wait_for');
  });

  it('refuses a polling loop however short each sleep, and offers wait_for where the task has it', () => {
    const refusal = waitRefusal('until git log ordewell/run | grep -q parser; do sleep 20; git fetch; done', { parks: true });
    expect(refusal).toContain('polls in a loop');
    expect(refusal).toContain('call `wait_for`');
  });

  it('runs a short sleep, and a loop that waits a second at a time for a server it started', () => {
    expect(waitRefusal('sleep 2 && curl -s localhost:8080')).toBeNull();
    expect(waitRefusal('until curl -sf localhost:8080; do sleep 1; done')).toBeNull();
    expect(waitRefusal('npm test')).toBeNull();
  });

  it('runs a command that only mentions a sleep, and refuses one that sleeps for good', () => {
    for (const command of ['grep -rn "sleep 45" src/', 'git log --grep "sleep 120"', "sed -i 's/time.sleep(60)/time.sleep(0)/' worker.py", 'echo "sleep 300 then retry" >> notes.md']) {
      expect(waitRefusal(command, { parks: true })).toBeNull();
    }
    expect(waitRefusal('sleep infinity', { parks: true })).toContain('sleeps with no end');
    expect(waitRefusal('sleep 1e3', { parks: true })).toContain('sleeps for 1000 seconds');
  });

  it('adds up a command\'s sleeps', () => {
    expect(waitRefusal('sleep 20; make; sleep 20')).toContain('sleeps for 40 seconds');
  });
});
