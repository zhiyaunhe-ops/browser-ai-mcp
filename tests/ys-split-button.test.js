"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

let pagePromise;
const pageReader = () => pagePromise ??= import("../scripts/ys-page.mjs");
let locatorPromise;
const locator = () => locatorPromise ??= import("../scripts/ys-locate.mjs");

function splitDom({ adjacent = true, legacy = false } = {}) {
  const queried = [];
  const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  const box = (left, width = 50) => ({ left, top: 10, width, height: 24, right: left + width, bottom: 34 });
  const make = (tag, attrs = {}, text = "", rect = box(10)) => {
    const node = {
    tagName: tag.toUpperCase(), ownerDocument: null, className: attrs.class || "", innerText: text,
    textContent: text, getBoundingClientRect: () => rect,
    getAttribute: name => attrs[name] ?? null,
    matches: selector => selector.split(",").map(s => s.trim()).some(s => {
      if (s === "button") return tag.toLowerCase() === "button";
      if (s === "button.btn-right") return tag.toLowerCase() === "button" && attrs.class === "btn-right";
      if (s === "button.divider-main-button" || s === ".hover-divider-btn-left-wrapper button.divider-main-button")
        return tag.toLowerCase() === "button" && attrs.class === "divider-main-button";
      if (s === "[fieldid]") return attrs.fieldid !== undefined;
      if (s === "[data-fieldid]") return attrs["data-fieldid"] !== undefined;
      return s === `.${attrs.class}`;
    }),
    closest: selector => selector === ".divider-button-wrapper" ? (node.group || null) : null,
    contains: other => other === node,
    querySelector: () => null,
    querySelectorAll: selector => { queried.push([node.className, selector]); return nodeQuery(node, selector); },
    };
    return node;
  };
  function nodeQuery(node, selector) {
    const descendants = node.children || [];
    const choices = selector.split(",").map(s => s.trim());
    return descendants.filter(child => choices.some(s => {
      if (s === ".divider-button-wrapper") return child.className === "divider-button-wrapper";
      if (s === ".hover-divider-btn-left-wrapper button.divider-main-button") return child.className === "divider-main-button";
      if (s === "button.divider-main-button") return child.className === "divider-main-button";
      if (s === "button.btn-right") return child.className === "btn-right";
      if (s === "[fieldid]" || s === "[data-fieldid]") return child.getAttribute(s.slice(1, -1)) != null;
      if (s === "[class*=\"wui-\"]" || s === "[class*=\"lebra-\"]" || s === "[class*=\"mdf-\"]") return false;
      return false;
    }));
  }
  const group = make("div", { class: "divider-button-wrapper", fieldid: "toolbar|btnAssign" });
  const primary = make("button", { class: "divider-main-button", fieldid: "toolbar|btnAssign", "aria-label": "分配", "btn-code": "assign" }, "分配", box(10, 70));
  const arrow = make("button", { class: "btn-right", "aria-expanded": "false" }, "", box(80, 22));
  const ordinary = make("button", { fieldid: "toolbar|btnCancel" }, "取消", box(110, 50));
  group.children = [primary, arrow]; group.group = group;
  primary.group = group; arrow.group = group; ordinary.group = null;
  const doc = {
    URL: "https://example.test/assign", title: "Assign", defaultView: view,
    querySelectorAll(selector) {
      queried.push(["doc", selector]);
      if (selector === "iframe") return [];
      if (selector.includes(".divider-button-wrapper")) return legacy ? [ordinary] : adjacent ? [group, primary, ordinary] : [group, primary];
      if (selector.includes("[fieldid]") || selector.includes("[data-fieldid]")) return adjacent ? [group, primary, ordinary] : [group, primary];
      if (selector.includes("[class*=\"wui-\"]")) return [];
      return [];
    },
    querySelector: () => null,
  };
  for (const node of [group, primary, arrow, ordinary]) node.ownerDocument = doc;
  const page = { async evaluate(fn, config) {
    const keys = ["document", "location", "innerWidth", "innerHeight", "CSS"];
    const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
    globalThis.document = doc;
    globalThis.location = { href: doc.URL, pathname: "/assign", hash: "", hostname: "example.test" };
    globalThis.innerWidth = 800; globalThis.innerHeight = 600; globalThis.CSS = { escape: value => value };
    try { return fn(config); } finally {
      for (const key of keys) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key]; }
    }
  } };
  page.__doc = doc;
  return { page, queried };
}

