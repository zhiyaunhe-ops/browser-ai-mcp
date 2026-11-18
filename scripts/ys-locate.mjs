// 元素定位脚本：把「可访问名 → 文本 → 相似度 → 候选清单」这套阶梯固化成函数，
// agent 不必自己拼选择器，也不会在 iframe 里点空。
//
// 用法（MCP 轮的 prelude 已自动挂到 page.ys / globalThis.ys 上）：
//   await ys.click("保存");
//   await ys.click("更多", { fieldid: "btnMore" });
//   const hit = await ys.find("预算控制规则");        // { ok, best, candidates }
//   const top = await ys.list("保存", { limit: 5 });  // 找不到时先看清单
//
// 独立使用：
//   const locate = await import("./scripts/ys-locate.mjs");
//   await locate.click(page, "保存");
//
// 选择器与候选文本的取法参考 YonWork 官方 browser-agent 的语义定位实现
// （document.querySelectorAll 的动作集合、aria/title/placeholder/name/data-title/value/label 候选、
//   可见性 2px 与 opacity 0.05、命中后 scrollIntoView 居中），见 references/yonwork-harness.md。

import { BUSY } from './ys-page.mjs';

export const VERSION = "2026-11-18.2";

// 精确名才算「强匹配」：前缀/包含/同义词都算模糊，click 默认拒绝。
export const STRONG = 1;

// 用友常见的同义说法：命中任一个都算同一类按钮。
const ALIASES = [
  ["保存", "save"],
  ["确定", "确认", "ok"],
  ["取消", "关闭", "cancel", "close"],
  ["新增", "添加", "新建", "add", "create"],
  ["删除", "移除", "delete", "remove"],
  ["查询", "搜索", "search", "query"],
  ["更多", "more"],
  ["刷新", "refresh"],
  ["提交", "上报", "submit"],
  ["返回", "back"],
];

// 明确就是控件的元素：不做尺寸限制。
const SPECIFIC_SELECTORS = [
  "button",
  "a[href]",
  "input[type=button]",
  "input[type=submit]",
  "input[type=reset]",
  "input[type=image]",
  "[role=button]",
  "[role=menuitem]",
  "[role=tab]",
  "[role=link]",
  "[role=treeitem]",
  "[aria-expanded]",
  "[role=checkbox]",
  "[role=radio]",
  "[fieldid]",
  "[data-fieldid]",
  ".wui-btn",
  ".wui-button",
  ".btn",
  ".btnDirectSearch",
  ".SettingBtn",
  ".u-button",
  ".lebra-button",
];

// 可能是控件、也可能是一大片容器的元素：只收「按钮大小」的那些。
// 用友的纯图标按钮常常是 <div tabindex="0" onclick=...> 或 <span aria-label=...>，
// 只查 button/a/role 会漏，这是「Button 有时候找不到」的主因之一。
const GENERIC_SELECTORS = [
  "[onclick]",
  "[tabindex]",
  "[aria-label]",
  "[data-title]",
  "[alt]",
  "[contenteditable=true]",
  "input:not([type=hidden])",
  "select",
  "textarea",
];

const GENERIC_MAX_W = 420;
const GENERIC_MAX_H = 90;
const GENERIC_MAX_TEXT = 60;

// Some grids delegate React events to their root. Inspect compact cell contents
// for interaction cues without enumerating every span/div in the workbench.
const CELL = 'td,[role="gridcell"],[role="cell"],.fixedDataTableCellLayout_main';
const ROW_ACTION = '.row-edit-option[class*="row-btn-"],.row-more[class*="row-btn-"]';
const INLINE_LINKS = [ROW_ACTION, 'a:not([href])', ':is(' + CELL + ') :is(span,div)',
  ':is(' + CELL + ')', '.u-table-link', '.wui-table-link', '[class~="link"]'];

