// Saved execution evidence is distinct from business completion.
import { parse } from "acorn";
export const DEFAULT_TIME_ZONE = "Asia/Hong_Kong";

export function dayOf(ms, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = key => parts.find(p => p.type === key).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function resolveWindow(argv = [], { now = Date.now(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  let day, since = null, hours = null;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--time-zone") {
      timeZone = argv[++i];
      if (!timeZone || timeZone.startsWith("--")) throw new Error("--time-zone requires an IANA time zone");
    }
    else if (value === "--since") {
      const iso = argv[++i] || "";
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(iso)) throw new Error("--since requires an ISO timestamp with Z or a UTC offset");
      const calendar = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
      if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== iso.slice(0, 10)) throw new Error("Invalid --since calendar date");
      since = Date.parse(iso);
      if (!Number.isFinite(since)) throw new Error("Invalid --since timestamp");
    } else if (value === "--hours") {
      hours = Number(argv[++i]);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be positive");
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      if (day) throw new Error("Supply only one date");
      day = value;
      const date = new Date(`${day}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new Error("Invalid calendar date");
    } else throw new Error(`Unknown argument: ${value}`);
  }
  dayOf(now, timeZone);
  if ([Boolean(day), since !== null, hours !== null].filter(Boolean).length > 1) throw new Error("Choose a date, --since, or --hours");
  if (hours !== null) since = now - hours * 3600000;
  if (since !== null && since > now) throw new Error("The start time is in the future");
  return { day: since === null ? day || dayOf(now, timeZone) : null, since, until: now, timeZone };
}

function chain(node) {
  if (!node) return "";
  if (node.type === "ChainExpression") return chain(node.expression);
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    const key = node.computed ? node.property.value : node.property.name;
    return typeof key === "string" ? `${chain(node.object)}.${key}` : "";
  }
  return "";
}
function visit(node, fn) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, fn));
    else if (value && typeof value === "object") visit(value, fn);
  }
}
const numeric = node => node?.type === "Literal" && typeof node.value === "number"
  || node?.type === "UnaryExpression" && ["-", "+"].includes(node.operator) && numeric(node.argument);

export function analyzeCode(code = "") {
  const result = { parsed: true, coord: false, labeled: false, coordCalls: 0, labeledCoordCalls: 0,
    fieldid: false, nav: false, view: false, metric: false, wheel: false, snap: false, ys: false,
    adapter: false, screenshot: false, adapterCalls: 0, semanticSnapshotCalls: 0, screenshotCalls: 0,
    imports: [], apiCounts: {}, selectorCounts: {} };
  let ast;
  try { ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }); }
  catch (error) { return { ...result, parsed: false, parseError: error.message }; }
  visit(ast, node => {
    if (node.type === "ImportExpression" || node.type === "ImportDeclaration") result.imports.push(node.source?.value || "<dynamic>");
    if (node.type === "Literal" && typeof node.value === "string") {
      for (const selector of ["fieldid", "role=", "text=", "css=", "xpath=", ".wui-", ".fixedDataTable", "iframe"])
        if (node.value.includes(selector)) result.selectorCounts[selector] = (result.selectorCounts[selector] || 0) + 1;
      if (/fieldid/i.test(node.value)) result.fieldid = true;
      if (/yonyou-nav\.mjs/.test(node.value)) result.nav = true;
      if (/yonyou-view\.mjs/.test(node.value)) result.view = true;
      if (/setDeviceMetricsOverride/.test(node.value)) result.metric = true;
    }
    if (node.type !== "CallExpression") return;
    const name = chain(node.callee), args = node.arguments;
    if (name.startsWith("page.")) result.apiCounts[name.slice(5)] = (result.apiCounts[name.slice(5)] || 0) + 1;
    const coord = /\.mouse\.click$/.test(name) || /(?:^|\.)page\.click$/.test(name) && numeric(args[0]) && numeric(args[1]);
    if (coord) {
      result.coordCalls++;
      const label = args[2]?.type === "ObjectExpression" && args[2].properties.find(p => p.type === "Property" && (p.key.name || p.key.value) === "label");
      if (label && !(label.value.type === "Literal" && !label.value.value)) result.labeledCoordCalls++;
    }
    if (/(?:^|\.)ys\.(click|openSplitMenu|transferRight|find|list|collect|waitFor|fieldid|visible|context|inspect|entries|scan|readValue|waitIdle|transferState)$/.test(name)) result.ys = true;
    if (/(?:^|\.)ys\.(find|list|collect|waitFor|visible|context|inspect|entries|scan|readValue|waitIdle|transferState)$/.test(name)) result.adapterCalls++;
    if (/\.mouse\.wheel$/.test(name)) result.wheel = true;
    if (/\.snapshot$/.test(name)) { result.snap = true; result.semanticSnapshotCalls++; }
    if (/\.screenshot$/.test(name)) { result.screenshot = true; result.screenshotCalls++; }
  });
  result.coord = result.coordCalls > 0;
  result.labeled = result.coord && result.labeledCoordCalls === result.coordCalls;
  result.adapter = result.adapterCalls > 0;
  return result;
}

function contentText(message) {
  if (typeof message === "string") return message;
  if (Array.isArray(message?.content)) return message.content.map(c => c.text || "").join("\n");
  return message?.text || "";
}
function payloads(message) {
  const values = [message];
  const text = contentText(message).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (text) { try { values.push(JSON.parse(text)); } catch { /* Unstructured output is unknown. */ } }
  return values;
}
export function executionStates(message) {
  const found = [];
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (typeof value.executionId === "string" && typeof value.state === "string") found.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (["result", "args", "code", "criteria", "value", "observationTrace"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(v => walk(v, depth + 1));
      else if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  payloads(message).forEach(v => walk(v));
  return found;
}
export function classifyResult(message, { kind = "mcp" } = {}) {
  if (payloads(message).some(v => v && (v.isError === true || v.is_error === true))) return "fail";
  if (kind === "cli") {
    const match = contentText(message).match(/\[exit code:\s*(-?\d+)\]/i);
    const exitCode = message?.exit_code ?? message?.exitCode ?? (match ? Number(match[1]) : null);
    return exitCode === null || exitCode === undefined ? "unknown" : exitCode === 0 ? "ok" : "fail";
  }
  const states = executionStates(message);
  if (states.some(e => e.state === "failed")) return "fail";
  return states.length && states.every(e => e.state === "succeeded") ? "ok" : "unknown";
}

// Only the inline source saved with the call is immutable historical evidence.
export function cliCode(command) {
  const match = command.match(/ego-browser(?:\.(?:exe|cmd))?["']?\s+nodejs\s+-e\s+/i);
  if (!match) return null;
  const rest = command.slice(match.index + match[0].length).trim(), quote = rest[0];
  if (quote !== "'" && quote !== '"') return null;
  let code = "";
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === quote) {
      if (rest[i + 1] === quote) { code += quote; i++; continue; }
      return code;
    }
    if (rest[i] === "`" && quote === '"' && i + 1 < rest.length) { code += rest[++i]; continue; }
    code += rest[i];
  }
  return null;
}
export const zero = () => ({ rounds: 0, mcp: 0, cli: 0, coord: 0, labeled: 0, coordCalls: 0, labeledCoordCalls: 0,
  fieldid: 0, nav: 0, view: 0, metric: 0, wheel: 0, snap: 0, ys: 0, memoOff: 0, fail: 0, ok: 0, unknown: 0,
  adapter: 0, screenshot: 0, adapterCalls: 0, semanticSnapshotCalls: 0, screenshotCalls: 0,
  parsed: 0, unparsed: 0, importedRounds: 0, unavailableImports: 0, missingResults: 0 });

export function summarizeRows(rows) {
  const totals = zero();
  for (const row of rows) {
    totals.rounds++; totals[row.kind]++; totals[row.status]++; totals[row.parsed ? "parsed" : "unparsed"]++;
    if (!row.resultSeen) totals.missingResults++;
    for (const key of ["coord", "labeled", "fieldid", "nav", "view", "metric", "wheel", "snap", "ys", "memoOff", "adapter", "screenshot"]) totals[key] += row[key] ? 1 : 0;
    totals.coordCalls += row.coordCalls; totals.labeledCoordCalls += row.labeledCoordCalls;
    for (const key of ["adapterCalls", "semanticSnapshotCalls", "screenshotCalls"]) totals[key] += row[key] || 0;
    if (row.imports.length) { totals.importedRounds++; totals.unavailableImports += row.imports.length; }
  }
  return totals;
}

const traceStages = ["adapter", "semantic", "visual", "action", "evaluation"];
const count = value => Number.isSafeInteger(value) && value >= 0;
export function normalizeObservationTrace(value) {
  if (value == null) return null;
  if (value.version !== 1 || !Array.isArray(value.events) || !count(value.droppedEvents)) return { available: false, reason: "invalid-or-unsupported-trace" };
  let invalidEvents = 0;
  const events = [], sequences = new Set();
  for (const event of value.events) {
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || sequences.has(event.sequence)
      || typeof event.method !== "string" || !traceStages.includes(event.stage)
      || !["succeeded", "failed", "pending"].includes(event.outcome)
      || (event.outcome !== "pending" || event.durationMs !== undefined) && (!Number.isFinite(event.durationMs) || event.durationMs < 0)) {
      invalidEvents++; continue;
    }
    sequences.add(event.sequence);
    const normalized = { sequence: event.sequence, method: event.method, stage: event.stage, outcome: event.outcome };
    if (event.durationMs !== undefined) normalized.durationMs = event.durationMs;
    for (const key of ["complete", "truncated", "ok"]) if (typeof event[key] === "boolean") normalized[key] = event[key];
    for (const key of ["reason", "pageLabel", "errorCode"]) if (typeof event[key] === "string") normalized[key] = event[key];
    events.push(normalized);
  }
  events.sort((a, b) => a.sequence - b.sequence);
  const counts = {}, hasCounts = value.counts && typeof value.counts === "object" && !Array.isArray(value.counts);
  let invalidCounts = 0;
  for (const [stage, valueCount] of Object.entries(hasCounts ? value.counts : {})) {
    if (!traceStages.includes(stage) || !valueCount || !["attempted", "succeeded", "failed"].every(key => count(valueCount[key]))
      || valueCount.succeeded + valueCount.failed > valueCount.attempted) { invalidCounts++; continue; }
    counts[stage] = { attempted: valueCount.attempted, succeeded: valueCount.succeeded, failed: valueCount.failed };
  }
  return { version: 1, available: true, events, counts: hasCounts && invalidCounts === 0 ? counts : null,
    droppedEvents: value.droppedEvents, invalidEvents, invalidCounts,
    settled: events.every(event => event.outcome !== "pending"), orderingComplete: value.droppedEvents === 0 && invalidEvents === 0 };
}