function observedItem(name, part, extra = {}) {
  const group = { part, name: "分配", buttonCode: "assign", fieldid: "toolbar|btnAssign" };
  return { tag: "button", text: name, aria: "", title: "", value: "", fieldid: group.fieldid,
    cls: part === "menu" ? "btn-right" : "divider-main-button", role: "", disabled: false,
    frame: 0, framePath: "0", hitKey: null, inView: true, x: part === "menu" ? 91 : 45, y: 22,
    splitButton: group, ...extra };
}
function fakePage(observation) {
  const calls = { clicks: [], args: [] };
  return { calls,
    async evaluate(_fn, args) {
      calls.args.push(args);
      if (typeof observation === "function") return observation(args);
      const part = args[15], buttonCode = args[16];
      const items = observation.items.filter(item => (!part || (part === "menuitem" ? item.role === "menuitem" : item.splitButton?.part === part)) &&
        (!buttonCode || item.splitButton?.buttonCode === buttonCode));
      return { ...observation, items };
    },
    mouse: { async click(x, y) { calls.clicks.push([x, y]); } },
    async waitForTimeout() {},
  };
}

function menuDomPage(groups) {
  const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", cursor: "default" }) };
  const doc = { URL: "https://example.test/current", defaultView: view, title: "Current menu",
    querySelectorAll(selector) {
      if (selector === "iframe") return [];
      if (selector.includes(".wui-menu-item") || selector.includes('[role="menuitem"]')) return groups.flatMap(group => group.items);
      return [];
    },
    elementFromPoint(x, y) { return groups.flatMap(group => group.items).find(item => {
      const r = item.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }) || null; },
  };
  const popupRoots = [];
  const menus = groups.map((group, groupIndex) => {
    const menu = { ownerDocument: doc, getAttribute: name => name === "role" ? "menu" : null,
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 180, height: 32, right: 190, bottom: 42 }),
      closest: selector => selector.includes("[hidden]") && group.hidden ? menu : null,
      checkVisibility: () => !group.hidden,
      querySelectorAll: () => group.items };
    popupRoots.push(menu);
    return group.items.map((data, itemIndex) => {
      const rect = { left: 20 + itemIndex * 100, top: 14, width: 90, height: 24, right: 110 + itemIndex * 100, bottom: 38 };
      const item = { tagName: "DIV", ownerDocument: doc, className: "wui-menu-item", innerText: data.name,
        textContent: data.name, disabled: data.disabled === true,
        getAttribute: name => ({ role: "menuitem", "aria-disabled": data.disabled ? "true" : null, "aria-label": null }[name] ?? null),
        getBoundingClientRect: () => rect, checkVisibility: () => !group.hidden,
        matches: selector => selector.split(",").map(value => value.trim()).some(value => value === ".wui-menu-item" || value === '[role="menuitem"]' || value === "[role=menuitem]" || value === ":disabled" && data.disabled || value === "[aria-disabled=\"true\"]" && data.disabled),
        closest: selector => selector === ".wui-dropdown" || selector === '[role="menu"]' ? menu : selector.includes("[hidden]") && group.hidden ? menu : null,
        contains: other => other === item,
      };
      return item;
    });
  });
  menus.forEach((items, i) => { groups[i].items = items; });
  const all = groups.flatMap(group => group.items);
  doc.querySelectorAll = selector => selector === "iframe" ? [] : selector.includes(".wui-dropdown") ? popupRoots : selector.includes(".wui-menu-item") || selector.includes('[role="menuitem"]') ? all : [];
  doc.elementFromPoint = (x, y) => all.find(item => { const r = item.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
  const page = { calls: [], async evaluate(fn, args) {
    const keys = ["document", "innerWidth", "innerHeight", "CSS"];
    const old = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
    globalThis.document = doc; globalThis.innerWidth = 800; globalThis.innerHeight = 600; globalThis.CSS = { escape: value => value };
    try { return fn(args); } finally { for (const key of keys) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; } }
  }, mouse: { async click(x, y) { page.calls.push([x, y]); } }, async waitForTimeout() {} };
  page.__doc = doc;
  return page;
}