/** 规整文本：去空白（含全角空格）、小写、去常见符号。 */
export function norm(value) {
  return String(value ?? "")
    .replace(/[\s\u3000\u00a0]+/g, "")
    .replace(/[（）()【】\[\]「」『』“”"'’‘:：.,，。、!！?？*_\-—…·|/\\]/g, "")
    .toLowerCase();
}

function bigrams(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/** Dice 系数：0 表示完全不同，1 表示完全一致。 */
export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.8 : 0;
  const left = bigrams(a);
  const right = new Map();
  for (const g of bigrams(b)) right.set(g, (right.get(g) || 0) + 1);
  let hits = 0;
  for (const g of left) {
    const n = right.get(g) || 0;
    if (n > 0) { hits++; right.set(g, n - 1); }
  }
  return (2 * hits) / (left.length + bigrams(b).length);
}

function aliasGroup(word) {
  return ALIASES.find(group => group.some(one => norm(one) === norm(word)));
}

/** 一个候选元素身上所有可能的名字，按可信度排好。 */
function namesOf(candidate) {
  return [candidate.aria, candidate.title, candidate.dataTitle, candidate.alt,
    candidate.label, candidate.name, candidate.value, candidate.placeholder, candidate.text]
    .map(norm).filter(Boolean);
}

/**
 * 打分：规整后精确 1.0，前缀/后缀 0.9，包含 0.86，
 * 同义词组 0.8，其余按 Dice 相似度折半（避免弱匹配抢走真按钮）。
 */
export function score(query, candidate) {
  const q = norm(query);
  if (!q) return 0;
  const names = namesOf(candidate);
  if (!names.length) return 0;
  let best = 0;
  for (const n of names) {
    if (n === q) { best = Math.max(best, 1); continue; }
    if (n.startsWith(q) || n.endsWith(q)) { best = Math.max(best, 0.9); continue; }
    if (n.includes(q) || q.includes(n)) { best = Math.max(best, 0.86); continue; }
    const group = aliasGroup(query);
    if (group && group.some(one => norm(one) === n)) { best = Math.max(best, 0.8); continue; }
    best = Math.max(best, dice(q, n) * 0.5);
  }
  return best;
}

/**
 * 在顶层文档与所有同源 iframe 里收集可点元素。
 * 坐标换算成顶层视口绝对坐标，页面 mouse.click 可以直接用。
 * 视口之外的元素不再丢弃：标 inView=false 一起返回，交给 click 先滚动再点。
 */
export async function inspect(page, opts = {}) {
  if (opts.scanLimit !== undefined && (!Number.isInteger(opts.scanLimit) || opts.scanLimit < 1)) throw new TypeError('scanLimit must be a positive integer');
  if (opts.framePath !== undefined && (typeof opts.framePath !== 'string' || !/^0(?:\/\d+)*$/.test(opts.framePath))) throw new TypeError('framePath must be an observed path such as 0/1');
  if (opts.rowText !== undefined && (typeof opts.rowText !== 'string' || !opts.rowText.trim())) throw new TypeError('rowText must be a nonempty cell label');
  const cap = Math.max(1, Math.min(10000, Math.floor(opts.scanLimit || 900)));
  const observed = await page.evaluate(([specific, generic, limit, scope, maxW, maxH, maxText, fieldid, targetFrame, inline, cellSelector, rowText, rowActionSelector, busySelector]) => {
    const out = [];
    const seen = new Set();
    const hitIds = new WeakMap();
    const unreadFrames = [];
    let nextHitId = 1, documents = 0, selectedDocuments = 0, scopeMatches = 0, limitReached = false, busy = false;
    const specificSelector = specific.join(',');
    const genericSelector = generic.join(',');
    const isMapping = /对照表|對照表|映射表|mapping table|comparison table/i;
    const tidy = value => String(value || '').replace(/\s+/g, ' ').trim();
    const rowCache = new WeakMap();
    const rowSelector = 'tr,[role="row"],.wui-table-row,.u-table-row,.fixedDataTableRowLayout_main';
    const rowOf = row => {
      if (!row) return null;
      if (!rowCache.has(row)) {
        const cells = [...row.querySelectorAll(cellSelector)]
          .filter(cell => cell.closest(rowSelector) === row).map(cell => tidy(cell.innerText));
        rowCache.set(row, { cells, text: cells.filter(Boolean).join(' | ').slice(0, 160) });
      }
      return rowCache.get(row);
    };
    const visible = (el, view, style) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      let st;
      try { st = style || view.getComputedStyle(el); } catch { return null; }
      if (!st) return null;
      if (st.display === "none" || st.visibility === "hidden") return null;
      const opacity = parseFloat(st.opacity);
      if (Number.isFinite(opacity) && opacity < 0.05) return null;
      return r;
    };
    const labelText = (el, doc) => {
      const parts = [];
      const wrapped = el.closest("label");
      if (wrapped) parts.push((wrapped.innerText || "").trim());
      const id = el.getAttribute("id");
      if (id) {
        try {
          doc.querySelectorAll('label[for="' + CSS.escape(id) + '"]')
            .forEach(node => parts.push((node.innerText || "").trim()));
        } catch {}
      }
      return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 80);
    };
    const walk = (doc, dx, dy, depth, clip, ancestors, framePath) => {
      if (!doc || limitReached) return;
      documents++;
      const selected = !targetFrame || framePath === targetFrame;
      let roots = [];
      if (selected) {
        selectedDocuments++;
        try { roots = scope ? [...doc.querySelectorAll(scope)] : [doc]; }
        catch { unreadFrames.push({ framePath, reason: 'invalid-scope' }); }
        scopeMatches += roots.length;
        busy ||= roots.some(root => (root.matches?.(busySelector) && visible(root, doc.defaultView))
          || [...root.querySelectorAll(busySelector)].some(el => el.matches(busySelector) && visible(el, doc.defaultView)));
      }
      const pick = (selector, isGeneric) => {
        let nodes;
        try {
          nodes = roots.flatMap(root => [
            ...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector),
          ]);
        } catch { return; }
        for (const el of nodes) {
          if (seen.has(el)) continue;
          seen.add(el);
          const actualFieldid = el.getAttribute('fieldid') || el.getAttribute('data-fieldid') || '';
          if (fieldid && actualFieldid !== fieldid && !actualFieldid.endsWith('|' + fieldid)) continue;
          const rowNode = el.closest(rowSelector);
          if (rowText && !rowOf(rowNode)?.cells.includes(rowText)) continue;
          const isSpecific = el.tagName === 'BUTTON' || Boolean(actualFieldid) || el.matches(specificSelector);
          const rowAction = el.matches(rowActionSelector);
          // NC tables often delegate events and render their action as a plain anchor.
          const rowAnchor = rowNode && el.tagName === 'A' && !el.matches('[name]');
          const inlineOnly = !fieldid && !rowAction && !rowAnchor && !isSpecific && !el.matches(genericSelector);
          if (inlineOnly && el.parentElement?.closest('a,button,[role="link"],[role="button"],[onclick]')) continue;
          const style = (inlineOnly || rowNode) ? doc.defaultView.getComputedStyle(el) : null;
          const pointer = style?.cursor === 'pointer';
          const handlesClick = typeof el.onclick === 'function' || el.matches('[onclick]');
          if (inlineOnly && !pointer && !handlesClick) continue;
          const r = visible(el, doc.defaultView, style);
          if (!r) continue;
          if (rowAction && el.checkVisibility && !el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) continue;
          const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (inlineOnly) {
            if (!text) continue;
            if (el.children?.length && [...el.children].some(child => tidy(child.innerText) === text)) continue;
          }
          if (isGeneric && !isSpecific) {
            // 泛选择器只收按钮大小的：容器、列表行、整块 div 不是控件
            if (r.width > maxW || r.height > maxH) continue;
            if (text.length > maxText && !el.getAttribute("aria-label") && !el.getAttribute("data-title")) continue;
          }
          const expanded = el.getAttribute('aria-expanded');
          const isLink = rowAction || el.matches('a,[role="link"]') || inlineOnly || (rowNode && (pointer || handlesClick));
          const label = el.getAttribute('aria-label') || el.getAttribute('title') || text;
          const mapping = isMapping.test(label) && label.length <= 60
            && (isLink || handlesClick || el.matches('button,[role="button"],input[type="button"],.u-button,.wui-button,.btn')
              || /\|btn/i.test(actualFieldid));
          const entryKind = mapping ? 'mapping' : expanded === 'false' ? 'expand' : isLink ? 'link' : null;
          const row = rowText || entryKind ? rowOf(rowNode) : null;
          const left = dx + r.left, top = dy + r.top;
          const right = left + r.width, bottom = top + r.height;
          const vx = Math.max(0, Math.min(right, clip.right) - Math.max(left, clip.left));
          const vy = Math.max(0, Math.min(bottom, clip.bottom) - Math.max(top, clip.top));
          const inView = vx >= r.width * 0.6 && vy >= r.height * 0.6;
          const x = Math.round((left + right) / 2), y = Math.round((top + bottom) / 2);
          let hitKey = null;
          if (inView) {
            const hit = doc.elementFromPoint(x - dx, y - dy);
            if (!hit || (hit !== el && !el.contains(hit))) continue;
            if (ancestors.some(a => a.doc.elementFromPoint(x - a.dx, y - a.dy) !== a.frame)) continue;
            if (!hitIds.has(hit)) hitIds.set(hit, nextHitId++);
            hitKey = framePath + ':' + hitIds.get(hit);
          }
          // One extra eligible candidate proves overflow; exactly limit is complete.
          if (out.length >= limit) { limitReached = true; return; }
          out.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 80),
            name: (el.getAttribute("name") || "").trim(),
            aria: (el.getAttribute("aria-label") || "").trim(),
            title: (el.getAttribute("title") || "").trim(),
            dataTitle: (el.getAttribute("data-title") || "").trim(),
            alt: (el.getAttribute("alt") || "").trim(),
            label: labelText(el, doc),
            value: String(el.value || "").trim(),
            placeholder: (el.getAttribute("placeholder") || "").trim(),
            fieldid: actualFieldid,
            role: (el.getAttribute("role") || "").toLowerCase(),
            cls: String(el.className || "").slice(0, 120),
            disabled: el.matches(":disabled") || !!el.closest('[aria-disabled="true"], [inert]'),
            frame: depth,
            framePath, hitKey,
            rowText: row?.text || '',
            ...(entryKind && row ? { rowCells: row.cells.filter(Boolean).slice(0, 8).map(value => value.slice(0, 100)) } : {}),
            entryKind,
            inView,
            x, y,
            w: Math.round(r.width), h: Math.round(r.height),
          });
        }
      };
      if (fieldid) pick('[fieldid],[data-fieldid]', false);
      else pick([...specific, ...generic, ...inline].join(','), true);
      let frameIndex = 0;
      for (const frame of doc.querySelectorAll("iframe")) {
        if (limitReached) break;
        const childPath = framePath + '/' + frameIndex++;
        if (scope && roots.length && !roots.some(root => root === doc || root.contains(frame))) continue;
        if (targetFrame && childPath !== targetFrame && !targetFrame.startsWith(childPath + '/')) continue;
        const fr = visible(frame, doc.defaultView);
        if (!fr) continue;
        let inner;
        try { inner = frame.contentDocument; } catch { inner = null; }
        if (!inner) { unreadFrames.push({ framePath: childPath, reason: 'inaccessible-frame' }); continue; }
        const fx = dx + fr.left + frame.clientLeft, fy = dy + fr.top + frame.clientTop;
        const innerClip = {
          left: Math.max(fx, clip.left), top: Math.max(fy, clip.top),
          right: Math.min(fx + frame.clientWidth, clip.right), bottom: Math.min(fy + frame.clientHeight, clip.bottom),
        };
        // 整帧滚出视口时不要跳过：跳过会让"按钮明明存在却 no-match"。
        // 用退化的 clip（宽高为 0）继续走，元素自然标成 inView=false，由 click() 先滚动再点。
        const collapsed = innerClip.right <= innerClip.left || innerClip.bottom <= innerClip.top;
        const walkClip = collapsed ? { left: fx, top: fy, right: fx, bottom: fy } : innerClip;
        walk(inner, fx, fy, depth + 1, walkClip, [...ancestors, { doc, frame, dx, dy }], childPath);
      }
    };
    walk(document, 0, 0, 0, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, [], '0');
    return { url: document.URL || '', items: out, scannedTotal: out.length, limitReached, elementLimit: limit,
      documents, selectedDocuments, scopeMatches, unreadFrames, busy,
      complete: !limitReached && unreadFrames.length === 0 && selectedDocuments > 0 && scopeMatches > 0,
      coverage: 'same-origin-light-dom', shadowDOM: 'not-traversed' };
  }, [SPECIFIC_SELECTORS, GENERIC_SELECTORS, cap, opts.scope || null,
      GENERIC_MAX_W, GENERIC_MAX_H, GENERIC_MAX_TEXT,
      opts.fieldid ? String(opts.fieldid).replace(/^\||\|$/g, '') : null, opts.framePath || null,
      INLINE_LINKS, CELL, opts.rowText ? opts.rowText.replace(/\s+/g, ' ').trim() : null, ROW_ACTION, BUSY]);
  // Older Page adapters returned only an array, which cannot prove completeness.
  if (Array.isArray(observed)) return { items: observed, scannedTotal: observed.length,
    limitReached: observed.length >= cap, elementLimit: cap, unreadFrames: [],
    complete: observed.length < cap, coverage: 'legacy-array' };
  return observed;
}