export function summarizeRuntime(rows) {
  const unique = new Map();
  for (const row of rows) {
    const key = row.executionId || row.callId, previous = unique.get(key);
    if (!previous || !previous.observationTrace?.available || row.observationTrace?.available) unique.set(key, row);
  }
  const result = { identities: unique.size, withExecutionId: [...unique.values()].filter(row => row.executionId).length,
    withTrace: 0, withCounts: 0, unavailable: 0, invalidTrace: 0, incompleteTrace: 0,
    recordedEvents: null, failedEvents: null, pendingEvents: null, incompleteObservations: null, droppedEvents: null, invalidEvents: null,
    stageEvents: null, methodEvents: null, reportedCounts: null };
  for (const row of unique.values()) {
    const trace = row.observationTrace;
    if (!trace?.available) { result.unavailable++; if (trace) result.invalidTrace++; continue; }
    result.withTrace++;
    if (!trace.orderingComplete || !trace.settled || trace.counts === null) result.incompleteTrace++;
    if (result.recordedEvents === null) {
      result.recordedEvents = result.failedEvents = result.pendingEvents = result.incompleteObservations = result.droppedEvents = result.invalidEvents = 0;
      result.stageEvents = Object.fromEntries(traceStages.map(stage => [stage, 0])); result.methodEvents = {};
    }
    result.recordedEvents += trace.events.length; result.droppedEvents += trace.droppedEvents; result.invalidEvents += trace.invalidEvents;
    for (const event of trace.events) {
      result.stageEvents[event.stage]++;
      result.methodEvents[event.method] = (result.methodEvents[event.method] || 0) + 1;
      if (event.outcome === "failed") result.failedEvents++;
      if (event.outcome === "pending") result.pendingEvents++;
      if (event.complete === false || event.truncated === true) result.incompleteObservations++;
    }
    if (trace.counts !== null) {
      result.withCounts++;
      result.reportedCounts ||= {};
      for (const [stage, amounts] of Object.entries(trace.counts)) {
        result.reportedCounts[stage] ||= { attempted: 0, succeeded: 0, failed: 0 };
        for (const key of ["attempted", "succeeded", "failed"]) result.reportedCounts[stage][key] += amounts[key];
      }
    }
  }
  return result;
}

