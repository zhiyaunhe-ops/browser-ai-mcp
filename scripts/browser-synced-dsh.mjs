import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dayOf } from "./ego-session-metrics.mjs";

// The Windows uploader commits a packet before advancing its native DSH cursor.
export function readSyncedDsh(day, timeZone = "Asia/Hong_Kong") {
  const path = process.env.BROWSER_DSH_LEDGER || join(homedir(), ".local/share/yonclaw-eval-sync-v1/ledger.sqlite");
  const rows = [];
  const coverage = { path, available: false, receipts: [], unmatchedResults: 0, recorderReadbacks: [] };
  if (!existsSync(path)) return { rows, coverage };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    for (const packet of db.prepare(`SELECT host, captured, coverage FROM packets p
      WHERE harness = 'dsh' AND rowid = (SELECT rowid FROM packets
        WHERE host = p.host AND harness = p.harness ORDER BY captured DESC, rowid DESC LIMIT 1)
      GROUP BY host`).all()) {
      const metadata = JSON.parse(packet.coverage || "{}");
      coverage.receipts.push({ host: packet.host, captured: new Date(packet.captured).toISOString(),
        since: metadata.since, scope: metadata.browser_capture_version ?? "browser-ai MCP only" });
    }
    const utcDay = Date.parse(day + "T00:00:00Z");
    const dateMatches = new Map();
    function inDay(time) {
      const minute = Math.floor(time / 60000);
      if (!dateMatches.has(minute)) dateMatches.set(minute, dayOf(time, timeZone) === day);
      return dateMatches.get(minute);
    }
    const results = db.prepare(`SELECT seq,data FROM events WHERE host=? AND harness='dsh'
      AND session=? AND call_id=? AND kind='tool/result' ORDER BY seq DESC LIMIT 1`);
    const calls = db.prepare(`SELECT * FROM events WHERE harness='dsh' AND kind='tool/call'
      AND time >= ? AND time < ? ORDER BY time,host,session,seq`);
    const start = utcDay - 86400000, end = utcDay + 172800000;
    for (const event of calls.iterate(start, end)) {
      if (!inDay(event.time)) continue;
      const input = JSON.parse(event.data);
      const found = results.get(event.host, event.session, event.call_id);
      const output = found && JSON.parse(found.data);
      const ref = seq => ({ path, host: event.host, session: event.session, seq });
      rows.push({ source: "windows_dsh", transport: input.browser_source === "shell_browser" ? "cli" : "native_mcp",
        operation: event.tool, category: /^(?:eval_|review_)/.test(event.tool) ? "review" :
          /^(?:run_begin|run_finish|run_get)$/.test(event.tool) ? "lifecycle" : "operation",
        resultScope: "tool_response",
        toolStatus: output?.is_error === true ? "fail" : output?.is_error === false ? "ok" : "unknown",
        status: output?.is_error === true ? "fail" : "unknown", businessStatus: "unknown",
        timestamp: new Date(event.time).toISOString(), sessionId: event.session, callId: event.call_id,
        runId: output?.run_id || input.run_id || null, executionId: output?.execution_id || input.execution_id || null,
        errorCode: output?.error_code || null, evidence: { call: ref(event.seq), result: found ? ref(found.seq) : null } });
    }
    for (const event of db.prepare(`SELECT time FROM events r WHERE harness='dsh' AND kind='tool/result'
      AND time >= ? AND time < ? AND NOT EXISTS (SELECT 1 FROM events c WHERE c.host=r.host
      AND c.harness=r.harness AND c.session=r.session AND c.call_id=r.call_id AND c.kind='tool/call')`).iterate(start,end)) {
      if (inDay(event.time)) coverage.unmatchedResults++;
    }
    const lookup = db.prepare(`SELECT observed, source, data FROM observations WHERE host=? AND harness='dsh'
      AND run_id=? ORDER BY observed DESC LIMIT 1`);
    const checked = new Set();
    for (const row of rows) {
      if (!row.runId) continue;
      const host = row.evidence.call.host;
      const key = host + "/" + row.runId;
      if (checked.has(key)) continue;
      checked.add(key);
      const observed = lookup.get(host, row.runId);
      if (!observed) {
        coverage.recorderReadbacks.push({ host, runId: row.runId, state: null, outcome: null,
          verificationRefs: 0, verification: [], gaps: ["recorder_readback_missing"] });
        continue;
      }
      const data = JSON.parse(observed.data);
      coverage.recorderReadbacks.push({ host, runId: row.runId, observed: observed.observed,
        state: data.state, outcome: data.outcome, source: observed.source,
        verificationRefs: data.verification_refs?.length ?? 0,
        verification: data.verification_refs ?? [],
        gaps: [
          ...(!["completed", "failed", "cancelled"].includes(data.state) ? ["run_state_unconfirmed"] : []),
          ...(!["succeeded", "failed", "cancelled"].includes(data.outcome) ? ["run_outcome_unconfirmed"] : []),
          ...(!data.verification_refs?.length ? ["verification_refs_missing"] : [])
        ] });
    }
    coverage.available = true;
    return { rows, coverage };
  } finally {
    db.close();
  }
}
