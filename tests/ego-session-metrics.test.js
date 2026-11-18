"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

let metricsPromise;
function metrics() {
  metricsPromise ??= import("../scripts/ego-session-metrics.mjs");
  return metricsPromise;
}

test("AST metrics count labeled coordinate calls precisely and ignore comments and unrelated labels", async () => {
  const { analyzeCode } = await metrics();
  const result = analyzeCode(`
    // page.mouse.click(90, 90, {label: "comment"})
    await page.mouse.click(1, 2, { label: "save" });
    await page.mouse.click(3, 4, { label: "" });
    page.click(5, 6, { label: "another" });
    page.click("#save", { label: "not a coordinate call" });
    await ys.click("save");
    await page.mouse.wheel(0, 10);
    await page.snapshot();
    await import("./yonyou-nav.mjs");
    console.log("fieldid", "yonyou-view.mjs", "setDeviceMetricsOverride");
  `);

  assert.equal(result.parsed, true);
  assert.equal(result.coord, true);
  assert.equal(result.coordCalls, 3);
  assert.equal(result.labeledCoordCalls, 2);
  assert.equal(result.labeled, false);
  assert.equal(result.fieldid, true);
  assert.equal(result.nav, true);
  assert.equal(result.view, true);
  assert.equal(result.metric, true);
  assert.equal(result.wheel, true);
  assert.equal(result.snap, true);
  assert.equal(result.ys, true);
  assert.deepEqual(result.imports, ["./yonyou-nav.mjs"]);
});

test("AST parser reports invalid code without inventing operation flags", async () => {
  const { analyzeCode } = await metrics();
  const result = analyzeCode("await page.mouse.click(1 2);");
  assert.equal(result.parsed, false);
  assert.equal(result.coordCalls, 0);
  assert.equal(result.coord, false);
  assert.ok(result.parseError);
});

test("MCP classification requires terminal execution evidence", async () => {
  const { classifyResult, executionStates } = await metrics();
  const message = (state, result = {}) => ({
    content: [{ type: "text", text: JSON.stringify({ data: { executionId: "exec-1", state, result } }) }],
  });

  assert.equal(classifyResult(message("queued")), "unknown");
  assert.equal(classifyResult(message("running")), "unknown");
  assert.equal(classifyResult(message("outcome_unknown")), "unknown");
  assert.equal(classifyResult(message("succeeded", { ok: false })), "ok", "execution status is distinct from business result");
  assert.equal(classifyResult(message("failed")), "fail");
  assert.equal(classifyResult({ isError: true, content: [] }), "fail");
  assert.equal(classifyResult({ content: [{ type: "text", text: JSON.stringify({ result: { ok: false } }) }] }), "unknown");
  assert.deepEqual(executionStates(message("running")).map(({ executionId, state }) => [executionId, state]), [["exec-1", "running"]]);
});

test("CLI result classification needs an exit status", async () => {
  const { classifyResult } = await metrics();
  assert.equal(classifyResult("finished [exit code: 0]", { kind: "cli" }), "ok");
  assert.equal(classifyResult({ exit_code: 2, content: [] }, { kind: "cli" }), "fail");
  assert.equal(classifyResult({ content: [{ text: "still running" }] }, { kind: "cli" }), "unknown");
});

test("CLI source extraction uses inline command text and does not resolve imports", async () => {
  const { cliCode, analyzeCode } = await metrics();
  const source = `await import("file:///historical/round.mjs"); await page.mouse.click(1, 2)`;
  const command = `ego-browser.exe nodejs -e "${source.replaceAll('"', '""')}"`;
  assert.equal(cliCode(command), source);
  const extracted = analyzeCode(cliCode(command));
  assert.equal(extracted.coordCalls, 1);
  assert.deepEqual(extracted.imports, ["file:///historical/round.mjs"]);
  assert.equal(cliCode("node unrelated.js"), null);
});