// Saved Yonyou toolbar shape: .divider-button-wrapper >
// .hover-divider-btn-left-wrapper button.divider-main-button + button.btn-right,
// with menu actions rendered in a sibling .wui-dropdown popup.
function splitPopupPage({ existing = false, replaceOnOpen = false, disabled = false } = {}) {
  const base = splitDom();
  const { page: splitPage } = base;
  // splitDom's document is scoped inside its evaluate callback, so augment
  // its DOM through a wrapper around evaluate and expose popup-aware behavior.
  const state = { opened: existing, popup: null, arrows: 0 };
  const makePopup = () => {
    const id = `popup-${Math.random()}`;
    const item = { name: "取消分配", disabled };
    const popupPage = menuDomPage([{ hidden: false, items: [item] }]);
    // The WUI popup is rendered in the toolbar's document. Keep its root
    // identity in that document so the locator's WeakMap popup IDs persist
    // across replacement of the actual popup node.
    for (const node of popupPage.__doc.querySelectorAll('.wui-dropdown')) node.ownerDocument = splitPage.__doc;
    for (const node of [...popupPage.__doc.querySelectorAll('.wui-dropdown'),
                        ...popupPage.__doc.querySelectorAll('.wui-menu-item,[role="menuitem"]')]) {
      const bounds = node.getBoundingClientRect.bind(node);
      node.getBoundingClientRect = () => { const rect = bounds(); return { ...rect, top: rect.top + 40, bottom: rect.bottom + 40 }; };
    }
    return { id, page: popupPage };
  };
  if (existing) state.popup = makePopup();
  const wrapped = {
    async evaluate(fn, args) {
      return splitPage.evaluate((config) => {
        const doc = globalThis.document;
        const popup = state.opened ? state.popup : null;
        const currentItems = popup?.page.__doc.querySelectorAll('.wui-menu-item,[role="menuitem"]') || [];
        for (const node of currentItems) node.ownerDocument = doc;
        doc.elementFromPoint = (px, py) => currentItems.find(item => { const r = item.getBoundingClientRect(); return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom; })
          || [splitPage.__doc.querySelectorAll(".divider-button-wrapper")[0]?.children || []].flat().find(node => {
            const r = node.getBoundingClientRect(); return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
          }) || null;
        const original = doc.__splitOriginalQuery || (doc.__splitOriginalQuery = doc.querySelectorAll.bind(doc));
        doc.querySelectorAll = selector => {
          const found = original(selector);
          if (selector === "iframe") return found;
          if (selector.includes(".btn-right")) return [...new Set([...found, ...original(".divider-button-wrapper").flatMap(g => g.children || []).filter(n => n.className === "btn-right")])];
          if (popup && (selector.includes(".wui-dropdown") || selector.includes(".wui-menu-item") || selector.includes('[role="menuitem"]'))) {
            const extra = popup.page.__doc.querySelectorAll(selector);
            for (const node of extra) node.ownerDocument = doc;
            return [...found, ...extra];
          }
          return found;
        };
        return fn(config);
      }, args);
    },
    mouse: { async click(x, y) {
      state.arrows++;
      if (replaceOnOpen && state.popup) state.popup = makePopup();
      else if (!state.opened) state.popup = makePopup();
      state.opened = true;
      const doc = splitPage.__doc;
      if (doc && state.popup) {
        const items = state.popup.page.__doc.querySelectorAll('.wui-menu-item,[role="menuitem"]');
        doc.elementFromPoint = (px, py) => items.find(item => { const r = item.getBoundingClientRect(); return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom; }) || null;
      }
      wrapped.calls.push([x, y]);
    } },
    calls: [], state, makePopup,
    async waitForTimeout() {},
  };
  // The popup reader is isolated normally; expose its document so the split
  // fixture can merge its WUI dropdown into the same observed document.
  return wrapped;
}

test("toolbar exposes one split group and leaves the adjacent ordinary button separate", async () => {
  const { context } = await pageReader();
  const { page, queried } = splitDom();
  const state = await context(page, { parts: ["toolbar"] });
  assert.equal(state.toolbar.filter(item => item.kind === "split-button").length, 1, `${JSON.stringify(state.toolbar)} queries=${JSON.stringify(queried)}`);
  const split = state.toolbar.find(item => item.kind === "split-button");
  assert.equal(split.name, "分配");
  assert.equal(split.buttonCode, "assign");
  assert.deepEqual(split.parts, { primary: { fieldid: "toolbar|btnAssign", disabled: false }, menu: { disabled: false, expanded: false } });
  assert.equal(state.toolbar.some(item => item.fieldid === "toolbar|btnCancel"), true, JSON.stringify(state.toolbar));
});

