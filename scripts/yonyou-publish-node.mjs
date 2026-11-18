// YonBIP「发布为节点」流水线：编辑 → 弹窗里把「能否发布节点」改成「是」→ 更多 → 发布为节点或服务。
//
// 为什么单独写：这条链要穿过 列表页 → 编辑弹窗 → 弹窗里的工具条 → portal 到 body 末尾的下拉菜单，
// 四层各自的坐标系不同。agent 每轮重新打开的弹窗、重新算的坐标，任何一步失败就整条重来，
// 所以「人一步点完的事」在 agent 手里失败率很高。这里把四步固化，每步都回读状态，失败就停在原地。
//
// 用法（ego 脚本里）：
//   const pn = await import('file:///.../browser-ai/scripts/yonyou-publish-node.mjs');
//   const page = task.page("p1");
//   const out = await pn.publishNode(page, { label: "能否发布节点", dryRun: true });
//   console.log(JSON.stringify(out, null, 2));
//
// 第一次用在陌生页面上：先跑 pn.probe(page)，它会列出所有层里像开关/更多/发布菜单的元素，
// 再按实际选择器传 opts.cand 覆盖默认候选。默认候选是按 BIP 通用结构（wui + lebra）预置的。

export const VERSION = "2026-11-11.2";

const CAND = {
  switch: ['[role="switch"]', '.wui-switch', '.wui-switch-btn', '.wui-checkbox', 'input[type="checkbox"]'],
  switchOnHints: ['checked', 'on', 'active', 'wui-switch-on', 'is-checked'],
  more: ['button[fieldid$="|moreButton_btn"]', 'button[fieldid*="moreButton"]', 'button[fieldid$="|Toolbar|moreButton_btn"]'],
  publishItems: ['发布为节点或服务', '发布为节点', '发布为服务'],
  save: ['button[fieldid$="|btnSave"]', '.wui-modal-ok-button'],
  ok: ['.wui-modal-ok-button', '.wui-dialog-ok-button', 'button[fieldid$="|btnOk"]'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 在页面里（含同源 iframe）算出「绝对坐标」：getBoundingClientRect 只给层内坐标，
// 弹窗在 iframe 里时直接拿去 mouse.click 会点空。这里逐层累加父 iframe 的偏移。
// ---------------------------------------------------------------------------
const LOCATE_SRC = `(function (args) {
  const { kind, label, cands, texts } = args;
  const T = (el) => (el ? (el.innerText || el.value || "").trim().replace(/\\s+/g, " ") : "");
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = el.ownerDocument.defaultView.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const absBox = (win, el) => {
    let dx = 0, dy = 0;
    let r = el.getBoundingClientRect();
    dx = r.x; dy = r.y;
    let w = win;
    for (let guard = 0; guard < 6 && w.frameElement; guard++) {
      const fr = w.frameElement.getBoundingClientRect();
      dx += fr.x + (w.frameElement.clientLeft || 0);
      dy += fr.y + (w.frameElement.clientTop || 0);
      w = w.parent;
    }
    return { x: Math.round(dx + r.width / 2), y: Math.round(dy + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const docs = [];
  const walk = (win, depth, url) => {
    try { docs.push({ win, depth, url: url || win.location.href }); } catch (e) {}
    let frames = [];
    try { frames = [...win.document.querySelectorAll("iframe")]; } catch (e) { return; }
    for (const f of frames) {
      let cw = null;
      try { cw = f.contentWindow; } catch (e) { cw = null; }
      if (!cw) continue;
      try { void cw.document.body; } catch (e) { continue; }
      walk(cw, depth + 1, f.src || cw.location.href);
    }
  };
  walk(window, 0, location.href);

  // 开关：先按 label 找到表单项，再在项内找开关体
  if (kind === "switch") {
    for (const d of docs) {
      const doc = d.win.document;
      const items = [...doc.querySelectorAll(".wui-form-item, .wui-form-row, tr, .form-item, [class*=form-item]")];
      for (const it of items) {
        if (label && !T(it).includes(label)) continue;
        for (const sel of cands) {
          const el = it.querySelector(sel);
          if (!el || !visible(el)) continue;
          const box = absBox(d.win, el);
          const cls = (el.className || "") + " " + (el.getAttribute("aria-checked") || "") + " " + (el.checked ? "checked" : "");
          return { found: true, ...box, text: T(it).slice(0, 80), cls: String(cls).toLowerCase(), checked: /checked|true/.test(String(cls).toLowerCase()), depth: d.depth, url: d.url };
        }
      }
    }
    return { found: false, hint: "没找到带该 label 的开关；把 label 换成表单项里的正是写法，或先跑 probe" };
  }

  // 「更多」及下拉菜单项：全层扫描，按文字匹配，取可见且面积最小的那个（菜单项通常很高但很窄）
  if (kind === "menu") {
    const hits = [];
    for (const d of docs) {
      const doc = d.win.document;
      for (const t of texts) {
        const all = [...doc.querySelectorAll("li, a, span, div, .wui-dropdown-menu-item, [role=menuitem]")];
        for (const el of all) {
          if (T(el) !== t) continue;
          if (!visible(el)) continue;
          const box = absBox(d.win, el);
          hits.push({ text: t, ...box, depth: d.depth, tag: el.tagName });
        }
      }
    }
    hits.sort((a, b) => a.w * a.h - b.w * b.h);
    return hits.length ? { found: true, best: hits[0], all: hits.slice(0, 6) } : { found: false };
  }

  // 按钮：按候选选择器
  if (kind === "button") {
    for (const d of docs) {
      const doc = d.win.document;
      for (const sel of cands) {
        for (const el of doc.querySelectorAll(sel)) {
          if (!visible(el)) continue;
          const box = absBox(d.win, el);
          return { found: true, ...box, sel, text: T(el).slice(0, 40), depth: d.depth, url: d.url };
        }
      }
    }
    return { found: false };
  }

  // probe：把每层里像开关 / 更多 / 发布 的元素都列出来
  if (kind === "probe") {
    const out = [];
    for (const d of docs) {
      const doc = d.win.document;
      const modals = doc.querySelectorAll(".wui-modal, .wui-dialog, [class*=modal], [class*=dialog]").length;
      const items = [];
      const push = (el, why) => {
        if (!visible(el)) return;
        const box = absBox(d.win, el);
        if (box.w < 8 || box.h < 8) return;
        items.push({ why, tag: el.tagName, text: T(el).slice(0, 60), cls: String(el.className || "").slice(0, 60), fieldid: el.getAttribute("fieldid") || "", ...box });
      };
      const candsAll = args.candsAll || [];
      for (const sel of candsAll) for (const el of doc.querySelectorAll(sel)) push(el, "switch:" + sel);
      for (const el of doc.querySelectorAll("button")) {
        const f = el.getAttribute("fieldid") || "";
        if (/more|More/.test(f) || /更多/.test(T(el))) push(el, "more");
        if (/btnSave|btnOk/.test(f) || /^(保存|确定|发布)$/.test(T(el))) push(el, "save/ok");
      }
      for (const el of doc.querySelectorAll("li, a, span, .wui-dropdown-menu-item")) {
        const t = T(el);
        if (t === "发布为节点或服务" || t === "发布为服务" || t === "发布为节点") push(el, "publish-item");
      }
      if (items.length || modals) out.push({ depth: d.depth, url: d.url, title: (() => { try { return d.win.document.title; } catch (e) { return ""; } })(), modals, items: items.slice(0, 40) });
    }
    return { layers: out };
  }
  return { found: false };
})`;

async function locate(page, kind, args) {
  return page.evaluate(new Function("return " + LOCATE_SRC)(), { kind, ...args });
}

/**
 * 探测当前页所有层的结构。第一次在陌生页面用，先跑它。
 */
export async function probe(page) {
  const r = await locate(page, "probe", { cands: [], candsAll: CAND.switch });
  return { version: VERSION, at: new Date().toISOString(), url: await page.evaluate(() => location.href), ...r };
}

async function clickAt(page, box, label) {
  await page.mouse.click(box.x, box.y, { label });
}

/**
 * 把「能否发布节点」改成「是」。返回改前/改后状态，改不动就抛错，不留半截状态。
 */
export async function setSwitch(page, opts = {}) {
  const label = opts.label || "能否发布节点";
  const cand = opts.cand || CAND.switch;
  const before = await locate(page, "switch", { label, cands: cand });
  if (!before.found) throw new Error("SWITCH_NOT_FOUND: " + before.hint);
  const isOn = before.checked;
  if (isOn) return { changed: false, already: true, before: before.text, box: before };
  await clickAt(page, before, `把「${label}」改成是`);
  await sleep(400);
  let after = await locate(page, "switch", { label, cands: cand });
  if (!after.found || !after.checked) {
    // 有些开关点文字不生效，要点开关体本身：再试一次，位置微调
    await clickAt(page, after.found ? after : before, `重试「${label}」开关`);
    await sleep(500);
    after = await locate(page, "switch", { label, cands: cand });
  }
  if (!after.found || !after.checked) {
    throw new Error("SWITCH_UNCHANGED: 点了但值没变，可能是只读项、未进入编辑态，或开关体不是这个元素。before=" + JSON.stringify(before));
  }
  return { changed: true, before: before.text, after: after.text, box: after };
}

/**
 * 点「更多」，读下拉菜单，点「发布为节点或服务」。
 */
export async function publishFromMore(page, opts = {}) {
  const texts = opts.items || CAND.publishItems;
  const more = await locate(page, "button", { cands: opts.more || CAND.more });
  if (!more.found) throw new Error("MORE_NOT_FOUND: 当前层没有「更多」按钮，可能不在编辑弹窗里");
  await clickAt(page, more, "打开「更多」菜单");
  await sleep(500);

  let hit = null;
  for (let i = 0; i < 8; i++) {
    const m = await locate(page, "menu", { texts });
    if (m.found) { hit = m.best; break; }
    await sleep(250);
  }
  if (!hit) throw new Error("PUBLISH_ITEM_NOT_FOUND: 菜单里没有 '发布为节点或服务'；菜单可能未展开或被遮罩挡住");
  await clickAt(page, hit, `选择「${hit.text}」`);
  await sleep(800);
  return { openedMoreAt: [more.x, more.y], clicked: hit.text, at: [hit.x, hit.y] };
}

/** Capture visible notices, including same-origin frames; body text is not an acknowledgment. */
export async function capturePublicationEvidence(page, opts = {}) {
  return page.evaluate((selector) => {
    const notices = [];
    const walk = (win, frame) => {
      let doc;
      try { doc = win.document; } catch { return; }
      for (const el of doc.querySelectorAll(selector)) {
        const r = el.getBoundingClientRect(), style = win.getComputedStyle(el);
        if (!r.width || !r.height || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const text = (el.innerText || "").trim();
        if (text) notices.push({ text, frame });
      }
      for (const [index, el] of [...doc.querySelectorAll("iframe")].entries()) {
        const r = el.getBoundingClientRect(), style = win.getComputedStyle(el);
        if (!r.width || !r.height || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        try { if (el.contentDocument) walk(el.contentWindow, `${frame}.${index}`); } catch { /* Cross-origin frames need their own observation. */ }
      }
    };
    walk(window, "top");
    return notices;
  }, opts.noticeSelector || '[role="alert"], [class*="toast"], .wui-message-notice, .wui-notification-notice');
}

/** A new UI acknowledgment is a hint; success requires identified persisted-state evidence. */
export function assessPublication({ before = [], after = [], verification = null, expectedRecordId = null } = {}) {
  const text = notice => typeof notice === "string" ? notice.trim() : String(notice?.text || "").trim();
  const previous = new Set(before.map(text));
  const newNotices = [...new Set(after.map(text).filter(value => value && !previous.has(value)))];
  const toastBad = newNotices.some(value => /失败|错误|不能发布|不允许|\b(?:error|failed|failure|not allowed)\b/i.test(value));
  const toastOk = newNotices.some(value => /发布成功|已成功发布|发布(?:节点|服务)成功|\bpublished successfully\b/i.test(value));
  const evidence = verification?.evidence;
  const hasEvidence = typeof evidence === "string" ? Boolean(evidence.trim())
    : evidence && typeof evidence === "object" && Object.keys(evidence).length > 0;
  const identified = verification && typeof verification.recordId === "string" && verification.recordId.trim()
    && (expectedRecordId === null || verification.recordId === expectedRecordId) && hasEvidence;
  let outcome = "unknown", reason = toastOk ? "PUBLICATION_ACKNOWLEDGED_UNVERIFIED" : "PUBLICATION_UNVERIFIED";
  if (toastBad) { outcome = "failed"; reason = "PUBLICATION_FAILURE_NOTICE"; }
  else if (identified && verification.published === true) { outcome = "succeeded"; reason = "PUBLICATION_VERIFIED"; }
  else if (identified && verification.published === false) { outcome = "failed"; reason = "PUBLICATION_NOT_PERSISTED"; }
  return { ok: outcome === "succeeded", outcome, reason, toastOk, toastBad, newNotices, verification };
}

/**
 * 完整流水线。dryRun 只定位不点击。
 */
export async function publishNode(page, opts = {}) {
  const log = [];
  const label = opts.label || "能否发布节点";
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      log.push({ step: name, ok: r?.ok !== false, ms: Date.now() - t0, detail: r });
      return r;
    } catch (e) {
      log.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
      throw e;
    }
  };

  const sw = await locate(page, "switch", { label, cands: opts.cand || CAND.switch });
  const more = await locate(page, "button", { cands: opts.more || CAND.more });
  const out = {
    version: VERSION,
    at: new Date().toISOString(),
    precheck: { switch: sw.found ? { text: sw.text, on: sw.checked, at: [sw.x, sw.y] } : null, more: more.found ? { at: [more.x, more.y] } : null },
    log,
  };
  if (!sw.found || !more.found) {
    out.ok = false;
    out.outcome = "not_attempted";
    out.reason = "NOT_IN_EDIT_MODAL: 先打开要发布的记录的编辑弹窗，再跑本函数（需要同时看到开关与「更多」）";
    return out;
  }
  if (opts.dryRun) return { ...out, ok: true, dryRun: true, outcome: "not_attempted" };

  const before = await capturePublicationEvidence(page, opts);
  if (!sw.checked) await step("set-switch", () => setSwitch(page, opts));
  await step("open-more-and-pick", () => publishFromMore(page, opts));
  if (opts.confirm !== false) {
    await step("confirm", async () => {
      const ok = await locate(page, "button", { cands: opts.ok || CAND.ok });
      if (!ok.found) return { skipped: "no confirm dialog" };
      await clickAt(page, ok, "确认发布");
      await sleep(800);
      return { at: [ok.x, ok.y] };
    });
  }
  const assessment = await step("verify", async () => {
    const after = await capturePublicationEvidence(page, opts);
    const verification = typeof opts.verify === "function" ? await opts.verify(page) : null;
    return assessPublication({ before, after, verification, expectedRecordId: opts.recordId ?? null });
  });
  return { ...out, ...assessment };
}

export const REFERENCE = { CAND };
