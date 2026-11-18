#!/usr/bin/env node
// Static operation frequencies from immutable saved inline programs, not current imported files.
import { resolveWindow } from "./ego-session-metrics.mjs";
import { scanSessions } from "./ego-session-data.mjs";
try {
  const days = Number(process.argv[2] || 7);
  if (!Number.isFinite(days) || days <= 0 || process.argv.length > 3) throw new Error("usage: ego-memo-mine.mjs [positive days]");
  const { sessions, totals, coverage } = scanSessions(resolveWindow(["--hours", String(days * 24)]));
  const api = new Map(), selectors = new Map();
  for (const session of sessions) for (const row of session.rows) {
    for (const [key, count] of Object.entries(row.apiCounts)) api.set(key, (api.get(key) || 0) + count);
    for (const [key, count] of Object.entries(row.selectorCounts)) selectors.set(key, (selectors.get(key) || 0) + count);
  }
  console.log(JSON.stringify({ metricVersion: 3, sinceDays: days, totals, coverage,
    interpretation: "Static saved-source frequencies; imported bodies unavailable. Not runtime counts or business success." }, null, 2));
  console.log("\nAPI:");
  for (const [key, count] of [...api].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(count).padStart(6)} ${key}`);
  console.log("\nselectors:");
  for (const [key, count] of [...selectors].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)} ${key}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
