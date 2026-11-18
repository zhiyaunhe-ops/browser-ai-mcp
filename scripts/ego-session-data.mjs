import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { evaluateRecords, summarizeRows, summarizeRuntime, summarizeFinishes } from "./ego-session-metrics.mjs";

export const DEFAULT_ROOT = process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), ".dsh", "sessions");
function trackedCall(record) {
  const name = record.data?.name || "";
  if (/(^|__)(browser_run|run_get|run_finish)$/.test(name)) return true;
  if (!["pwsh", "bash"].includes(name)) return false;
  try {
    const raw = record.data.arguments, args = typeof raw === "object" && raw ? raw : JSON.parse(raw);
    return /ego-browser(?:\.(?:exe|cmd))?["']?\s+nodejs\b/i.test(args?.command || "");
  } catch { return true; } // Keep malformed candidate arguments for coverage accounting.
}
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.name.endsWith(".zstd") || entry.name.endsWith(".jsonl")) out.push(file);
  }
  return out;
}
// Locate frame boundaries by header/block lengths, not by magic bytes inside
// compressed payloads. Layout: RFC 8878 sections 3.1.1 and 3.1.2.
// https://www.rfc-editor.org/rfc/rfc8878.html#section-3.1.1
function frameSpan(buffer, start) {
  let cursor = start;
  const take = size => {
    const at = cursor; cursor += size;
    if (cursor > buffer.length) throw new Error("Incomplete zstd frame");
    return at;
  };
  const magic = buffer.readUInt32LE(take(4));
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    const size = buffer.readUInt32LE(take(4)); take(size);
    return { end: cursor, skip: true };
  }
  if (magic !== 0xfd2fb528) throw new Error("Invalid zstd magic");
  const descriptor = buffer[take(1)];
  if (descriptor & 8) throw new Error("Reserved zstd header bit");
  const single = Boolean(descriptor & 32), fcs = descriptor >>> 6;
  take((single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (fcs ? [0, 2, 4, 8][fcs] : single ? 1 : 0));
  for (;;) {
    const block = buffer.readUIntLE(take(3), 3), type = (block >>> 1) & 3;
    if (type === 3) throw new Error("Reserved zstd block type");
    take(type === 1 ? 1 : block >>> 3);
    if (block & 1) break;
  }
  if (descriptor & 4) take(4);
  return { end: cursor, skip: false };
}

export function readSession(file, coverage) {
  const buffer = fs.readFileSync(file);
  if (!file.endsWith(".zstd")) return buffer.toString("utf8");
  if (typeof zlib.zstdDecompressSync !== "function") throw new Error("This Node runtime does not provide zstdDecompressSync");
  const chunks = [], magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  for (let cursor = 0; cursor < buffer.length;) {
    try {
      const frame = frameSpan(buffer, cursor);
      if (!frame.skip) chunks.push(zlib.zstdDecompressSync(buffer.subarray(cursor, frame.end)));
      cursor = frame.end;
    } catch {
      coverage.corruptFrames++;
      chunks.push(Buffer.from("\n")); // Do not join JSON fragments across a missing frame.
      const next = buffer.indexOf(magic, cursor + 1);
      if (next < 0) break;
      cursor = next;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function scanSessions(window, root = DEFAULT_ROOT) {
  const coverage = { files: 0, unreadableFiles: 0, corruptFrames: 0, malformedLines: 0, malformedArguments: 0, missingTimestamps: 0 };
  const sessions = [];
  let records = [];
  for (const file of walk(root).sort()) {
    coverage.files++;
    let source;
    try { source = readSession(file, coverage); } catch { coverage.unreadableFiles++; continue; }
    for (const [index, line] of source.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const time = typeof record?.time === "number" ? record.time : Date.parse(record?.time);
        if (Number.isFinite(time) && time > (window.until ?? Infinity)) continue;
        if (record?.type === "tool/call" && trackedCall(record) || record?.type === "tool/result") records.push({ ...record, sourceFile: file, sourceLine: index + 1 });
      } catch { coverage.malformedLines++; }
    }
  }
  const callIds = new Set(records.filter(record => record.type === "tool/call").map(record => record.data?.callId));
  records = records.filter(record => record.type === "tool/call" || callIds.has(record.data?.message?.toolCallId));
  const result = evaluateRecords(records, window);
  Object.assign(coverage, result.gaps);
  const files = new Set([...result.rows.map(row => row.sourceFile), ...result.finishes.rows.map(row => row.sourceFile)]);
  for (const file of files) {
    const rows = result.rows.filter(row => row.sourceFile === file);
    const finishes = result.finishes.rows.filter(row => row.sourceFile === file);
    sessions.push({ file, rows, totals: summarizeRows(rows), runtime: summarizeRuntime(rows),
      finishes: { rows: finishes, totals: summarizeFinishes(finishes) } });
  }
  return { sessions, totals: result.totals, runtime: result.runtime, finishes: result.finishes, coverage };
}
