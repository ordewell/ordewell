import { Worker } from 'node:worker_threads';

/**
 * Prints a run's counters from a worker every `seconds`. The main thread writes
 * them to shared memory, so they come out while it is too busy to run a timer:
 * at a thousand sessions it can be, for minutes.
 */
export function pulseReporter(pulse, names, seconds) {
  return new Worker(`
    const { workerData: { pulse, names, seconds } } = require('node:worker_threads');
    const counters = new Int32Array(pulse);
    const fs = require('node:fs');
    const start = Date.now();
    let last = process.cpuUsage();
    setInterval(() => {
      const used = process.cpuUsage(last);
      last = process.cpuUsage();
      fs.writeSync(2, Math.round((Date.now() - start) / 1000) + 's ' + names.map((n, i) => n + '=' + Atomics.load(counters, i)).join(' ') + ' cpu=' + (used.user / 1e6).toFixed(0) + 'u+' + (used.system / 1e6).toFixed(0) + 's\\n');
    }, seconds * 1000);
  `, { eval: true, workerData: { pulse, names, seconds } });
}
