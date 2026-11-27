import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dayOf } from "./ego-session-metrics.mjs";

// Recorder executions and transcript tool calls have different denominators.
export function readRecorderExecutions(day, timeZone) {
  const path = process.env.BROWSER_AI_RECORDER_DB || join(homedir(), ".browser-ai/browser-ai.sqlite");
  const executions = [];
  if (!existsSync(path)) return { path, available: false, executions };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const query = db.prepare(`SELECT id AS executionId, json_extract(json,'$.runId') AS runId,
      json_extract(json,'$.requestId') AS requestId,
      json_extract(json,'$.businessTool') AS businessTool,
      json_extract(json,'$.purpose') AS purpose,
      json_quote(json_extract(json,'$.result')) AS resultJson,
      json_extract(json,'$.startedAt') AS startedAt, json_extract(json,'$.state') AS state,
      json_extract(json,'$.observationId') AS observationId,
      json_extract(json,'$.finishedAt') AS finishedAt,
      json_extract(json,'$.executionStopped') AS executionStopped,
      json_extract(json,'$.previousExecutionId') AS previousExecutionId FROM entities WHERE kind='execution'
      AND json_extract(json,'$.startedAt') BETWEEN ? AND ? ORDER BY startedAt, id`);
    const midnight = Date.parse(day + "T00:00:00Z");
    for (const row of query.iterate(midnight - 86400000, midnight + 172800000)) {
      if (dayOf(row.startedAt, timeZone) === day) {
        row.result = JSON.parse(row.resultJson);
        delete row.resultJson;
        if (row.executionStopped !== null) row.executionStopped = Boolean(row.executionStopped);
        executions.push(row);
      }
    }
    return { path, available: true, executions };
  } finally {
    db.close();
  }
}