/** Compatibility API. Use inspect() when completeness matters. */
export async function collect(page, opts = {}) {
  return (await inspect(page, opts)).items;
}

function matchesFieldid(actual, expected) {
  const key = String(expected).replace(/^\||\|$/g, "");
  return actual === key || actual.endsWith(`|${key}`);
}

/** Merge wrappers only when they resolve to the same hit node in the same frame. */
function dedupeSameHit(items) {
  const out = [];
  const positions = new Map();
  for (const it of items) {
    const key = it.hitKey && `${it.framePath}|${it.hitKey}`;
    const index = key ? positions.get(key) : undefined;
    if (index === undefined) {
      if (key) positions.set(key, out.length);
      out.push(it);
      continue;
    }
    const twin = out[index];
    const better = it.score > twin.score || (it.score === twin.score && (
      (!twin.fieldid && it.fieldid)
      || (Boolean(twin.fieldid) === Boolean(it.fieldid) && (it.w || 0) * (it.h || 0) > (twin.w || 0) * (twin.h || 0))));
    if (better) out[index] = it;
  }
  return out;
}

function entryList(observation, limit) {
  const ranked = dedupeSameHit(observation.items.filter(item => item.entryKind && !item.disabled)
    .map(item => ({ ...item, score: item.entryKind === 'mapping' ? 1 : 0 })))
    .map(item => ({ kind: item.entryKind, name: item.aria || item.title || item.text || item.fieldid,
      framePath: item.framePath, rowText: item.rowText, rowCells: item.rowCells, fieldid: item.fieldid, inView: item.inView }))
    .filter(entry => entry.name)
    .sort((a, b) => Number(b.kind === 'mapping') - Number(a.kind === 'mapping') || Number(!!b.rowText) - Number(!!a.rowText));
  return { entries: ranked.slice(0, limit), truncated: observation.limitReached || ranked.length > limit };
}

