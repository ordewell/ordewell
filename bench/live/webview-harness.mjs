#!/usr/bin/env node
/**
 * Visual harness for the Ordewell VS Code chat webview.
 *
 * Serves the built webview bundle (packages/vscode/dist/webviews) with a
 * mocked `acquireVsCodeApi`. The page itself carries no scenario data or
 * scripted progress events — see bench/live/scenarios.mjs and host-driver.mjs
 * for that: a driving script (webview-screenshot.mjs,
 * webview-restore-assertions.mjs) runs a real `ConversationViewHost` in Node
 * and relays exactly what it posts into the page via `window.__send`, the way
 * `ChatViewProvider.postMessage` would. A message the page sends back out
 * (`vscode.postMessage`) is both recorded in `window.__posted` and, if the
 * driving script installed `window.__toHost` (via Playwright's
 * `page.exposeFunction`), forwarded there — so a click or an Esc in the page
 * can round-trip through the same host and come back as a real reply.
 *
 * Usage:
 *   npm run build -w packages/core -w packages/vscode   # build the bundles first
 *   node bench/live/webview-harness.mjs                 # serves on http://127.0.0.1:3798
 *
 * `?theme=dark|light|dark-plus|light-plus|high-contrast|high-contrast-light` sets the `--vscode-*`
 * custom properties a driving script wants for contrast screenshots; dark is
 * the default. `/tasklog` serves the task log panel's bundle the same way: it
 * draws nothing until a driving script posts it an `init` through `__send`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '../../packages/vscode/dist/webviews');
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 3798);

// Approximate values for VS Code's built-in Dark Modern / Light Modern themes
// — every var the stylesheet reads (see styles.css's :root), so a screenshot
// under each theme is a real contrast check rather than the stylesheet's own
// hardcoded fallbacks (which are dark regardless of what theme is asked for).
const THEMES = {
  dark: {
    '--vscode-editor-background': '#1e1e1e',
    '--vscode-sideBar-background': '#181818',
    '--vscode-editorWidget-background': '#252526',
    '--vscode-quickInput-background': '#252526',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-input-background': '#3c3c3c',
    '--vscode-input-placeholderForeground': '#a6a6a6',
    '--vscode-panel-border': '#2b2b2b',
    '--vscode-widget-border': '#303031',
    '--vscode-foreground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-errorForeground': '#f14c4c',
    '--vscode-editorWarning-foreground': '#cca700',
    '--vscode-list-warningForeground': '#cca700',
    '--vscode-focusBorder': '#007fd4',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
    '--vscode-button-background': '#0e639c',
    '--vscode-testing-iconPassed': '#73c991',
    '--vscode-testing-iconFailed': '#f14c4c',
    '--vscode-textLink-foreground': '#3794ff',
    '--vscode-textPreformat-background': 'rgba(255, 255, 255, 0.1)',
    '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    '--vscode-editor-font-family': "Menlo, Monaco, 'Courier New', monospace",
    'color-scheme': 'dark',
  },
  light: {
    '--vscode-editor-background': '#ffffff',
    '--vscode-sideBar-background': '#f3f3f3',
    '--vscode-editorWidget-background': '#f3f3f3',
    '--vscode-quickInput-background': '#f9f9f9',
    '--vscode-list-hoverBackground': '#f2f2f2',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-widget-border': '#e5e5e5',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-errorForeground': '#a1260d',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-list-warningForeground': '#895503',
    '--vscode-focusBorder': '#0090f1',
    '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.16)',
    '--vscode-button-background': '#005fb8',
    '--vscode-testing-iconPassed': '#388a34',
    '--vscode-testing-iconFailed': '#a1260d',
    '--vscode-textLink-foreground': '#005fb8',
    '--vscode-textPreformat-background': 'rgba(0, 0, 0, 0.06)',
    '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    '--vscode-editor-font-family': "Menlo, Monaco, 'Courier New', monospace",
    'color-scheme': 'light',
  },
  // High Contrast Dark: the theme uses its contrastBorder everywhere and puts
  // the focus ring in the theme's own yellow, so a screenshot under it proves
  // the login row did not quietly fall back to the dark theme's borders.
  'high-contrast': {
    '--vscode-editor-background': '#000000',
    '--vscode-sideBar-background': '#000000',
    '--vscode-editorWidget-background': '#000000',
    '--vscode-quickInput-background': '#000000',
    '--vscode-list-hoverBackground': '#0a0a0a',
    '--vscode-input-background': '#000000',
    '--vscode-input-placeholderForeground': '#ffffff',
    '--vscode-panel-border': '#6fc3df',
    '--vscode-widget-border': '#6fc3df',
    '--vscode-contrastBorder': '#6fc3df',
    '--vscode-contrastActiveBorder': '#f38518',
    '--vscode-foreground': '#ffffff',
    '--vscode-descriptionForeground': '#ffffff',
    '--vscode-errorForeground': '#f48771',
    '--vscode-editorWarning-foreground': '#ffd700',
    '--vscode-list-warningForeground': '#ffd700',
    '--vscode-focusBorder': '#f38518',
    '--vscode-button-background': '#000000',
    '--vscode-testing-iconPassed': '#73c991',
    '--vscode-testing-iconFailed': '#f48771',
    '--vscode-textLink-foreground': '#3794ff',
    '--vscode-textPreformat-background': 'rgba(255, 255, 255, 0.1)',
    '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    '--vscode-editor-font-family': "Menlo, Monaco, 'Courier New', monospace",
    'color-scheme': 'dark',
  },
  'high-contrast-light': {
    '--vscode-editor-background': '#ffffff',
    '--vscode-sideBar-background': '#ffffff',
    '--vscode-editorWidget-background': '#ffffff',
    '--vscode-quickInput-background': '#ffffff',
    '--vscode-list-hoverBackground': '#f2f2f2',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-placeholderForeground': '#292929',
    '--vscode-panel-border': '#0f4a85',
    '--vscode-widget-border': '#0f4a85',
    '--vscode-contrastBorder': '#0f4a85',
    '--vscode-contrastActiveBorder': '#006bbd',
    '--vscode-foreground': '#292929',
    '--vscode-descriptionForeground': '#292929',
    '--vscode-errorForeground': '#a1260d',
    '--vscode-editorWarning-foreground': '#895503',
    '--vscode-list-warningForeground': '#895503',
    '--vscode-focusBorder': '#0f4a85',
    '--vscode-button-background': '#0f4a85',
    '--vscode-testing-iconPassed': '#388a34',
    '--vscode-testing-iconFailed': '#a1260d',
    '--vscode-textLink-foreground': '#0f4a85',
    '--vscode-textPreformat-background': 'rgba(0, 0, 0, 0.06)',
    '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    '--vscode-editor-font-family': "Menlo, Monaco, 'Courier New', monospace",
    'color-scheme': 'light',
  },
};

// Dark+ and Light+, the older defaults: their side bar sits further off the
// editor than the Modern themes', which the derived card surfaces must survive.
THEMES['dark-plus'] = {
  ...THEMES.dark,
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-sideBar-background': '#252526',
  '--vscode-quickInput-background': '#252526',
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': 'rgba(204, 204, 204, 0.7)',
};
THEMES['light-plus'] = {
  ...THEMES.light,
  '--vscode-editor-background': '#ffffff',
  '--vscode-sideBar-background': '#f3f3f3',
  '--vscode-quickInput-background': '#f3f3f3',
  '--vscode-foreground': '#616161',
  '--vscode-descriptionForeground': '#717171',
};
/** The class VS Code puts on the webview's body: Dark+ and Light+ are plain dark and light themes. */
const BODY_CLASS = { dark: 'dark', light: 'light', 'high-contrast': 'high-contrast', 'high-contrast-light': 'high-contrast-light', 'dark-plus': 'dark', 'light-plus': 'light' };

