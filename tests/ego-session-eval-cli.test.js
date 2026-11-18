"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const zlib = require("node:zlib");
const { zstdCompressSync } = zlib;

const script = path.resolve(__dirname, "../scripts/ego-session-eval.mjs");
const fixedTime = Date.parse("2026-11-10T04:00:00Z");
const jsonLine = (value) => `${JSON.stringify(value)}\n`;

function eventRecords() {
  const call = (type, time, data) => ({ type, time, data });
  return [
    call("tool/call", fixedTime, {
      name: "mcp__browser-ai__browser_run", callId: "run-multi-frame",
      arguments: JSON.stringify({ code: `await page.mouse.click(10, 20, { label: "run" })` }),
    }),
    call("tool/result", fixedTime + 1, { message: {
      toolCallId: "run-multi-frame", isError: false,
      content: [{ type: "text", text: JSON.stringify({ data: { executionId: "exec-multi-frame", state: "queued" } }) }],
    } }),
    call("tool/call", fixedTime + 2, {
      name: "mcp__browser-ai__run_get", callId: "poll-multi-frame",
      arguments: JSON.stringify({ executionId: "exec-multi-frame" }),
    }),
    call("tool/result", fixedTime + 3, { message: {
      toolCallId: "poll-multi-frame", isError: false,
      content: [{ type: "text", text: JSON.stringify({ data: { executions: [{ executionId: "exec-multi-frame", state: "succeeded" }] } }) }],
    } }),
  ];
}

function invokeWithFrames(frames, suffix = Buffer.alloc(0)) {
  const directory = fs.mkdtempSync(path.join(__dirname, ".tmp-eval-"));
  try {
    fs.writeFileSync(path.join(directory, "session.jsonl.zstd"), Buffer.concat([...frames, suffix]));
    const child = spawnSync(process.execPath, [script, "2026-11-10", "--time-zone", "Asia/Hong_Kong"], {
      encoding: "utf8",
      env: { ...process.env, DSH_SESSIONS_ROOT: directory },
    });
    if (child.error) throw child.error;
    const boundary = child.stdout.indexOf("\n}\n{");
    const summaryText = boundary < 0 ? child.stdout : child.stdout.slice(0, boundary + 2);
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, summary: JSON.parse(summaryText) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function rawFrame(payload) {
  assert.ok(payload.length <= 255);
  const block = Buffer.alloc(3);
  block.writeUIntLE((payload.length << 3) | 1, 0, 3);
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.length]), block, payload]);
}

test("CLI evaluates all concatenated zstd frames and reconciles execution polls", () => {
  const records = eventRecords();
  const split = records.length / 2;
  const frameA = zstdCompressSync(Buffer.from(records.slice(0, split).map(jsonLine).join("")));
  const frameB = zstdCompressSync(Buffer.from(records.slice(split).map(jsonLine).join("")));
  const run = invokeWithFrames([frameA, frameB]);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.summary.totals.rounds, 1);
  assert.equal(run.summary.totals.ok, 1, run.stdout);
  assert.equal(run.summary.totals.unknown, 0);
  assert.equal(run.summary.totals.coordCalls, 1);
  assert.equal(run.summary.totals.labeledCoordCalls, 1);
  assert.equal(run.summary.coverage.corruptFrames, 0);
});

test("CLI reports corrupt or partial trailing zstd frames and keeps earlier complete evidence", () => {
  const records = eventRecords();
  const validFrame = zstdCompressSync(Buffer.from(records.map(jsonLine).join("")));
  const partialFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03]);
  const run = invokeWithFrames([validFrame], partialFrame);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.summary.totals.rounds, 1);
  assert.equal(run.summary.totals.ok, 1);
  assert.equal(run.summary.coverage.corruptFrames, 1);
});

test("frame scanner ignores embedded frame magic and valid skippable frames", async () => {
  const { readSession } = await import("../scripts/ego-session-data.mjs");
  const directory = fs.mkdtempSync(path.join(__dirname, ".tmp-eval-"));
  const file = path.join(directory, "embedded.zstd");
  const embedded = Buffer.from([0x41, 0x28, 0xb5, 0x2f, 0xfd, 0x42, 0x0a]);
  const laterFrame = Buffer.from("final line\n");
  const skipped = Buffer.concat([
    Buffer.from([0x50, 0x2a, 0x4d, 0x18]),
    Buffer.from([0x04, 0x00, 0x00, 0x00]),
    Buffer.from("skip"),
  ]);
  const coverage = { corruptFrames: 0 };
  try {
    fs.writeFileSync(file, Buffer.concat([rawFrame(embedded), skipped, rawFrame(laterFrame)]));
    assert.equal(readSession(file, coverage), Buffer.concat([embedded, laterFrame]).toString("utf8"));
    assert.equal(coverage.corruptFrames, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reader reports an unsupported Node zstd runtime explicitly", async () => {
  const { readSession } = await import("../scripts/ego-session-data.mjs");
  const directory = fs.mkdtempSync(path.join(__dirname, ".tmp-eval-"));
  const file = path.join(directory, "unsupported.zstd");
  const original = zlib.zstdDecompressSync;
  try {
    fs.writeFileSync(file, Buffer.from("not needed"));
    zlib.zstdDecompressSync = undefined;
    assert.throws(() => readSession(file, { corruptFrames: 0 }), /does not provide zstdDecompressSync/);
  } finally {
    zlib.zstdDecompressSync = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

