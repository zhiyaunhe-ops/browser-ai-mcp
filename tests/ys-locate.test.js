"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

let locatorPromise;
function locator() {
  locatorPromise ??= import("../scripts/ys-locate.mjs");
  return locatorPromise;
}

function candidate(name, extra = {}) {
  return {
    tag: "button",
    name,
    aria: "",
    title: "",
    value: "",
    fieldid: "",
    cls: "",
    disabled: false,
    frame: 0,
    framePath: "0",
    hitKey: null,
    inView: true,
    x: 80,
    y: 40,
    ...extra,
  };
}

function fakePage(candidates) {
  const calls = { coordinates: [], selectors: [], evaluations: 0 };
  return {
    calls,
    async evaluate(_fn, args) {
      calls.evaluations++;
      calls.lastEvaluateArgs = args;
      return candidates;
    },
    mouse: {
      async click(x, y, options) { calls.coordinates.push({ x, y, options }); },
    },
    async click(selector, options) { calls.selectors.push({ selector, options }); },
    async waitForTimeout() {},
  };
}

test("locator accepts exact normalized accessible names and values", async () => {
  const { click } = await locator();
  for (const item of [
    candidate(" 保存 "),
    candidate("", { aria: "保存" }),
    candidate("", { title: "保存" }),
    candidate("", { value: "保存" }),
  ]) {
    const page = fakePage([item]);
    const result = await click(page, "保存");
    assert.equal(result.clicked, true, JSON.stringify(result));
    assert.equal(page.calls.coordinates.length, 1);
  }
});

test("prefix, substring, and alias matches require explicit fuzzy opt-in", async () => {
  const { click } = await locator();
  for (const [query, label] of [
    ["保存", "保存并提交"],
    ["保存", "保存设置"],
    ["确定", "确认"],
  ]) {
    const page = fakePage([candidate(label)]);
    const result = await click(page, query);
    assert.equal(result.clicked, false, `${query} must not default-click ${label}`);
    assert.equal(page.calls.coordinates.length, 0);

    const optedIn = fakePage([candidate(label)]);
    const optedResult = await click(optedIn, query, { fuzzy: true });
    assert.equal(optedResult.clicked, true, `${query} with fuzzy opt-in should click ${label}`);
  }
});

test("unrelated and implicit fieldids never promote fuzzy matches", async () => {
  const { click } = await locator();
  for (const fieldid of ["", "other|foo"]) {
    const page = fakePage([candidate("确认", { fieldid })]);
    const result = await click(page, "确定");
    assert.equal(result.clicked, false);
    assert.equal(page.calls.coordinates.length, 0);
    assert.equal(page.calls.selectors.length, 0);
  }
});

test("only an explicitly matching fieldid selects its candidate", async () => {
  const { click } = await locator();
  const page = fakePage([
    candidate("确认", { fieldid: "dialog|btnConfirm", frame: 2, x: 321, y: 222 }),
    candidate("确认", { fieldid: "dialog|other", x: 100, y: 100 }),
  ]);
  const result = await click(page, "确定", { fieldid: "btnConfirm" });
  assert.equal(result.clicked, true);
  assert.equal(result.matchedBy, "fieldid");
  assert.deepEqual(page.calls.coordinates.map(({ x, y }) => [x, y]), [[321, 222]]);
  assert.equal(page.calls.selectors.length, 0, "fieldid path must not bypass observation with page.click");
});

test("equal-score candidates, including identical names, are ambiguous", async () => {
  const { click } = await locator();
  for (const [names, options] of [
    [["保存", "保存"], {}],
    [["保存并提交", "提交保存"], { fuzzy: true }],
  ]) {
    const page = fakePage(names.map((name, index) => candidate(name, { x: 80 + index * 40 })));
    const result = await click(page, "保存", options);
    assert.equal(result.clicked, false);
    assert.equal(result.reason, "ambiguous");
    assert.equal(page.calls.coordinates.length, 0);
  }

  const explicitlyAllowed = fakePage([candidate("保存"), candidate("保存", { x: 120 })]);
  const result = await click(explicitlyAllowed, "保存", { allowAmbiguous: true });
  assert.equal(result.clicked, true);
  assert.equal(explicitlyAllowed.calls.coordinates.length, 1);
});

test("limit cannot hide ambiguity from click", async () => {
  const { click } = await locator();
  const page = fakePage([candidate("保存"), candidate("保存", { x: 120 })]);
  const result = await click(page, "保存", { limit: 1 });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, "ambiguous");
  assert.equal(page.calls.coordinates.length, 0);
});

