"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

let publishPromise;
function publish() {
  publishPromise ??= import("../scripts/yonyou-publish-node.mjs");
  return publishPromise;
}

test("publication requires identified persisted-state evidence", async () => {
  const { assessPublication } = await publish();
  const result = assessPublication({
    verification: { published: true, recordId: "node-17", evidence: { published: true, status: "active" } },
    expectedRecordId: "node-17",
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.reason, "PUBLICATION_VERIFIED");
});

test("success toast alone and generic success wording do not prove publication", async () => {
  const { assessPublication } = await publish();
  const toast = assessPublication({ after: ["发布成功"] });
  assert.equal(toast.toastOk, true);
  assert.equal(toast.ok, false);
  assert.equal(toast.outcome, "unknown");
  assert.equal(toast.reason, "PUBLICATION_ACKNOWLEDGED_UNVERIFIED");

  const generic = assessPublication({ after: ["操作成功"] });
  assert.equal(generic.toastOk, false);
  assert.equal(generic.outcome, "unknown");
});

test("only new failure notices count, and they take precedence over success evidence", async () => {
  const { assessPublication } = await publish();
  const persistedError = assessPublication({
    before: ["发布失败"], after: ["发布失败"],
    verification: { published: true, recordId: "node-17", evidence: "active" },
    expectedRecordId: "node-17",
  });
  assert.equal(persistedError.newNotices.length, 0);
  assert.equal(persistedError.ok, true, "an old notice should not taint the new attempt");

  const newError = assessPublication({
    before: ["发布成功"], after: ["发布成功", "发布失败"],
    verification: { published: true, recordId: "node-17", evidence: "active" },
    expectedRecordId: "node-17",
  });
  assert.equal(newError.toastBad, true);
  assert.equal(newError.ok, false);
  assert.equal(newError.outcome, "failed");
  assert.equal(newError.reason, "PUBLICATION_FAILURE_NOTICE");
  assert.deepEqual(newError.newNotices, ["发布失败"]);
});

test("verification must identify the expected record and include evidence", async () => {
  const { assessPublication } = await publish();
  const missingId = assessPublication({ verification: { published: true, evidence: "active" } });
  const mismatchedId = assessPublication({
    verification: { published: true, recordId: "another-node", evidence: "active" },
    expectedRecordId: "node-17",
  });
  const missingEvidence = assessPublication({ verification: { published: true, recordId: "node-17", evidence: "" } });
  for (const result of [missingId, mismatchedId, missingEvidence]) {
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "unknown");
  }
});

test("verified non-persistence fails only when record identity and evidence match", async () => {
  const { assessPublication } = await publish();
  const verifiedAbsent = assessPublication({
    verification: { published: false, recordId: "node-17", evidence: { status: "draft" } },
    expectedRecordId: "node-17",
  });
  assert.equal(verifiedAbsent.ok, false);
  assert.equal(verifiedAbsent.outcome, "failed");
  assert.equal(verifiedAbsent.reason, "PUBLICATION_NOT_PERSISTED");

  const unsupportedAbsence = assessPublication({
    verification: { published: false, recordId: "another-node", evidence: { status: "draft" } },
    expectedRecordId: "node-17",
  });
  assert.equal(unsupportedAbsence.outcome, "unknown");
});

test("notice capture observes visible same-origin frames but skips a hidden frame subtree", async () => {
  const { capturePublicationEvidence } = await publish();
  const visibleStyle = { display: "block", visibility: "visible", opacity: "1" };
  const hiddenStyle = { display: "none", visibility: "visible", opacity: "1" };
  const element = (text, style = visibleStyle) => ({
    innerText: text,
    style,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  });
  const makeWindow = (notices = [], frames = []) => {
    const win = {
      getComputedStyle: (el) => el.style || visibleStyle,
      document: {
        querySelectorAll(selector) { return selector === "iframe" ? frames : notices; },
      },
    };
    return win;
  };
  const visibleNotice = element("Published");
  const frameNotice = element("Notice inside frame");
  const hiddenChild = element("Hidden stale notice");
  const visibleChildWindow = makeWindow([frameNotice]);
  const hiddenChildWindow = makeWindow([hiddenChild]);
  const visibleFrame = {
    style: visibleStyle,
    getBoundingClientRect: () => ({ width: 300, height: 150 }),
    contentDocument: visibleChildWindow.document,
    contentWindow: visibleChildWindow,
  };
  const hiddenFrame = {
    style: hiddenStyle,
    getBoundingClientRect: () => ({ width: 300, height: 150 }),
    contentDocument: hiddenChildWindow.document,
    contentWindow: hiddenChildWindow,
  };
  const topWindow = makeWindow([visibleNotice], [visibleFrame, hiddenFrame]);
  const previousWindow = globalThis.window;
  globalThis.window = topWindow;
  try {
    const page = { async evaluate(fn, selector) { return fn(selector); } };
    const result = await capturePublicationEvidence(page, { noticeSelector: ".notice" });
    assert.deepEqual(result, [
      { text: "Published", frame: "top" },
      { text: "Notice inside frame", frame: "top.0" },
    ]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

