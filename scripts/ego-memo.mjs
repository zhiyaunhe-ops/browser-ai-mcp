// Per-round operation guidance and bounded, settled runtime observations.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const file of ['../src/memo.js', '../src/program-contract.js']) delete require.cache[require.resolve(file)];
const memo = require('../src/memo.js');
const { assertCall } = require('../src/program-contract.js');
export const VERSION = memo.VERSION;
export const MEMO = memo.MEMO;
export const MEMO_SHORT = memo.MEMO_SHORT;
const registry = globalThis[Symbol.for('browser-ai.memo.bindings')] ||= { pages: new WeakMap(), tasks: new WeakMap() };
const ORIGINAL = Symbol.for('browser-ai.memo.original');
const CAP = 128;
let latest;

function collector() {
  return { sequence: 0, events: [], droppedEvents: 0, counts: {},
    stats: { coords: 0, autoLabel: 0, semantic: 0, evaluated: 0, installed: 0, catalog: null } };
}
function wrap(target, key, invoke) {
  if (typeof target?.[key] !== 'function') return;
  const original = target[key][ORIGINAL] || target[key];
  const wrapped = function (...args) { return invoke.call(this, original, args); };
  wrapped[ORIGINAL] = original;
  target[key] = wrapped;
}
async function measured(c, label, method, stage, invoke) {
  const sequence = ++c.sequence, start = Date.now();
  const count = c.counts[stage] ||= { attempted: 0, succeeded: 0, failed: 0 };
  count.attempted++;
  // Reserve by invocation order so a slow early call does not disappear at the cap.
  const event = sequence <= CAP ? { sequence, method, stage, pageLabel: label } : null;
  if (event) c.events.push(event); else c.droppedEvents++;
  try {
    const result = await invoke(); count.succeeded++;
    if (event) {
      event.outcome = 'succeeded';
      for (const key of ['complete', 'truncated', 'reason', 'ok']) {
        const value = result?.[key];
        if (typeof value === 'boolean' || key === 'reason' && typeof value === 'string') event[key] = typeof value === 'string' ? value.slice(0, 240) : value;
      }
    }
    return result;
  } catch (error) {
    count.failed++;
    if (event) { event.outcome = 'failed'; event.errorCode = String(error?.code || error?.name || 'ERROR').slice(0, 100); }
    throw error;
  } finally { if (event) event.durationMs = Date.now() - start; }
}
function instrument(page, c, label, selected = true) {
  if (!page) return page;
  registry.pages.set(page, { c, label: label || page.label || 'unknown' });
  const binding = () => registry.pages.get(page);
  const track = () => {
    const { c, label } = binding();
    const read = page.events?.[ORIGINAL] || page.events;
    if (c.network) c.network.track(page, label, () => read.call(page));
  };
  if (c.network) {
    if (selected) track();
    wrap(page, 'events', async function (original, args) {
      track();
      const events = await original.apply(this, args);
      try { binding().c.network.accept(binding().label, events); }
      catch { /* Preserve the caller's raw event drain. */ }
      return events;
    });
  }
  const stages = { snapshot: 'semantic', screenshot: 'visual', evaluate: 'evaluation',
    click: 'action', dblclick: 'action', hover: 'action', dragAndDrop: 'action', fill: 'action',
    selectOption: 'action', focus: 'action', press: 'action', setInputFiles: 'action', goto: 'action', reload: 'action' };
  for (const key of ['url', 'title', 'cdp', 'fetch', 'waitForSelector', 'waitForLoadState']) {
    if (c.network) wrap(page, key, function (original, args) { track(); return original.apply(this, args); });
  }
  for (const [key, stage] of Object.entries(stages)) wrap(page, key, async function (original, args) {
    const { c, label } = binding();
    track();
    if (c.memo === false) return original.apply(this, args);
    c.lastPage = page;
    return measured(c, label, `page.${key}`, stage, async () => {
      assertCall(`page.${key}`, args);
      if (key === 'evaluate') c.stats.evaluated++;
      if (key === 'click') {
        c.stats.semantic++;
        args[1] = { ...(args[1] || {}), label: args[1]?.label || `click ${String(args[0]).slice(0, 80)}` };
      }
      return original.apply(this, args);
    });
  });
  for (const key of ['click', 'move', 'wheel', 'down', 'up']) wrap(page.mouse, key, async function (original, args) {
    const { c, label } = binding();
    track();
    if (c.memo === false) return original.apply(this, args);
    c.lastPage = page;
    return measured(c, label, `page.mouse.${key}`, 'action', async () => {
      assertCall(`page.mouse.${key}`, args);
      if (key === 'click' && Number.isFinite(args[0]) && Number.isFinite(args[1])) {
        c.stats.coords++;
        if (!args[2]?.label) {
          c.stats.autoLabel++;
          args[2] = { ...(args[2] || {}), label: `coordinate click at ${args[0]},${args[1]} -> ${await describeAt(page, args[0], args[1])}` };
        }
      }
      return original.apply(this, args);
    });
  });
  for (const key of ['press', 'type', 'down', 'up', 'insertText']) {
    if (c.network) wrap(page.keyboard, key, function (original, args) { track(); return original.apply(this, args); });
  }
  return page;
}
function instrumentTask(task, c) {
  if (!task) return;
  registry.tasks.set(task, c);
  wrap(task, 'page', function (original, args) { return instrument(original.apply(this, args), registry.tasks.get(task), args[0]); });
  for (const key of ['newPage', 'adopt']) wrap(task, key, async function (original, args) {
    const c = registry.tasks.get(task);
    const page = instrument(await original.apply(this, args), c);
    c.lastPage = page;
    return page;
  });
  wrap(task, 'pages', async function (original, args) {
    return (await original.apply(this, args)).map(page => instrument(page, registry.tasks.get(task), undefined, false));
  });
}
async function describeAt(page, x, y) {
  try { return await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return 'nothing';
    const own = n => (n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim();
    return `${el.tagName.toLowerCase()}:${(own(el) || own(el.parentElement || el)).slice(0, 40).replace(/\s+/g, ' ')}`;
  }, [x, y]); } catch { return 'unknown'; }
}
export async function install(page, opts = {}) {
  if (!page) return { skipped: 'no page' };
  const c = collector(); latest = c;
  c.network = opts.network;
  c.memo = opts.memo;
  instrumentTask(opts.task, c); instrument(page, c, opts.pageLabel);
  if (c.memo === false) return { installed: false };
  page.__egoMemoInstalled = `${VERSION}:${new URL(import.meta.url).search}`;
  c.stats.installed++;
  page.ys = {
    fieldid: key => `button[fieldid$="|${String(key).replace(/^\||\|$/g, '')}"]`,
    visible: (target, selector) => {
      const p = typeof target === 'string' ? page : target;
      return p.evaluate(sel => {
        const el = document.querySelector(sel); if (!el) return false;
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }, typeof target === 'string' ? target : selector);
    },
    count: () => ({ ...c.stats }),
  };
  for (const [file, stat] of [['ys-locate.mjs', 'locate'], ['ys-page.mjs', 'page'], ['ys-transfer.mjs', 'transfer']]) {
    try {
      const url = new URL(`./${file}`, import.meta.url); url.search = new URL(import.meta.url).search;
      const mod = await import(url.href); mod.attach(page); c.stats[stat] = mod.VERSION;
    } catch (error) { c.stats[`${stat}Error`] = error.message; }
  }
  for (const key of ['context', 'inspect', 'find', 'entries', 'list', 'collect', 'scan', 'readValue', 'waitIdle', 'waitFor', 'click', 'transferState', 'transferRight']) {
    wrap(page.ys, key, function (original, args) {
      const stage = key === 'click' || key === 'transferRight' ? 'action' : 'adapter';
      return measured(c, opts.pageLabel || page.label || 'unknown', `ys.${key}`, stage, () => original.apply(this, args));
    });
  }
  globalThis.ys = page.ys;
  if (opts.catalog !== false) {
    try {
      const fs = await import('node:fs');
      const file = join(homedir(), '.browser-ai', 'yonyou-catalog-global.json');
      if (fs.existsSync(file)) c.stats.catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* Optional catalog. */ }
  }
  return { installed: true, version: VERSION, memoChars: MEMO.length, catalog: !!c.stats.catalog };
}
export function banner() { return MEMO; }
export function report(page) {
  const s = (page ? registry.pages.get(page)?.c : latest)?.stats || {};
  return `[ego memo] coords=${s.coords || 0} auto-labeled=${s.autoLabel || 0} semantic=${s.semantic || 0} evaluate=${s.evaluated || 0} catalog=${s.catalog ? 'loaded' : 'none'}`;
}
export function observationTrace(page) {
  const c = page ? registry.pages.get(page)?.c : latest;
  if (!c) return null;
  return { version: 1, events: c.events.map(event => ({ ...event, ...(!event.outcome ? { outcome: 'pending' } : {}) })),
    droppedEvents: c.droppedEvents, counts: structuredClone(c.counts) };
}
export async function readMemoContext(page, mode) {
  const target = registry.pages.get(page)?.c.lastPage || page;
  const pageLabel = registry.pages.get(target)?.label || target.label;
  if (mode === 'url') return { pageLabel, url: await target.url() };
  const moduleUrl = new URL('./ys-page.mjs', import.meta.url);
  moduleUrl.search = new URL(import.meta.url).search;
  const { context } = await import(moduleUrl.href);
  // This read supplies reminders, separate from the caller's observation trace.
  const evaluate = (target.evaluate[ORIGINAL] || target.evaluate).bind(target);
  const state = await context({ evaluate }, { parts: ['status'] });
  if (state.url) return { pageLabel, url: state.url, dialogTitle: state.modal?.title || null };
}
export function prelude(moduleUrl = import.meta.url) {
  return [`const __egoMemo = await import(${JSON.stringify(moduleUrl)});`, 'await __egoMemo.install(page);',
    'console.log(__egoMemo.banner());'].join('\n');
}
