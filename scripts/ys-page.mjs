/** Yonyou DOM augmentation. Native ego snapshots remain the general page reader. */
export const VERSION = '2026-11-17.1';
export const BUSY = '.u-loader,.u-loading,.u-loading-mask,.wui-loading,.wui-loading-mask,.lebra-loading,.nc-loading,.loading-mask,.el-loading-mask,[aria-busy="true"]';
const MODALS = '.wui-modal,.u-modal,.lebra-modal,.modal-dialog,.el-dialog,dialog,[role="dialog"]';
const PARTS = ['fields', 'toolbar', 'rows', 'status'];
function positive(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer`);
  return result;
}
export async function context(page, opts = {}) {
  const parts = opts.parts ?? PARTS;
  if (!Array.isArray(parts) || parts.some(part => !PARTS.includes(part))) throw new TypeError('parts must contain fields, toolbar, rows or status');
  if (opts.framePath !== undefined && (typeof opts.framePath !== 'string' || !/^0(?:\/\d+)*$/.test(opts.framePath))) throw new TypeError('framePath must be an observed path such as 0/1');
  const config = { parts, scope: opts.scope ?? null, framePath: opts.framePath ?? null,
    maxFields: positive(opts.maxFields, 80, 'maxFields'), maxRows: positive(opts.maxRows, 200, 'maxRows'),
    maxValueChars: positive(opts.maxValueChars, 256, 'maxValueChars'), busy: BUSY, modals: MODALS };
  const state = await page.evaluate(c => {
    const records = [], visited = new Set(), unreadFrames = [], provenance = new Map();
    const limits = { fields: false, toolbar: false, rows: false, status: false };
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !(parseFloat(style.opacity) < 0.05);
    };
    const text = el => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    const walk = (doc, path) => {
      if (!doc || visited.has(doc)) return;
      visited.add(doc);
      let roots = [];
      if (!c.framePath || c.framePath === path) {
        try { roots = c.scope ? [...doc.querySelectorAll(c.scope)].filter(visible) : [doc]; }
        catch { unreadFrames.push({ framePath: path, reason: 'invalid-scope' }); }
        records.push({ doc, path, roots }); provenance.set(doc, path);
      }
      let index = 0;
      for (const frame of doc.querySelectorAll('iframe')) {
        const childPath = `${path}/${index++}`;
        if (c.scope && roots.length && !roots.some(root => root === doc || root.contains(frame))) continue;
        if (c.framePath && c.framePath !== childPath && !c.framePath.startsWith(childPath + '/')) continue;
        if (!visible(frame)) continue;
        let inner; try { inner = frame.contentDocument; } catch {}
        if (inner) walk(inner, childPath);
        else unreadFrames.push({ framePath: childPath, reason: 'inaccessible-frame' });
      }
    };
    walk(document, '0');
    const cache = new Map();
    const all = selector => {
      if (!cache.has(selector)) {
        const nodes = new Set();
        for (const { roots } of records) for (const root of roots) {
          if (root.matches?.(selector)) nodes.add(root);
          for (const node of root.querySelectorAll(selector)) nodes.add(node);
        }
        cache.set(selector, [...nodes]);
      }
      return cache.get(selector);
    };
    const pathOf = el => provenance.get(el.ownerDocument);
    const fieldidOf = el => el.getAttribute('fieldid') || el.getAttribute('data-fieldid') || '';
    const fields = [], toolbar = [], signature = [];
    const valueOf = el => el.type === 'checkbox' || el.type === 'radio' ? Boolean(el.checked) : String(el.value ?? '');
    if (c.parts.includes('fields')) for (const el of all('input,textarea,select')) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || type === 'file' || !visible(el)) continue;
      if (fields.length >= c.maxFields) { limits.fields = true; break; }
      let label = el.getAttribute('aria-label') || '';
      if (!label && el.labels?.length) label = [...el.labels].map(text).join(' ');
      if (!label) {
        const box = el.closest('.u-form-item,.wui-form-item,.lebra-form-item,.form-item');
        label = text(box?.querySelector('label,.u-form-item-label,.wui-form-item-label,.label'));
      }
      if (!label) {
        const row = el.closest('tr');
        if (row?.querySelectorAll('input,textarea,select').length === 1) label = text(row.querySelector('label,th'));
      }
      label ||= el.getAttribute('placeholder') || el.getAttribute('name') || '';
      const value = valueOf(el), fieldid = fieldidOf(el), framePath = pathOf(el);
      const disabled = el.matches(':disabled') || Boolean(el.closest('[aria-disabled="true"],[inert]'));
      signature.push(['field', framePath, fieldid, label, value, disabled, el.readOnly === true]);
      fields.push({ label: label.slice(0, 80), fieldid, framePath, tag: el.tagName.toLowerCase(), type: type || el.tagName.toLowerCase(),
        value: typeof value === 'string' ? value.slice(0, c.maxValueChars) : value,
        valueTruncated: typeof value === 'string' && value.length > c.maxValueChars,
        required: el.required === true || el.getAttribute('aria-required') === 'true', disabled, readonly: el.readOnly === true });
    }
    if (c.parts.includes('toolbar')) for (const el of all('[fieldid],[data-fieldid]')) {
      const fieldid = fieldidOf(el), key = fieldid.split('|').pop();
      if (!/^(btn|add|save|commit|cancel|delete|print|output)|SettingBtn/i.test(key) || !visible(el)) continue;
      if (toolbar.length >= 40) { limits.toolbar = true; break; }
      const item = { key, fieldid, framePath: pathOf(el), name: text(el).slice(0, 80),
        disabled: el.matches(':disabled') || Boolean(el.closest('[aria-disabled="true"],[inert]')) || /disabled/.test(String(el.className)) };
      toolbar.push(item); signature.push(['toolbar', item]);
    }
    let rows = 0;
    if (c.parts.includes('rows')) {
      const eligible = all('table tbody tr,.u-table-row,.wui-table-row,.lebra-table-row,[role="row"]').filter(el => {
        if (!visible(el) || el.querySelector('[role="columnheader"]')) return false;
        if (el.closest('[class*="calendar"],[class*="date-picker"],[fieldid$="_app-item"]')) return false;
        const table = el.closest('table');
        if (!table) return Boolean(el.querySelector('[role="cell"],[role="gridcell"],td') || el.matches('.u-table-row,.wui-table-row,.lebra-table-row'));
        if (/form|calendar|date|week/i.test(String(table.className))) return false;
        if (table.querySelector('thead th,[role="columnheader"]') || table.matches('[role="grid"],.u-table,.wui-table,.lebra-table')) return true;
        return !table.querySelector('.u-form-item,.wui-form-item,.lebra-form-item,label');
      });
      rows = eligible.length; limits.rows = rows > c.maxRows;
      for (const row of eligible.slice(0, c.maxRows)) signature.push(['row', pathOf(row), text(row)]);
    }
    let errors = [], toasts = [], busy = [], modal = null, modalCount = 0;
    if (c.parts.includes('status')) {
      const errorTexts = [...new Set(all('.u-form-item-error,.wui-form-item-error,.error-msg,.u-form-error,.ant-form-item-explain-error').filter(visible).map(text).filter(Boolean))];
      const toastTexts = [...new Set(all('.u-message-content,.wui-message-content,.message-content,.toast-message,.u-toast').filter(visible).map(text).filter(Boolean))];
      errors = errorTexts.slice(0, 8); toasts = toastTexts.slice(0, 6); limits.status = errorTexts.length > 8 || toastTexts.length > 6;
      busy = all(c.busy).filter(visible);
      const modals = all(c.modals).filter(visible); modalCount = modals.length;
      const last = modals.at(-1);
      if (last) modal = { cls: String(last.className || '').slice(0, 80), framePath: pathOf(last),
        title: (last.getAttribute('aria-label') || (last.getAttribute('aria-labelledby') || '').split(/\s+/)
          .filter(Boolean).map(id => text(last.ownerDocument.getElementById(id))).join(' ').trim() ||
          text(last.querySelector('h1,h2,h3,.wui-modal-title,.u-modal-title,.lebra-modal-title,.modal-title,.el-dialog__title'))).trim().slice(0, 200),
        buttons: [...last.querySelectorAll('button,a,.wui-modal-ok-button,.wui-modal-cancel-button')].filter(visible).map(text).filter(Boolean).slice(0, 10) };
      signature.push(['status', errorTexts, toastTexts, busy.length, modals.map(el => [pathOf(el), text(el)])]);
    }
    let shell = 'web';
    if (records.some(({ doc }) => doc.defaultView?.['nc-lightapp-front'] || doc.querySelector('.nc-lightapp-front,#nc-lightapp-front'))) shell = 'nccloud';
    else if (/\.yonyoucloud\.com$/i.test(location.hostname) || all('[class*="wui-"],[class*="lebra-"],[class*="mdf-"]').length) shell = 'flag';
    else if (/\/(nccloud|yonbip)\//i.test(location.pathname)) shell = 'nccloud';
    const tabNodes = all('[fieldid$="-tabs-area"]').filter(visible);
    const activeTab = tabNodes.find(el => el.classList.contains('active') || el.getAttribute('aria-selected') === 'true');
    const tabs = [...new Set(tabNodes.map(text).filter(Boolean))];
    const pagecodes = [...new Set([...fields, ...toolbar].map(item => item.fieldid).filter(id => id.includes('|')).map(id => id.split('|')[0]))];
    signature.push([location.href, document.title, text(activeTab), pagecodes]);
    let hash = 2166136261;
    const serialized = JSON.stringify(signature);
    for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
    const complete = records.some(record => record.roots.length) && unreadFrames.length === 0 && !Object.values(limits).some(Boolean);
    return { url: location.href, title: document.title, route: location.hash || location.pathname, shell,
      pagecode: pagecodes.length === 1 ? pagecodes[0] : '', pagecodes, tab: text(activeTab), tabs: tabs.slice(0, 12),
      frames: records.length, documents: records.map(({ doc, path, roots }) => ({ framePath: path, url: doc.URL, scopeMatches: roots.length })),
      scope: c.scope, framePath: c.framePath, coverage: 'same-origin-light-dom', shadowDOM: 'not-traversed',
      complete, unreadFrames, truncated: Object.values(limits).some(Boolean), limits, parts: c.parts,
      toolbar, fields, fieldCount: fields.length, errors, toasts, rows, rowsAreTotal: false,
      rowMeaning: 'rendered-visible-rows', rowSampleLimit: c.maxRows, busy: busy.length > 0, busyCount: busy.length,
      modal, modalCount, fingerprint: (hash >>> 0).toString(16) };
  }, config);
  if (!state || typeof state !== 'object' || !Array.isArray(state.documents) || typeof state.complete !== 'boolean') {
    return { ok: false, complete: false, reason: 'invalid-result-shape', version: VERSION, at: Date.now() };
  }
  // Unrequested sections are omitted: an unread table must not look like zero rows.
  const sectionKeys = { fields: ['fields', 'fieldCount'], toolbar: ['toolbar'],
    rows: ['rows', 'rowsAreTotal', 'rowMeaning', 'rowSampleLimit'],
    status: ['errors', 'toasts', 'busy', 'busyCount', 'modal', 'modalCount'] };
  for (const [part, keys] of Object.entries(sectionKeys)) if (!parts.includes(part)) {
    for (const key of keys) delete state[key];
    if (state.limits) delete state.limits[part];
  }
  return { ...state, ok: state.complete, version: VERSION, at: Date.now() };
}
/** Content stability is an observation heuristic, never proof of a saved record. */
export async function waitIdle(page, opts = {}) {
  const timeout = positive(opts.timeout, 15000, 'timeout'), step = positive(opts.step, 300, 'step'), need = positive(opts.stable, 2, 'stable');
  if (opts.until !== undefined && typeof opts.until !== 'function') throw new TypeError('until must be a predicate of the observed state');
  const started = Date.now(); let stable = 0, last = null, state = null;
  do {
    state = await context(page, { ...opts, maxFields: opts.maxFields ?? 40,
      parts: [...new Set([...(opts.parts ?? ['fields', 'rows']), 'status'])] });
    const ready = state.complete && !state.busy;
    stable = ready && state.fingerprint === last ? stable + 1 : 0; last = state.fingerprint;
    if (ready && (opts.until ? await opts.until(state) : stable >= need)) return { ok: true, waitedMs: Date.now() - started,
      readiness: opts.until ? 'predicate' : 'observed-content-stable', businessVerified: false, state };
    if (Date.now() - started >= timeout) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(step, timeout - (Date.now() - started))));
  } while (Date.now() - started < timeout);
  return { ok: false, timedOut: true, waitedMs: Date.now() - started,
    reason: !state?.complete ? 'incomplete' : state.busy ? 'busy' : opts.until ? 'target-not-ready' : 'content-changing', stillBusy: Boolean(state?.busy), state };
}
export async function scan(page, opts = {}) {
  const moduleUrl = new URL('./ys-locate.mjs', import.meta.url); moduleUrl.search = new URL(import.meta.url).search;
  const { inspect } = await import(moduleUrl.href);
  const limit = positive(opts.limit, opts.detail === 'full' ? 300 : 80, 'limit');
  const observation = await inspect(page, { ...opts, scanLimit: opts.elementLimit ?? limit });
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const elements = observation.items.slice(0, limit).map((item, index) => ({ index: index + 1, tag: item.tag, role: item.role || '',
    name: clean(item.aria || item.title || item.dataTitle || item.label || item.text || item.value).slice(0, 80),
    fieldid: item.fieldid || '', value: clean(item.value).slice(0, 80), disabled: item.disabled, inView: item.inView, frame: item.frame, framePath: item.framePath }));
  const truncated = observation.limitReached || observation.items.length > limit;
  return { ok: observation.complete && !truncated, complete: observation.complete && !truncated,
    url: observation.url || '', elements, scannedTotal: observation.scannedTotal, truncated,
    elementLimit: observation.elementLimit, displayLimit: limit, coverage: observation.coverage, shadowDOM: 'not-traversed',
    unreadFrames: observation.unreadFrames, scopeMatches: observation.scopeMatches, documents: observation.documents };
}
/** Read one observed element without treating missing, ambiguous and empty as equal. */
export async function readValue(page, opts = {}) {
  if (typeof opts.selector !== 'string' || !opts.selector.trim()) throw new TypeError('selector is required');
  if (opts.framePath !== undefined && (typeof opts.framePath !== 'string' || !/^0(?:\/\d+)*$/.test(opts.framePath))) throw new TypeError('framePath must be an observed path such as 0/1');
  const kind = opts.kind ?? 'value';
  if (!['value', 'text', 'checked'].includes(kind)) throw new TypeError('kind must be value, text or checked');
  const config = { selector: opts.selector, framePath: opts.framePath ?? null, scope: opts.scope ?? null,
    kind, maxChars: positive(opts.maxChars, 1024, 'maxChars') };
  const result = await page.evaluate(c => {
    const matches = [], unreadFrames = [], visited = new Set(); let scopeMatches = 0, documents = 0, invalid = false;
    const visible = node => {
      const r = node.getBoundingClientRect(), s = node.ownerDocument.defaultView.getComputedStyle(node);
      return r.width >= 2 && r.height >= 2 && s.visibility !== 'hidden' && s.display !== 'none' && !(parseFloat(s.opacity) < 0.05);
    };
    const walk = (doc, path) => {
      if (!doc || visited.has(doc)) return; visited.add(doc);
      let roots = [];
      if (!c.framePath || c.framePath === path) {
        documents++;
        try {
          roots = c.scope ? [...doc.querySelectorAll(c.scope)].filter(visible) : [doc]; scopeMatches += roots.length;
          const nodes = new Set();
          for (const root of roots) {
            if (root.matches?.(c.selector)) nodes.add(root);
            for (const node of root.querySelectorAll(c.selector)) nodes.add(node);
          }
          for (const el of nodes) if (visible(el)) matches.push({ el, path });
        } catch { invalid = true; }
      }
      let index = 0;
      for (const frame of doc.querySelectorAll('iframe')) {
        const childPath = `${path}/${index++}`;
        if (c.framePath && c.framePath !== childPath && !c.framePath.startsWith(childPath + '/')) continue;
        if (c.scope && roots.length && !roots.some(root => root === doc || root.contains(frame))) continue;
        if (!visible(frame)) continue;
        let child; try { child = frame.contentDocument; } catch {}
        if (child) walk(child, childPath); else unreadFrames.push({ framePath: childPath, reason: 'inaccessible-frame' });
      }
    };
    walk(document, '0');
    const base = { complete: !invalid && documents > 0 && scopeMatches > 0 && unreadFrames.length === 0,
      matched: matches.length, scopeMatches, unreadFrames, coverage: 'same-origin-light-dom', shadowDOM: 'not-traversed' };
    if (invalid) return { ...base, ok: false, found: null, reason: 'invalid-selector' };
    if (matches.length !== 1) return { ...base, ok: false, found: matches.length ? null : false,
      reason: matches.length ? 'ambiguous' : base.complete ? 'missing' : 'incomplete' };
    const { el, path } = matches[0];
    const raw = c.kind === 'text' ? String(el.innerText ?? el.textContent ?? '') : el[c.kind];
    if (c.kind === 'checked' ? typeof raw !== 'boolean' : typeof raw !== 'string' && typeof raw !== 'number') {
      return { ...base, ok: false, found: true, framePath: path, reason: 'shape-mismatch', expected: c.kind };
    }
    const value = typeof raw === 'string' ? raw.slice(0, c.maxChars) : raw;
    const truncated = typeof raw === 'string' && raw.length > c.maxChars;
    return { ...base, ok: base.complete && !truncated, complete: base.complete && !truncated, found: true,
      framePath: path, tag: el.tagName.toLowerCase(), value, truncated };
  }, config);
  if (!result || typeof result !== 'object' || typeof result.complete !== 'boolean' || typeof result.matched !== 'number') {
    return { ok: false, complete: false, found: null, reason: 'invalid-result-shape' };
  }
  return result;
}
export function attach(page) {
  const api = { context: opts => context(page, opts), waitIdle: opts => waitIdle(page, opts), scan: opts => scan(page, opts), readValue: opts => readValue(page, opts) };
  page.ys = Object.assign(page.ys || {}, api); globalThis.ys = page.ys; return api;
}
export default { VERSION, context, waitIdle, scan, readValue, attach };