test("legacy toolbar records keep their previous shape", async () => {
  const { context } = await pageReader();
  const { page } = splitDom({ legacy: true });
  const state = await context(page, { parts: ["toolbar"] });
  assert.deepEqual(state.toolbar.map(item => Object.keys(item).sort()), [["disabled", "fieldid", "framePath", "key", "name"]]);
  assert.equal(state.toolbar[0].fieldid, "toolbar|btnCancel");
});

test("default click remains the primary entrance while explicit menu click selects only the arrow", async () => {
  const { click } = await locator();
  const primaryPage = fakePage({ items: [observedItem("分配", "primary")], complete: true, activeMenus: 0 });
  const primary = await click(primaryPage, "分配");
  assert.equal(primary.clicked, true);
  assert.deepEqual(primaryPage.calls.clicks, [[45, 22]]);

  const menuPage = fakePage({ items: [observedItem("分配", "primary"), observedItem("", "menu")], complete: true, activeMenus: 0 });
  const menu = await click(menuPage, "分配", { part: "menu", buttonCode: "assign" });
  assert.equal(menu.clicked, true);
  assert.deepEqual(menuPage.calls.clicks, [[91, 22]]);
});

test("closed menus yield no menu items; open menus are read from the current view", async () => {
  const { find } = await locator();
  const closed = await find(fakePage({ items: [], complete: true, activeMenus: 0 }), "取消分配", { part: "menuitem" });
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "no-match");
  const openedPage = fakePage({ items: [{ ...observedItem("取消分配", "primary"), role: "menuitem", splitButton: undefined }], complete: true, activeMenus: 1 });
  const opened = await find(openedPage, "取消分配", { part: "menuitem", framePath: "0" });
  assert.equal(opened.ok, true);
  assert.equal(opened.best.text, "取消分配");
  assert.equal(openedPage.calls.args[0][15], "menuitem");
});

test("actual synthetic DOM ignores hidden popup content and clicks the currently rendered item", async () => {
  const { click, find } = await locator();
  const hidden = menuDomPage([{ hidden: true, items: [{ name: "取消分配" }] }]);
  const absent = await find(hidden, "取消分配", { part: "menuitem" });
  assert.equal(absent.reason, "no-match");
  assert.deepEqual(hidden.calls, []);

  const current = menuDomPage([{ hidden: false, items: [{ name: "取消分配" }, { name: "查看详情" }] }]);
  const selected = await click(current, "取消分配", { part: "menuitem" });
  assert.equal(selected.clicked, true, JSON.stringify(selected));
  assert.deepEqual(current.calls, [[65, 26]]);
});

