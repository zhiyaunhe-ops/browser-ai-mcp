#!/usr/bin/env node
// Read-only DSH metrics, based on saved source and observed execution results.
import { resolveWindow, dayOf } from "./ego-session-metrics.mjs";
import { scanSessions } from "./ego-session-data.mjs";
try {
  const window = resolveWindow(process.argv.slice(2));
  const { sessions, totals, runtime, finishes, coverage } = scanSessions(window);
  const percent = (value, denominator = totals.rounds) => denominator ? `${(100 * value / denominator).toFixed(1)}%` : null;
  console.log(JSON.stringify({
    metricVersion: 3, range: window.day || `since ${new Date(window.since).toISOString()}`,
    timeZone: window.timeZone, observedUntil: new Date(window.until).toISOString(),
    completeness: !window.day || window.day === dayOf(window.until, window.timeZone) ? "partial" : "historical",
    sessions: sessions.length, totals, runtime, finishes, coverage,
    rates: { coord: percent(totals.coord), labelOfCoord: percent(totals.labeledCoordCalls, totals.coordCalls),
      fieldid: percent(totals.fieldid), nav: percent(totals.nav), view: percent(totals.view), metric: percent(totals.metric),
      wheel: percent(totals.wheel), ys: percent(totals.ys), adapter: percent(totals.adapter),
      snapshot: percent(totals.snap), screenshot: percent(totals.screenshot),
      mcp: percent(totals.mcp), fail: percent(totals.fail), unknown: percent(totals.unknown) },
    interpretation: "Execution status, saved inline call sites, runtime traces and finish feedback are separate. Unknown remains in execution denominators; missing traces are unavailable. Source order does not prove runtime escalation, and accepted finish feedback is not proof of business success.",
  }, null, 2));
  for (const session of sessions) console.log(JSON.stringify({ file: session.file, totals: session.totals, runtime: session.runtime, finishTotals: session.finishes.totals,
    observationSequences: session.rows.filter(row => row.observationTrace?.available).map(row => ({
      callId: row.callId, executionId: row.executionId || null, observationTrace: row.observationTrace })),
    unresolvedCalls: session.rows.filter(row => row.status === "unknown").map(row => ({ callId: row.callId, executionId: row.executionId || null })) }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
