import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 700 } });
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
page.on('pageerror', (err) => console.log('[pageerror]', err.message));
await page.goto('http://127.0.0.1:3798', { waitUntil: 'networkidle' });

// Simulate host handshake: ready state + configured providers so the empty state (not GetStarted) renders.
await page.evaluate(() => {
  window.postMessage({ type: 'setConfiguredProviders', providers: ['openrouter'] }, '*');
  window.postMessage({ type: 'setPlannerBackends', backends: [{ id: 'openrouter', label: 'OpenRouter', usable: true }], provider: 'openrouter' }, '*');
  window.postMessage({ type: 'setRunners', runners: [{ id: 'claude-code', displayName: 'Claude Code', enabled: true }] }, '*');
});
await page.waitForTimeout(300);

await page.screenshot({ path: '/tmp/claude-1000/-home-noxiusk-ordewell-ordewell-master/dbed8e33-b55a-4a1f-b9be-779a0901e940/scratchpad/empty-state.png' });

const headerBox = await page.$eval('.app-header', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}).catch((e) => 'app-header not found: ' + e.message);
console.log('app-header box:', headerBox);

const btnTitles = await page.$$eval('.app-header-btn', (els) => els.map((e) => e.getAttribute('title')));
console.log('header button titles:', btnTitles);

const wordmark = await page.$('.empty-state-wordmark');
console.log('wordmark still present?', !!wordmark);

await browser.close();