test("disabled candidates are excluded rather than clicked", async () => {
  const { click, find } = await locator();
  const page = fakePage([
    candidate("保存", { disabled: true }),
    candidate("保存并提交", { x: 160 }),
  ]);
  const found = await find(page, "保存");
  assert.notEqual(found.best?.name, "保存");
  const result = await click(page, "保存");
  assert.equal(result.clicked, false, "remaining prefix candidate needs fuzzy opt-in");
  assert.equal(page.calls.coordinates.length, 0);
});

test("waitFor returns a clear timeout result when no candidate appears", async () => {
  const { waitFor } = await locator();
  const page = fakePage([]);
  const result = await waitFor(page, "保存", { timeout: 1, step: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test("same-origin nested iframe candidates keep top-level click coordinates", async () => {
  const { click } = await locator();
  const makeDocument = (targets = [], frames = []) => {
    const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
    return {
      defaultView: view,
      querySelectorAll(selector) {
        if (selector === "iframe") return frames;
        return targets;
      },
      elementFromPoint() { return frames[0] || targets[0] || null; },
    };
  };
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const target = {
    tagName: "BUTTON",
    innerText: "保存",
    value: "",
    className: "",
    disabled: false,
    ownerDocument: null,
    getAttribute: () => "",
    matches: () => false,
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => box(5, 6, 20, 10),
  };
  const leafDoc = makeDocument([target]);
  target.ownerDocument = leafDoc;
  const innerFrame = { contentDocument: leafDoc, clientLeft: 3, clientTop: 4, clientWidth: 100, clientHeight: 80, getBoundingClientRect: () => box(30, 40, 100, 80) };
  const middleDoc = makeDocument([], [innerFrame]);
  const outerFrame = { contentDocument: middleDoc, clientLeft: 2, clientTop: 2, clientWidth: 200, clientHeight: 160, getBoundingClientRect: () => box(10, 20, 200, 160) };
  innerFrame.ownerDocument = middleDoc;
  outerFrame.ownerDocument = null;
  const topDoc = makeDocument([], [outerFrame]);
  outerFrame.ownerDocument = topDoc;
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  const priorInnerWidth = globalThis.innerWidth;
  const priorInnerHeight = globalThis.innerHeight;
  globalThis.document = topDoc;
  globalThis.location = { href: "https://fixture.test/", hostname: "fixture.test", pathname: "/", hash: "" };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 800;
  try {
    const calls = [];
    const page = {
      async evaluate(fn, args) { return fn(args); },
      mouse: { async click(x, y, options) { calls.push({ x, y, options }); } },
      async click() { assert.fail("nested frame click should use top-level coordinates"); },
    };
    const result = await click(page, "保存");
    assert.equal(result.clicked, true);
    assert.deepEqual(calls.map(({ x, y }) => [x, y]), [[60, 77]]);
    assert.equal(result.best.frame, 2);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorLocation === undefined) delete globalThis.location;
    else globalThis.location = priorLocation;
    if (priorInnerWidth === undefined) delete globalThis.innerWidth;
    else globalThis.innerWidth = priorInnerWidth;
    if (priorInnerHeight === undefined) delete globalThis.innerHeight;
    else globalThis.innerHeight = priorInnerHeight;
  }
});

test("scope selector restricts candidates to its matching subtree", async () => {
  const { click } = await locator();
  const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  const box = (left) => ({ left, top: 10, width: 20, height: 10, right: left + 20, bottom: 20 });
  const makeButton = (left, fieldid) => ({
    tagName: "BUTTON", innerText: "保存", value: "", className: "", disabled: false,
    fieldid, ownerDocument: null, getAttribute(name) { return name === "fieldid" ? fieldid : ""; },
    matches: () => false, closest: () => null, contains: () => false,
    getBoundingClientRect: () => box(left),
  });
  const outside = makeButton(20, "outside");
  const inside = makeButton(100, "dialog|inside");
  const root = { querySelectorAll: () => [inside] };
  const doc = {
    defaultView: view,
    querySelectorAll(selector) {
      if (selector === "iframe") return [];
      return selector === "#dialog" ? [root] : [outside, inside];
    },
    elementFromPoint(x) { return x < 60 ? outside : inside; },
  };
  outside.ownerDocument = inside.ownerDocument = doc;
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  const priorInnerWidth = globalThis.innerWidth;
  const priorInnerHeight = globalThis.innerHeight;
  globalThis.document = doc;
  globalThis.location = { href: "https://fixture.test/", hostname: "fixture.test", pathname: "/", hash: "" };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 800;
  try {
    const calls = [];
    const page = {
      async evaluate(fn, args) { return fn(args); },
      mouse: { async click(x, y) { calls.push([x, y]); } },
    };
    const result = await click(page, "保存", { scope: "#dialog" });
    assert.equal(result.clicked, true, JSON.stringify(result));
    assert.equal(result.best.fieldid, "dialog|inside");
    assert.deepEqual(calls, [[110, 15]]);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorLocation === undefined) delete globalThis.location;
    else globalThis.location = priorLocation;
    if (priorInnerWidth === undefined) delete globalThis.innerWidth;
    else globalThis.innerWidth = priorInnerWidth;
    if (priorInnerHeight === undefined) delete globalThis.innerHeight;
    else globalThis.innerHeight = priorInnerHeight;
  }
});

test("inspect exposes capped-scan completeness and frame filters", async () => {
  const { inspect } = await locator();
  const page = {
    calls: 0,
    async evaluate(fn, args) {
      this.calls++;
      this.args = args;
      return { items: [], scannedTotal: 0, limitReached: false, elementLimit: args[2],
        documents: 1, scopeMatches: 1, unreadFrames: [], complete: true,
        coverage: "same-origin-light-dom" };
    },
  };
  const result = await inspect(page, { scanLimit: 1, framePath: "0/0", fieldid: "btnSave" });
  assert.equal(page.calls, 1);
  assert.equal(result.elementLimit, 1);
  assert.ok(Array.isArray(result.unreadFrames));
  assert.equal(result.coverage, "same-origin-light-dom");
  assert.equal(page.args[3], null, "unspecified scope is forwarded as null");
  assert.equal(page.args[7], "btnSave");
  assert.equal(page.args[8], "0/0");
  assert.equal(result.complete, true, "empty matching frame path is complete when accessible and under cap");
});

test("inspect proves exact-cap completeness, overflow, frame scope and inaccessible-frame coverage", async () => {
  const { inspect } = await locator();
  const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
  const box = (left, top = 10) => ({ left, top, width: 24, height: 12, right: left + 24, bottom: top + 12 });
  const makeButton = (doc, name, left, fieldid = "") => ({
    tagName: "BUTTON", ownerDocument: doc, innerText: name, value: "", className: "", disabled: false,
    getBoundingClientRect: () => box(left), getAttribute(key) { return key === "fieldid" ? fieldid : ""; },
    matches(selector) { return selector.split(",").some(part => part.trim() === "button" || part.trim() === "[fieldid]" || part.trim() === "[data-fieldid]"); },
    closest: () => null, contains: node => node === this, querySelectorAll: () => [],
  });
  const makeDoc = (buttons = [], frames = []) => {
    const doc = { URL: "https://fixture.test/", defaultView: view, querySelectorAll(selector) {
      if (selector === "iframe") return frames;
      return buttons.filter(button => button.matches(selector));
    }, elementFromPoint(x) { return buttons.find(button => { const r = button.getBoundingClientRect(); return x >= r.left && x <= r.right; }) || null; } };
    for (const button of buttons) button.ownerDocument = doc;
    for (const frame of frames) frame.ownerDocument = doc;
    return doc;
  };
  const topButtons = [];
  const childButtons = [];
  const child = makeDoc(childButtons);
  const frame = { getBoundingClientRect: () => box(100, 100), clientLeft: 0, clientTop: 0, clientWidth: 200, clientHeight: 120, contentDocument: child };
  const top = makeDoc(topButtons, [frame]);
  const prior = { document: globalThis.document, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight };
  globalThis.document = top; globalThis.innerWidth = 1000; globalThis.innerHeight = 800;
  try {
    for (let i = 0; i < 3; i++) topButtons.push(makeButton(top, "item" + i, 10 + i * 40));
    const exact = await inspect({ evaluate: async (fn, args) => fn(args) }, { scanLimit: 3 });
    assert.equal(exact.items.length, 3);
    assert.equal(exact.limitReached, false, "exact cap has not proven overflow");
    assert.equal(exact.complete, true);
    topButtons.push(makeButton(top, "item3", 150));
    const overflow = await inspect({ evaluate: async (fn, args) => fn(args) }, { scanLimit: 3 });
    assert.equal(overflow.items.length, 3);
    assert.equal(overflow.limitReached, true, "fourth eligible DOM control proves overflow");
    assert.equal(overflow.complete, false);
    const frameOnly = await inspect({ evaluate: async (fn, args) => fn(args) }, { scanLimit: 3, framePath: "0/0" });
    assert.ok(frameOnly.items.every(item => item.framePath === "0/0"));
    assert.equal(frameOnly.documents, 2, "the top document is traversed to reach its selected child");
    assert.equal(frameOnly.selectedDocuments, 1);
    frame.contentDocument = null;
    const unavailable = await inspect({ evaluate: async (fn, args) => fn(args) }, { scanLimit: 10 });
    assert.equal(unavailable.complete, false);
    assert.equal(unavailable.unreadFrames[0].reason, "inaccessible-frame");
  } finally {
    if (prior.document === undefined) delete globalThis.document; else globalThis.document = prior.document;
    if (prior.innerWidth === undefined) delete globalThis.innerWidth; else globalThis.innerWidth = prior.innerWidth;
    if (prior.innerHeight === undefined) delete globalThis.innerHeight; else globalThis.innerHeight = prior.innerHeight;
  }
});

test("different hit keys in separate frames remain ambiguous even at same coordinates", async () => {
  const { find } = await locator();
  const page = {
    async evaluate() {
      return {
        items: [
          candidate("保存", { x: 100, y: 100, frame: 0, framePath: "0", hitKey: "0:1" }),
          candidate("保存", { x: 100, y: 100, frame: 1, framePath: "0/0", hitKey: "0/0:1" }),
        ],
        scannedTotal: 2, limitReached: false, complete: true,
        coverage: "same-origin-light-dom", documents: 2, unreadFrames: [], scopeMatches: 2,
      };
    },
  };
  const found = await find(page, "保存");
  assert.equal(found.reason, "ambiguous");
  assert.equal(found.candidates.length, 2);
});

test("same-hit wrapper cannot replace the exact inner-control match with its fieldid", async () => {
  const { find } = await locator();
  const page = { async evaluate() {
    return { items: [
      candidate("条件筛选 保存更多", { fieldid: "page|btnWrapper", hitKey: "0:1", framePath: "0", w: 100, h: 40 }),
      candidate("保存", { fieldid: "", hitKey: "0:1", framePath: "0", w: 20, h: 10 }),
    ], limitReached: false, complete: true, coverage: "test", documents: 1, unreadFrames: [], scopeMatches: 1 };
  } };
  const found = await find(page, "保存");
  assert.equal(found.best.name, "保存");
  assert.equal(found.best.score, 1);
  assert.equal(found.reason, "ok");
});

test("click refuses a newly ambiguous result after reveal", async () => {
  const { click } = await locator();
  let scans = 0, clicks = 0;
  const page = {
    async evaluate(fn, args) {
      if (!args) return { w: 1000, h: 800 };
      scans++;
      return scans === 1
        ? { items: [candidate("保存", { inView: false, y: 900 })], limitReached: false, complete: true, coverage: "test", documents: 1, unreadFrames: [], scopeMatches: 1 }
        : { items: [
          candidate("保存", { x: 100, y: 100, hitKey: "0:1", framePath: "0" }),
          candidate("保存", { x: 102, y: 102, hitKey: "0:2", framePath: "0" }),
        ], limitReached: false, complete: true, coverage: "test", documents: 1, unreadFrames: [], scopeMatches: 1 };
    },
    mouse: { async move() {}, async wheel() {}, async click() { clicks++; } },
  };
  const result = await click(page, "保存", { revealSteps: 1, revealWait: 0 });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, "ambiguous");
  assert.equal(clicks, 0);
});

test("no-match click uses one inspection and waitFor needs no page wait helper", async () => {
  const { click, waitFor } = await locator();
  let calls = 0;
  const page = {
    async evaluate() { calls++; return { items: [], limitReached: false, complete: true, coverage: "test", documents: 1, unreadFrames: [], scopeMatches: 1 }; },
  };
  const result = await click(page, "missing");
  assert.equal(result.reason, "no-match");
  assert.equal(calls, 1);

  const ready = await waitFor({
    async evaluate() { return { items: [candidate("确认")], limitReached: false, complete: true, coverage: "test", documents: 1, unreadFrames: [], scopeMatches: 1 }; },
  }, "确认", { timeout: 50 });
  assert.equal(ready.ok, true);
});