async function hoverEntryRow(page, opts) {
  if (typeof opts.rowText !== 'string' || !opts.rowText.trim() || !/^0(?:\/\d+)*$/.test(opts.framePath || '')) {
    throw new TypeError('reveal requires an exact rowText and an observed framePath');
  }
  const target = await page.evaluate(({ path, scope, rowText, cellSelector }) => {
    let doc = document;
    const frames = [];
    for (const i of path.split('/').slice(1)) {
      const frame = doc.querySelectorAll('iframe')[Number(i)];
      if (!frame?.contentDocument) return { ok: false, reason: 'unread-frame' };
      if (frame.getClientRects().length === 0 || Math.abs(frame.getBoundingClientRect().width - frame.offsetWidth) > 1 ||
          Math.abs(frame.getBoundingClientRect().height - frame.offsetHeight) > 1) return {ok:false, reason:'frame-geometry'};
      frames.push(frame);
      doc = frame.contentDocument;
    }
    let roots;
    try { roots = scope ? doc.querySelectorAll(scope) : [doc]; }
    catch { return {ok:false, reason:'invalid-scope'}; }
    if (roots.length !== 1) return {ok:false, reason: roots.length ? 'ambiguous-scope' : 'scope-missing'};
    const rows = new Map();
    for (const cell of roots[0].querySelectorAll(cellSelector)) {
      if (cell.innerText?.replace(/\s+/g,' ').trim() !== rowText || !cell.getClientRects().length) continue;
      const row = cell.closest('tr,[role="row"],.wui-table-row,.u-table-row,.fixedDataTableRowLayout_main');
      if (row && !rows.has(row)) rows.set(row, cell);
    }
    if (rows.size !== 1) return {ok:false, reason:rows.size ? 'ambiguous-row' : 'row-not-rendered'};
    const cell = rows.values().next().value;
    const r = cell.getBoundingClientRect();
    let x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
    if (!cell.contains(doc.elementFromPoint(x, y))) return {ok:false, reason:'row-offscreen-or-covered'};
    for (const frame of frames.reverse()) {
      const fr = frame.getBoundingClientRect();
      x += fr.left + frame.clientLeft;
      y += fr.top + frame.clientTop;
      if (frame.ownerDocument.elementFromPoint(x,y) !== frame) return {ok:false, reason:'frame-offscreen-or-covered'};
    }
    return {ok:true,x,y};
  }, {path:opts.framePath, scope:opts.scope, rowText:opts.rowText.replace(/\s+/g,' ').trim(), cellSelector:CELL});
  if (target.ok) await page.mouse.move(target.x, target.y);
  return target;
}

