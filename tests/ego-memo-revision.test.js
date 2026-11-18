"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

test("ego memo revision includes ys-page helper bytes", () => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src/ego.js"), "utf8");
  assert.match(source, /ys-page\.mjs/);
  const files = ["scripts/ego-memo.mjs", "src/memo.js", "scripts/ys-locate.mjs", "scripts/ys-page.mjs"];
  const digest = contents => {
    const hash = createHash("sha256");
    for (const content of contents) hash.update(content);
    return hash.digest("hex");
  };
  const contents = files.map(file => fs.readFileSync(path.join(root, file)));
  const before = digest(contents);
  const changed = [...contents]; changed[3] = Buffer.concat([changed[3], Buffer.from("\n// changed")]);
  assert.notEqual(digest(changed), before, "a ys-page-only change must change the helper revision");
});

test("versioned memo import refreshes a fake page with a prior boolean marker", async () => {
  const priorState = globalThis.__egoMemoState;
  const priorMemo = globalThis.__egoMemo;
  const priorYs = globalThis.ys;
  globalThis.__egoMemoState = undefined;
  globalThis.ys = undefined;
  try {
    const revision = `?revision=test-${Date.now()}`;
    const memo = await import(`../scripts/ego-memo.mjs${revision}`);
    const calls = [];
    const page = {
      __egoMemoInstalled: true,
      ys: { click: async () => ({ clicked: false, stale: true }) },
      mouse: { async click(x, y, options) { calls.push({ x, y, options }); } },
      async click() {},
      async evaluate() {
        return [{
          tag: "button", name: "保存", aria: "", title: "", value: "", fieldid: "",
          cls: "", disabled: false, frame: 0, framePath: "0", hitKey: "0:1",
          inView: true, x: 120, y: 45,
        }];
      },
    };

    const installed = await memo.install(page, { catalog: false });
    assert.equal(installed.installed, true);
    assert.equal(page.__egoMemoInstalled === true, false);
    assert.equal(typeof page.ys.find, "function");
    assert.equal(typeof page.ys.click, "function");
    assert.notEqual(page.ys.click.toString(), "async () => ({ clicked: false, stale: true })");

    const result = await page.ys.click("保存");
    assert.equal(result.clicked, true);
    assert.equal(result.matchedBy, "name");
    assert.deepEqual(calls.map(({ x, y }) => [x, y]), [[120, 45]]);
  } finally {
    if (priorState === undefined) delete globalThis.__egoMemoState;
    else globalThis.__egoMemoState = priorState;
    if (priorMemo === undefined) delete globalThis.__egoMemo;
    else globalThis.__egoMemo = priorMemo;
    if (priorYs === undefined) delete globalThis.ys;
    else globalThis.ys = priorYs;
  }
});

