import { app, type BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The launch check (VCDIT_SMOKE=1): the real app, started as a person would
 * start it, on a fresh profile of its own; it opens its window, goes to every
 * screen of the flow, and quits, printing what it found:
 *
 *   VCDIT_SMOKE OK screens=…
 *   VCDIT_SMOKE FAIL <why>
 *
 * It fails on an error in the main process, an error logged in the window,
 * a page that does not load or a renderer that dies, a screen that does
 * not draw, or a start that takes over a minute. CI runs it on every push
 * (.github/workflows/ci.yml), so a broken start is found before an install.
 */

export const SMOKE = process.env['VCDIT_SMOKE'] === '1';

let done = false;

const finish = (ok: boolean, detail: string) => {
  if (done) return;
  done = true;
  process.stdout.write(`VCDIT_SMOKE ${ok ? 'OK' : 'FAIL'} ${detail}\n`);
  app.exit(ok ? 0 : 1);
};

/** Before the app is ready: a profile of its own, and any error in the main process fails the check. */
export const prepareSmoke = () => {
  if (!SMOKE) return;
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'vcdit-smoke-')));
  process.on('uncaughtException', (cause) => finish(false, `main process: ${cause.stack ?? cause.message}`));
  process.on('unhandledRejection', (cause) => finish(false, `main process: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`));
};

export const smokeFailed = (detail: string) => finish(false, detail);

/** What the page does: every step of the flow and its screens, one after another, each checked to have drawn. */
const VISIT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen = [];
  const problems = [];
  const name = (element) => element.textContent.trim().replace(/\\s+/g, ' ').slice(0, 32);
  const drawn = () => {
    const content = document.querySelector('#content');
    return content && content.children.length > 0 && content.textContent.trim().length > 20;
  };
  if (!drawn()) problems.push('the first screen did not draw');
  const steps = document.querySelectorAll('nav.flow-bar button');
  for (let i = 0; i < steps.length; i += 1) {
    document.querySelectorAll('nav.flow-bar button')[i].click();
    await wait(300);
    const step = name(document.querySelectorAll('nav.flow-bar button')[i]);
    // Each screen of the step, by its pill.
    const tabs = document.querySelectorAll('.sub-tabs [role="tab"]');
    const visits = tabs.length ? tabs.length : 1;
    for (let t = 0; t < visits; t += 1) {
      const tab = document.querySelectorAll('.sub-tabs [role="tab"]')[t];
      if (tab) {
        tab.click();
        await wait(300);
      }
      const label = tab ? step + ' / ' + name(tab) : step;
      seen.push(label);
      if (!drawn()) problems.push('nothing drew for ' + label);
    }
  }
  // And the screens off the flow: Today, Project setup, Reports, from the header.
  for (const wanted of ['Today', 'Project setup', 'Reports']) {
    const button = [...document.querySelectorAll('header button')].find((element) => name(element) === wanted);
    if (!button) {
      problems.push('no ' + wanted + ' button');
      continue;
    }
    button.click();
    await wait(300);
    seen.push(wanted);
    if (!drawn()) problems.push('nothing drew for ' + wanted);
  }
  return { seen, problems, title: document.title };
})()`;

/** Watch the window: load, visit every screen, report. */
export const watchSmoke = (window: BrowserWindow) => {
  if (!SMOKE) return;
  const errors: string[] = [];
  setTimeout(() => finish(false, 'the window did not finish loading in 60 s'), 60_000).unref();
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  window.webContents.on('render-process-gone', (_event, details) => finish(false, `the window's renderer stopped: ${details.reason}`));
  window.webContents.on('did-fail-load', (_event, code, description) => finish(false, `the window did not load: ${description} (${code})`));
  window.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      window.webContents
        .executeJavaScript(VISIT)
        .then((result: { seen: string[]; problems: string[]; title: string }) => {
          const problems = [...result.problems, ...errors.map((error) => `console: ${error}`)];
          if (result.seen.length === 0) problems.push('no flow steps to visit');
          if (problems.length) finish(false, problems.join(' | '));
          else finish(true, `title="${result.title}" screens=${result.seen.length}: ${result.seen.join(', ')}`);
        })
        .catch((cause: Error) => finish(false, `the screens could not be visited: ${cause.message}`));
    }, 2000);
  });
};