test("openSplitMenu activates one arrow and scopes the follow-up click to its popup instance", async () => {
  const { openSplitMenu, click } = await locator();
  const page = splitPopupPage();
  const opened = await openSplitMenu(page, "分配", "取消分配", { framePath: "0", buttonCode: "assign" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(page.state.arrows, 1, "only the split arrow should be activated");
  const selected = await click(page, "取消分配", opened.menu);
  assert.equal(selected.clicked, true, JSON.stringify(selected));
  assert.deepEqual(page.calls, [[91, 22], [65, 66]]);
});

test("openSplitMenu rejects a preexisting or duplicate popup without clicking", async () => {
  const { openSplitMenu } = await locator();
  const existing = splitPopupPage({ existing: true });
  const alreadyOpen = await openSplitMenu(existing, "分配", "取消分配", { framePath: "0", buttonCode: "assign" });
  assert.equal(alreadyOpen.reason, "menu-already-visible");
  assert.equal(existing.state.arrows, 0);
  assert.deepEqual(existing.calls, []);

  const duplicate = splitPopupPage({ existing: true });
  const baseEvaluate = duplicate.evaluate.bind(duplicate);
  duplicate.evaluate = async (fn, args) => {
    const result = await baseEvaluate(fn, args);
    if (args?.[17] === true && result.activeMenus === 1) result.activeMenus = 2;
    return result;
  };
  const multiple = await openSplitMenu(duplicate, "分配", "取消分配", { framePath: "0", buttonCode: "assign" });
  assert.equal(multiple.ok, false);
  assert.equal(multiple.reason, "menu-already-visible");
  assert.equal(duplicate.state.arrows, 0);
  assert.deepEqual(duplicate.calls, []);
});

test("replaced popup and disabled menu item cannot receive a click", async () => {
  const { openSplitMenu, click } = await locator();
  const replaced = splitPopupPage();
  const opened = await openSplitMenu(replaced, "分配", "取消分配", { framePath: "0", buttonCode: "assign" });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  replaced.state.popup = replaced.makePopup();
  const staleClick = await click(replaced, "取消分配", opened.menu);
  assert.equal(staleClick.clicked, false);
  assert.equal(staleClick.reason, "popup-changed");
  assert.deepEqual(replaced.calls, [[91, 22]]);

  const disabled = splitPopupPage({ disabled: true });
  const disabledOpen = await openSplitMenu(disabled, "分配", "取消分配", { framePath: "0", buttonCode: "assign" });
  assert.equal(disabledOpen.ok, false);
  assert.equal(disabled.state.arrows, 1);
  assert.deepEqual(disabled.calls, [[91, 22]], "the disabled target must never be clicked");
});

test("same-name, disabled and multiple active menu candidates are never clicked", async () => {
  const { click } = await locator();
  const duplicates = fakePage({ items: [observedItem("分配", "menu"), observedItem("分配", "menu", { x: 110 })], complete: true, activeMenus: 0 });
  const ambiguous = await click(duplicates, "分配", { part: "menu" });
  assert.equal(ambiguous.clicked, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.deepEqual(duplicates.calls.clicks, []);

  const disabled = fakePage({ items: [observedItem("分配", "menu", { disabled: true })], complete: true, activeMenus: 0 });
  const unavailable = await click(disabled, "分配", { part: "menu" });
  assert.equal(unavailable.clicked, false);
  assert.deepEqual(disabled.calls.clicks, []);

  const disabledTwin = fakePage({ items: [observedItem("分配", "menu"), observedItem("分配", "menu", { disabled: true, x: 110 })], complete: true, activeMenus: 0 });
  const twinResult = await click(disabledTwin, "分配", { part: "menu" });
  assert.equal(twinResult.clicked, false, "a disabled exact-name twin still makes the target ambiguous");
  assert.equal(twinResult.reason, "ambiguous");
  assert.deepEqual(disabledTwin.calls.clicks, []);

  const twoMenus = fakePage({ items: [{ ...observedItem("取消分配", "primary"), role: "menuitem", splitButton: undefined }], complete: true, activeMenus: 2 });
  const multi = await click(twoMenus, "取消分配", { part: "menuitem" });
  assert.equal(multi.clicked, false);
  assert.equal(multi.reason, "ambiguous-menu");
  assert.deepEqual(twoMenus.calls.clicks, []);
});

test("transparent copies sharing one hit are deduplicated without merging distinct controls", async () => {
  const { find } = await locator();
  const copies = fakePage({ items: [
    observedItem("分配", "primary", { hitKey: "0:1", w: 70, h: 24 }),
    observedItem("分配", "primary", { hitKey: "0:1", w: 70, h: 24, fieldid: "" }),
    observedItem("", "menu", { hitKey: "0:2", x: 91, w: 22, h: 24 }),
    { ...observedItem("保存", "primary", { hitKey: "0:3", x: 140, w: 35, h: 24 }), splitButton: undefined, fieldid: "page|btnSave" },
  ], complete: true, activeMenus: 0 });
  const found = await find(copies, "分配", { part: "primary" });
  assert.equal(found.candidates.length, 1);
  assert.equal(found.best.hitKey, "0:1");
  assert.equal(found.best.fieldid, "toolbar|btnAssign");
});

test("similar-sized ordinary controls with different hit keys remain separate candidates", async () => {
  const { find } = await locator();
  const page = fakePage({ items: [
    { ...observedItem("保存", "primary", { hitKey: "0:4", x: 130, w: 40, h: 24 }), splitButton: undefined, fieldid: "page|btnSave" },
    { ...observedItem("保存", "primary", { hitKey: "0:5", x: 180, w: 40, h: 24 }), splitButton: undefined, fieldid: "dialog|btnSave" },
  ], complete: true, activeMenus: 0 });
  const found = await find(page, "保存");
  assert.equal(found.reason, "ambiguous");
  assert.equal(found.candidates.length, 2, "similar dimensions alone must not collapse independent controls");
});