test("record evaluation reconciles later run_get execution state and keeps unknown calls in denominator", async () => {
  const { evaluateRecords } = await metrics();
  const time = Date.parse("2026-11-10T04:00:00Z");
  const json = (value) => JSON.stringify(value);
  const records = [
    {
      type: "tool/call", time, data: {
        name: "mcp__browser_ai__browser_run", callId: "run-1",
        arguments: json({ code: `await page.mouse.click(10, 20, { label: "go" }); await ys.click("确定");` }),
      },
    },
    {
      type: "tool/result", time: time + 10, data: { message: {
        toolCallId: "run-1", content: [{ type: "text", text: json({ data: { executionId: "exec-1", state: "queued" } }) }],
      } },
    },
    {
      type: "tool/call", time: time + 20, data: {
        name: "mcp__browser_ai__run_get", callId: "poll-1", arguments: json({ executionId: "exec-1" }),
      },
    },
    {
      type: "tool/result", time: time + 30, data: { message: {
        toolCallId: "poll-1", content: [{ type: "text", text: json({ data: { executions: [{ executionId: "exec-1", state: "succeeded" }] } }) }],
      } },
    },
    {
      type: "tool/call", time: time + 40, data: {
        name: "mcp__browser_ai__browser_run", callId: "run-2", arguments: json({ code: "await page.snapshot()" }),
      },
    },
  ];
  const result = evaluateRecords(records, { day: "2026-11-10", timeZone: "Asia/Hong_Kong", until: time + 100 });

  assert.equal(result.totals.rounds, 2);
  assert.equal(result.totals.mcp, 2);
  assert.equal(result.totals.ok, 1);
  assert.equal(result.totals.unknown, 1);
  assert.equal(result.totals.missingResults, 1);
  assert.equal(result.totals.coordCalls, 1);
  assert.equal(result.totals.labeledCoordCalls, 1);
  assert.equal(result.totals.ys, 1);
  assert.equal(result.rows[0].executionState, "succeeded");
  assert.equal(result.rows[1].status, "unknown");
});

test("record evaluation counts imported rounds as unavailable source coverage", async () => {
  const { evaluateRecords } = await metrics();
  const result = evaluateRecords([{
    type: "tool/call", time: Date.parse("2026-11-10T04:00:00Z"), data: {
      name: "browser_run", callId: "run-import", arguments: { code: `await import("./old-round.mjs")` },
    },
  }], { day: "2026-11-10", timeZone: "Asia/Hong_Kong" });
  assert.equal(result.totals.rounds, 1);
  assert.equal(result.totals.importedRounds, 1);
  assert.equal(result.totals.unavailableImports, 1);
});

test("date windows use explicit timezone and reject invalid or ambiguous ranges", async () => {
  const { dayOf, resolveWindow, DEFAULT_TIME_ZONE } = await metrics();
  const now = Date.parse("2026-11-10T16:30:00Z");
  assert.equal(DEFAULT_TIME_ZONE, "Asia/Hong_Kong");
  assert.equal(dayOf(now), "2026-11-11");
  assert.deepEqual(resolveWindow([], { now }), {
    day: "2026-11-11", since: null, until: now, timeZone: "Asia/Hong_Kong",
  });
  assert.deepEqual(resolveWindow(["--since", "2026-11-10T18:00:00+08:00"], { now }), {
    day: null, since: Date.parse("2026-11-10T18:00:00+08:00"), until: now, timeZone: "Asia/Hong_Kong",
  });
  assert.equal(resolveWindow(["--hours", "2"], { now }).since, now - 2 * 3600000);
  assert.throws(() => resolveWindow(["2026-02-30"], { now }), /Invalid calendar date/);
  assert.throws(() => resolveWindow(["--since", "2026-11-10T18:00:00"], { now }), /requires an ISO timestamp/);
  assert.throws(() => resolveWindow(["2026-11-10", "--hours", "2"], { now }), /Choose a date/);
  assert.throws(() => resolveWindow(["--since", "2026-11-11T00:00:00Z"], { now }), /future/);
  assert.throws(() => resolveWindow(["--time-zone", "Invalid/Zone"], { now }), RangeError);
});