/** Read possible entrances to the next view, preserving their rendered row and frame. */
export async function entries(page, opts = {}) {
  const limit = opts.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  if (opts.reveal === true) {
    const target = await hoverEntryRow(page, opts);
    if (!target.ok) return {entries: [], complete: false, truncated: false, reason: target.reason};
  }
  const until = Date.now() + (opts.reveal === true ? 700 : 0);
  while (true) {
    const observed = await inspect(page, opts);
    const result = entryList(observed, limit);
    if (result.entries.length || Date.now() >= until || !observed.complete) {
      return { ...result, complete: observed.complete && !result.truncated && !observed.busy,
        ...(observed.busy ? {reason: 'loading'} : {}), unreadFrames: observed.unreadFrames,
        scanned: observed.scannedTotal, scopeMatches: observed.scopeMatches, coverage: observed.coverage };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** 排序并裁剪候选，附带分数。看得见的优先，视口外的排在同分之后。 */
export async function find(page, query, opts = {}) {
  const observation = await inspect(page, opts);
  const all = observation.items;
  const min = opts.min === undefined ? 0.55 : opts.min;
  const ranked = dedupeSameHit(all
    .filter(item => !item.disabled && (!opts.fieldid || matchesFieldid(item.fieldid || "", opts.fieldid)))
    .map(item => ({ ...item, score: opts.fieldid ? 1 : Math.round(score(query, item) * 100) / 100 }))
    .filter(item => item.score >= Math.min(min, 0.2))
    .sort((a, b) => b.score - a.score || Number(b.inView) - Number(a.inView) || a.frame - b.frame));
  const eligible = ranked.filter(item => item.score >= min);
  const best = eligible[0] || null;
  const second = eligible[1];
  const ambiguous = Boolean(best && second && second.score >= best.score - 0.02);
  const strong = Boolean(best && best.score >= STRONG);
  const truncated = observation.limitReached;
  const incomplete = !observation.complete;
  const loading = observation.busy && !strong;
  const reason = truncated ? "scan-limit" : incomplete ? "incomplete" : loading ? "loading" : !best ? "no-match" : ambiguous ? "ambiguous" : strong ? "ok" : "fuzzy";
  return {
    ok: Boolean(best) && !incomplete && !loading, reason, strong, best,
    candidates: ranked.slice(0, Math.max(2, opts.limit || 8)),
    ...(reason !== 'ok' ? { entryPoints: entryList(observation, 8).entries, searchScope: 'current-view',
      next: loading ? 'Wait for the requested data to load, then read the same view again.'
        : 'Inspect ys.entries() in the relevant row/frame; open the observed entry and read the destination.' } : {}),
    scanned: all.length, truncated, complete: observation.complete && !loading,
    coverage: { mode: observation.coverage, documents: observation.documents,
      unreadFrames: observation.unreadFrames, scopeMatches: observation.scopeMatches },
    inView: all.filter(item => item.inView).length,
  };
}

/** 只给清单：先列再选，适合近义词多、名字记不准的情况。 */
export async function list(page, query, opts = {}) {
  const found = await find(page, query, opts);
  return found.candidates;
}

/** 目标在视口外时，把鼠标放到视口内朝目标的方向滚轮，再重新找。 */
async function reveal(page, hit, opts) {
  const steps = opts.revealSteps === undefined ? 4 : opts.revealSteps;
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  let current = hit;
  for (let i = 0; i < steps; i++) {
    if (!current || current.inView) return await find(page, opts.query, opts);
    const down = current.y > size.h / 2;
    const delta = Math.max(200, Math.min(700, Math.abs(current.y - size.h / 2)));
    const at = {
      x: Math.max(20, Math.min(current.x, size.w - 20)),
      y: down ? Math.round(size.h * 0.72) : Math.round(size.h * 0.28),
    };
    try {
      await page.mouse.move(at.x, at.y);
      await page.mouse.wheel(0, down ? delta : -delta);
    } catch {
      return { ok: false, reason: 'scroll-failed', best: null, candidates: [] };
    }
    await new Promise(resolve => setTimeout(resolve, opts.revealWait ?? 350));
    const again = await find(page, opts.query, opts);
    if (!again.ok || again.reason === 'ambiguous') return again;
    current = again.best;
    if (current?.inView) return again;
  }
  return await find(page, opts.query, opts);
}

/**
 * 点一个按钮。顺序：显式 fieldid → 唯一精确文本 → 高分唯一候选。
 * 视口外先滚动；高分候选靠坐标点击（自动带 label），因此能穿透多层 iframe。
 * 找不到、有歧义、滚动后仍不可见时返回 { clicked:false, ... }，不抛错，让 agent 看清单再决定。
 */
export async function click(page, query, opts = {}) {
  const label = opts.label || `点「${query}」`;
  const searchOpts = { ...opts, query };
  let found = await find(page, query, searchOpts);
  if (!found.complete) return { ...found, clicked: false };
  let best = found.best;
  if (found.reason === 'ambiguous' && opts.allowAmbiguous !== true) return { ...found, clicked: false };
  if (best && !best.inView && opts.reveal !== false) {
    found = await reveal(page, best, searchOpts);
    best = found.best;
    if (!found.complete) return { ...found, clicked: false };
  }
  if (!best) {
    return { ...found, clicked: false, reason: found.reason || 'no-match' };
  }
  if (!best.inView) {
    return { clicked: false, reason: "offscreen", best, candidates: found.candidates, scanned: found.scanned };
  }
  if (found.reason === "ambiguous" && opts.allowAmbiguous !== true) {
    return { clicked: false, reason: "ambiguous", best, candidates: found.candidates };
  }
  // 模糊猜测（名字只是包含关系或同义词）默认不点：宁可回清单让调用方确认
  const exact = best.score >= STRONG;
  if (!exact && opts.fuzzy !== true) {
    return { clicked: false, reason: "fuzzy", best, candidates: found.candidates, scanned: found.scanned };
  }
  const what = best.aria || best.title || best.text || best.dataTitle || best.fieldid || best.cls;
  await page.mouse.click(best.x, best.y, {
    label: `${label} · ${what}${best.fieldid ? ` [${best.fieldid.split("|").pop()}]` : ""}${best.frame ? ` iframe${best.frame}` : ""}`,
  });
  return {
    clicked: true, via: "coords", matchedBy: opts.fieldid ? "fieldid" : exact ? "name" : "fuzzy",
    tag: best.tag, best, label,
  };
}

/** 等待可点击的确定候选；本函数不点击。 */
export async function waitFor(page, query, opts = {}) {
  const timeout = opts.timeout || 15000;
  const step = opts.step || 400;
  const until = Date.now() + timeout;
  let last = null;
  while (Date.now() < until) {
    last = await find(page, query, opts);
    if (last.ok && (last.reason !== "ambiguous" || opts.allowAmbiguous === true)
      && (last.strong || opts.fuzzy === true)) return { ...last, waited: timeout - (until - Date.now()) };
    await new Promise(resolve => setTimeout(resolve, step));
  }
  return { ...last, ok: false, timedOut: true };
}

/** 把阶梯挂到 page.ys / globalThis.ys（MCP prelude 里由 ego-memo 调用）。 */
export function attach(page) {
  const api = {
    click: (query, opts) => click(page, query, opts),
    find: (query, opts) => find(page, query, opts),
    list: (query, opts) => list(page, query, opts),
    waitFor: (query, opts) => waitFor(page, query, opts),
    collect: opts => collect(page, opts),
    inspect: opts => inspect(page, opts),
    entries: opts => entries(page, opts),
    score,
  };
  page.ys = Object.assign(page.ys || {}, api);
  globalThis.ys = page.ys;
  return api;
}

export default { VERSION, norm, dice, score, inspect, collect, entries, find, list, click, waitFor, attach };