const themeName = (raw) => (Object.hasOwn(THEMES, raw ?? '') ? raw : 'dark');

function themeStyle(name) {
  const vars = THEMES[name];
  const decls = Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ');
  return `:root { ${decls} }`;
}

function page(rawTheme, script) {
  const theme = themeName(rawTheme);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/styles.css">
<title>Ordewell webview harness</title>
<style>
  ${themeStyle(theme)}
  body { margin: 0; }
</style>
</head>
<body class="vscode-${BODY_CLASS[theme]}">
<div id="root"></div>
<script>
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => {
      window.__posted.push(m);
      if (window.__toHost) window.__toHost(m);
    },
    getState: () => undefined,
    setState: () => {},
  });
  // Relays one HostToWebview message into the page, exactly as
  // ChatViewProvider.postMessage would deliver it over the real webview
  // message channel.
  window.__send = (msg) => window.dispatchEvent(new MessageEvent('message', { data: msg }));
  window.__typeUser = (text) => {
    const ta = document.querySelector('.chat-input-row textarea');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  window.__pressEscape = () => {
    const ta = document.querySelector('.chat-input-row textarea');
    ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  };
</script>
<script type="module" src="/${script}"></script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const script = url.pathname === '/' || url.pathname === '/index.html' ? 'chat.js'
    : url.pathname === '/tasklog' ? 'tasklog.js' : null;
  if (script) {
    const theme = themeName(url.searchParams.get('theme'));
    res.writeHead(200, { 'content-type': 'text/html' }).end(page(theme, script));
    return;
  }
  const file = path.join(dist, url.pathname.replace(/^\//, ''));
  if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`webview harness on http://127.0.0.1:${port}/ (bundle: ${dist})`);
});