function runViews(message) {
  const found = [];
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (typeof value.runId === "string" && (Object.hasOwn(value, "feedback") || Object.hasOwn(value, "cleanup"))) found.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (["result", "args", "code", "criteria", "value", "observationTrace", "feedback", "cleanup"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(item => walk(item, depth + 1));
      else if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  payloads(message).forEach(value => walk(value));
  return found;
}
const toolError = message => payloads(message).some(value => value && (value.isError === true || value.is_error === true));
export function summarizeFinishes(rows) {
  const totals = { attempts: rows.length, accepted: 0, rejected: 0, unknown: 0 };
  for (const row of rows) totals[row.acceptance]++;
  return totals;
}

export function evaluateRecords(records, options = {}) {
  const { day = null, since = null, until = Infinity, timeZone = DEFAULT_TIME_ZONE } = options;
  const rows = [], calls = new Map(), byExecution = new Map(), latestExecutions = new Map(), finishCandidates = [], latestRuns = new Map();
  const stateConflicts = new Set();
  const gaps = { malformedArguments: 0, missingTimestamps: 0, conflictingExecutionStates: 0 };
  const timeOf = record => typeof record.time === "number" ? record.time : Date.parse(record.time);
  const inWindow = time => time <= until && (since !== null ? time >= since : !day || dayOf(time, timeZone) === day);
  const argsOf = raw => {
    if (raw && typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { gaps.malformedArguments++; return {}; }
  };
  // Call identities are global across source files; evidence is ordered before reconciliation.
  const ordered = records.map((record, index) => ({ record, index, time: timeOf(record) }))
    .sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity) || a.index - b.index);
  for (const { record, time } of ordered) {
    if (record.type !== "tool/call") continue;
    const data = record.data || {}, name = data.name || "";
    const kind = /(^|__)browser_run$/.test(name) ? "mcp" : /(^|__)run_get$/.test(name) ? "poll"
      : /(^|__)run_finish$/.test(name) ? "finish" : ["pwsh", "bash"].includes(name) ? "cli" : null;
    if (!kind || calls.has(data.callId)) continue;
    const args = argsOf(data.arguments);
    if (kind === "cli" && !/ego-browser(?:\.(?:exe|cmd))?["']?\s+nodejs\b/i.test(args.command || "")) continue;
    if (!Number.isFinite(time)) { gaps.missingTimestamps++; continue; }
    if (time > until) continue;
    const call = { kind, args, time, inWindow: inWindow(time) };
    calls.set(data.callId, call);
    const source = { sourceFile: record.sourceFile, sourceLine: record.sourceLine };
    if (kind === "finish") {
      call.finish = { callId: data.callId, runId: args.runId || null, requestId: args.requestId || null, time, ...source,
        acceptance: "unknown", resultSeen: false, declaredOutcome: args.outcome || null, feedback: null, runState: null, cleanup: null };
      finishCandidates.push(call); continue;
    }
    if (!["mcp", "cli"].includes(kind) || !call.inWindow) continue;
    const code = kind === "mcp" ? args.code : cliCode(args.command || "");
    const analysis = code == null ? { ...analyzeCode(""), parsed: false } : analyzeCode(code);
    call.row = { callId: data.callId, runId: args.runId || null, time, ...source, kind, status: "unknown",
      resultSeen: false, memoOff: args.memo === false, observationTrace: null, ...analysis };
    rows.push(call.row);
  }
  const applyState = (row, execution, time) => {
    const terminal = ["succeeded", "failed"].includes(row.executionState);
    if (!terminal) {
      row.executionState = execution.state;
      row.status = execution.state === "succeeded" ? "ok" : execution.state === "failed" ? "fail" : "unknown";
      row.stateObservedAt = time;
    }
    if (execution.runId) row.runId = execution.runId;
    if (execution.observationTrace != null) {
      const trace = normalizeObservationTrace(execution.observationTrace), previous = row.observationTrace;
      if (!previous?.available || trace?.available && trace.events.length + trace.droppedEvents >= previous.events.length + previous.droppedEvents) row.observationTrace = trace;
    }
    if (execution.observationId) row.observationId = execution.observationId;
  };
  const observeExecution = (execution, time) => {
    const previous = latestExecutions.get(execution.executionId);
    const next = { ...previous?.execution, ...execution };
    if (["succeeded", "failed"].includes(previous?.execution.state)) {
      if (["succeeded", "failed"].includes(execution.state) && previous.execution.state !== execution.state) {
        const conflict = `${execution.executionId}:${execution.state}`;
        if (!stateConflicts.has(conflict)) { gaps.conflictingExecutionStates++; stateConflicts.add(conflict); }
      }
      next.state = previous.execution.state;
    }
    const before = previous?.execution.observationTrace, after = execution.observationTrace;
    const size = trace => (trace?.events?.length || 0) + (trace?.droppedEvents || 0);
    const settled = trace => Array.isArray(trace?.events) ? trace.events.filter(event => ["succeeded", "failed"].includes(event?.outcome)).length : 0;
    if (before && (!after || size(before) > size(after) || size(before) === size(after) && settled(before) > settled(after))) next.observationTrace = before;
    latestExecutions.set(execution.executionId, { execution: next, time });
    for (const linked of byExecution.get(execution.executionId) || []) applyState(linked, next, time);
  };
  for (const { record, time } of ordered) {
    if (record.type !== "tool/result") continue;
    const message = record.data?.message, call = calls.get(message?.toolCallId);
    if (!call) continue;
    if (!Number.isFinite(time)) { gaps.missingTimestamps++; continue; }
    if (time > until || time < call.time) continue;
    const row = call.row;
    if (row) {
      row.resultSeen = true;
      if (!["succeeded", "failed"].includes(row.executionState) && !(row.kind === "cli" && ["ok", "fail"].includes(row.status))) row.status = classifyResult(message, { kind: row.kind });
      if (row.kind === "mcp") for (const execution of executionStates(message)) {
        if (!row.executionId || row.executionId === execution.executionId) {
          row.executionId = execution.executionId;
          if (!byExecution.has(execution.executionId)) byExecution.set(execution.executionId, new Set());
          byExecution.get(execution.executionId).add(row);
          observeExecution(execution, time);
        }
      }
    }
    if (["poll", "finish"].includes(call.kind)) for (const execution of executionStates(message)) {
      observeExecution(execution, time);
    }
    const finish = call.finish;
    if (finish) {
      finish.resultSeen = true;
      if (toolError(message)) {
        finish.acceptance = "rejected";
        const error = payloads(message).map(value => value?.structuredContent?.data || value?.data).find(value => value?.code);
        if (error) finish.error = { code: error.code, message: error.message };
      }
    }
    for (const run of runViews(message)) {
      latestRuns.set(run.runId, { runId: run.runId, state: run.state || null, cleanup: run.cleanup || null, feedback: run.feedback || null, observedAt: time });
      for (const candidate of finishCandidates) {
        const item = candidate.finish;
        if (item.runId !== run.runId || time < item.time) continue;
        item.runState = run.state || null; item.cleanup = run.cleanup || null;
        const matches = item.requestId && run.feedback?.requestId === item.requestId;
        if (item.acceptance !== "rejected" && run.feedback && (matches || candidate === call && !toolError(message))) {
          item.acceptance = "accepted"; item.feedback = run.feedback; item.feedbackObservedAt = time;
        }
      }
    }
  }
  const runIds = new Set(rows.map(row => row.runId).filter(Boolean));
  const firstRunCall = new Map();
  for (const row of rows) if (row.runId) firstRunCall.set(row.runId, Math.min(firstRunCall.get(row.runId) ?? Infinity, row.time));
  const finishRows = finishCandidates.filter(call => call.inWindow || call.time >= (firstRunCall.get(call.finish.runId) ?? Infinity)).map(call => call.finish);
  const relevantRuns = new Set([...runIds, ...finishRows.map(row => row.runId).filter(Boolean)]);
  return { totals: summarizeRows(rows), rows, runtime: summarizeRuntime(rows),
    finishes: { totals: summarizeFinishes(finishRows), rows: finishRows, runs: [...latestRuns.values()].filter(run => relevantRuns.has(run.runId)) }, gaps };
}
