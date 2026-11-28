#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { readSession } from "./ego-session-data.mjs";
import { analyzeCode, normalizeObservationTrace, resolveWindow } from "./ego-session-metrics.mjs";
import { cliOperations } from "./browser-cli-operations.mjs";
import { readSyncedDsh } from "./browser-synced-dsh.mjs";
import { readRecorderExecutions } from "./browser-recorder-evidence.mjs";

const browserName = /^mcp__(?:codex_apps__)?(?:browser(?:[_-]ai(?:[_-]mcp)?|[_-]use)?|ego[_-]browser|playwright|chrome[_-]devtools|computer[_-]use)__(\w+)$/;
const browserNamespace = /^(?:mcp__(?:codex_apps__)?)?(?:browser(?:[_-]ai(?:[_-]mcp)?|[_-]use)?|ego[_-]browser|playwright|chrome[_-]devtools|computer[_-]use)$/;
const webTool = /^(?:web__run|mcp__codex_apps__search_service_web_run)$/;
const webActions = ["open", "click", "find", "screenshot"];
const lifecycle = /^(?:run_(?:begin|get|finish|summary)|recipe_draft)$/;
const review = /^(?:eval_|review_|memory_|evidence_query$)/;
const categoryOf = operation => lifecycle.test(operation) ? "lifecycle" : review.test(operation) ? "review" : "operation";
const knownTool = /^(?:browser_run|run_(?:begin|get|finish|summary)|asp_(?:workbench|ui_template)_\w+|eval_\w+|review_\w+|memory_(?:get|search)|evidence_query|recipe_draft)$/;
const shellTool = /^(?:bash|pwsh|shell|shell_command|exec_command|terminal\.exec)$/;
const callMarker = /exec_command|browser|playwright|selenium|puppeteer|chrome|chromium|msedge|[Cc][Dd][Pp]|computer[_-]use|web__run|search_service_web_run|"web"|run_(?:begin|get|finish|summary)|asp[_-]|ys-|yonyou-(?:nav|view|branch|publish-node)|eval_|review_|memory_|evidence_query|recipe_draft/;
const resultId = /"(?:call_id|toolCallId)"\s*:\s*"([^"]+)"/;
const sessionFile = /\.(?:jsonl(?:\.zs(?:t|td))?|zstd)$/i;
const stateSet = new Set(["running", "succeeded", "failed", "outcome_unknown", "cancelled", "pending", "queued", "needs_user_action", "completed"]);
const operationSuccess = new Set(["updated", "verified", "already_set", "inspected", "opened"]);
const operationFailure = new Set(["verification_failed", "not_found", "ambiguous", "read_error",
  "template_not_found", "field_not_found", "ambiguous_template", "ambiguous_field",
  "template_mismatch", "field_properties_unavailable", "node_not_found", "node_unconfirmed", "ambiguous_node"]);
const runningCell = /^Script running with cell ID (\S+)/i;

const json = value => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
};
const evidence = record => ({ path: record.file, line: record.line });
const method = (name, namespace) => browserName.exec(name)?.[1]
  || (namespace && browserNamespace.test(namespace) || knownTool.test(name) ? name : null);
const propertyName = node => node?.name ?? node?.value;
const UUID = /[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const fileSession = file => path.basename(path.dirname(file)).match(UUID)?.[0]
  || path.basename(file).replace(sessionFile, "").match(UUID)?.[0] || file;
const literal = node => node?.type === "Literal" ? node.value
  : node?.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;

function webOperations(actions, transport) {
  return webActions.flatMap(action => Array.from({ length: actions[action] || 0 }, () => ({ operation: `web.${action}`, transport })));
}

function wrappedOperations(input, coverage) {
  if (typeof input !== "string" || !callMarker.test(input)) return [];
  let ast;
  try {
    ast = parse(input.replace(/^\/\/ @exec:[^\n]*\n/, ""), { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
  } catch {
    coverage.unparsedWrappers++;
    return [];
  }
  const operations = [];
  function guardSkips(node, parent) {
    const test = literal(parent?.test ?? parent?.left);
    if (typeof test !== "boolean") return false;
    return (parent.consequent === node && !test) || (parent.alternate === node && test)
      || (parent.right === node && (parent.operator === "&&" && !test || parent.operator === "||" && test));
  }
  let toolInvocations = 0;
  const visit = (node, conditional = false, parent = null, skipped = false) => {
    if (!node || typeof node !== "object") return;
    if (/(?:Function|For|While|Switch)/.test(node.type) || ["IfStatement", "ConditionalExpression", "LogicalExpression", "CatchClause"]
      .includes(node.type)) conditional = true;
    skipped ||= guardSkips(node, parent);
    const member = node.type === "CallExpression" ? node.callee : null;
    if (node.type === "MemberExpression" && node.object.name === "tools" && parent?.callee !== node
      && (node.computed && node.property.type !== "Literal" || browserName.test(propertyName(node.property)))) {
      coverage.dynamicWrapperDispatches++;
    }
    if (member?.type === "MemberExpression" && member.object.name === "tools") {
      toolInvocations++;
      const name = propertyName(member.property);
      const operation = typeof name === "string" ? browserName.exec(name)?.[1] : undefined;
      const properties = node.arguments[0]?.properties || [];
      const args = Object.fromEntries(properties.filter(item => item.type === "Property")
        .map(item => [propertyName(item.key), literal(item.value)]));
      const add = detected => operations.push(...detected.map(item => ({ ...item, offset: member.start, conditional, skipped })));
      if (operation) add([{ operation, transport: "wrapped_mcp", args, code: args.code }]);
      if (webTool.test(name)) {
        add(webOperations(Object.fromEntries(properties.filter(item => item.value?.type === "ArrayExpression")
          .map(item => [propertyName(item.key), item.value.elements.filter(element => element && element.type !== "SpreadElement").length])), "wrapped_mcp"));
        if (!properties.length || properties.some(item => item.type === "SpreadElement"
          || webActions.includes(propertyName(item.key)) && (item.value?.type !== "ArrayExpression"
            || item.value.elements.some(element => element?.type === "SpreadElement")))) coverage.dynamicWebCalls++;
      }
      if (member.computed && member.property.type !== "Literal") coverage.dynamicWrapperDispatches++;
      if (name === "exec_command") {
        const cmd = properties.find(item => propertyName(item.key) === "cmd")?.value;
        const command = args.cmd ?? (cmd?.type === "TemplateLiteral" ? cmd.quasis.map(part => part.value.cooked).join(" __expression__ ") : undefined);
        if (cmd?.type === "TemplateLiteral" && cmd.expressions.length || typeof command !== "string") coverage.dynamicShellCommands++;
        add(cliOperations(command, coverage));
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, conditional, node, skipped));
      else if (value && typeof value === "object") visit(value, conditional, node, skipped);
    }
  };
  visit(ast);
  return operations.sort((a, b) => a.offset - b.offset).map(operation => ({
    ...operation, wrapped: true, attributable: toolInvocations === 1 && !operation.conditional && operation.attributable !== false
  }));
}

function readCall(record, coverage) {
  const { name, namespace } = record;
  if (webTool.test(name) || namespace === "web" && name === "run") {
    const args = json(record.input);
    if (!args) { coverage.malformedArguments++; return []; }
    return webOperations(Object.fromEntries(webActions.map(key => [key, Array.isArray(args[key]) ? args[key].length : 0])), "native_mcp");
  }
  const operation = method(name, namespace);
  if (operation && operation !== "shell") {
    const args = json(record.input);
    if (!args && record.input != null) coverage.malformedArguments++;
    return [{ operation, transport: "native_mcp", args, code: args?.code }];
  }
  if (record.source === "oracle_codex" && name === "exec") return wrappedOperations(record.input, coverage);
  if (shellTool.test(name)) {
    const args = json(record.input);
    return cliOperations(args?.command ?? args?.cmd ?? (typeof record.input === "string" && !record.input.startsWith("{") ? record.input : undefined), coverage);
  }
  return [];
}

function timestamp(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function normalize(record, source, file, line, sessionId) {
  if (source === "dsh") {
    const data = record.data || {};
    const base = { source, file, line, sessionId, time: timestamp(record.time) };
    if (record.type === "tool/call") return { ...base, callId: data.callId, name: data.name || "", input: data.arguments };
    if (record.type === "tool/result") return { ...base, callId: data.message?.toolCallId, output: data.message };
    return null;
  }
  if (record.type !== "response_item" && record.type !== "item.completed") return null;
  const data = record.payload || record.item || {};
  const base = { source, file, line, sessionId, time: timestamp(record.timestamp) };
  if (["function_call", "custom_tool_call", "mcp_tool_call", "command_execution"].includes(data.type)) {
    return { ...base, callId: data.call_id ?? data.id, name: data.name ?? data.tool ?? (data.type === "command_execution" ? "exec_command" : ""),
      namespace: data.namespace ?? data.server, input: data.arguments ?? data.input ?? data.command,
      ...(data.type === "command_execution" ? { output: data } : data.type === "mcp_tool_call"
        ? { output: data.error ? { isError: true, error: data.error } : data.result } : {}) };
  }
  if (["function_call_output", "custom_tool_call_output"].includes(data.type)) {
    return { ...base, callId: data.call_id, output: data.output };
  }
  return null;
}

function outputParts(output) {
  const values = [];
  const visit = (value, depth = 0) => {
    if (depth > 10 || value == null) return;
    if (typeof value === "string") {
      const cellOutput = value.match(/^Script (?:completed|running with cell ID \S+)\r?\nWall time:[^\n]*\nOutput:\r?\n([\s\S]*)$/i);
      if (cellOutput) {
        visit(cellOutput[1], depth + 1);
        return;
      }
      const decoded = json(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      if (decoded && typeof decoded === "object") visit(decoded, depth + 1);
      else if (value.includes("\n")) for (const line of value.split("\n")) {
        if (!/^\s*[{[]/.test(line)) continue;
        const item = json(line);
        if (item && typeof item === "object") visit(item, depth + 1);
      }
      const shellJson = value.match(/(?:^|\n)(?:Final output|Output):\r?\n([\s\S]+)$/i);
      if (shellJson) {
        const result = json(shellJson[1].trim());
        if (result && typeof result === "object") visit(result, depth + 1);
      }
      if (/\b(?:exited with code|exit code|script running with cell id)\b/i.test(value)) values.push(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (typeof value !== "object") return;
    if (value.structuredContent || value.content || value.data || value.value && value.status === "fulfilled"
      || value.type === "input_text" || value.type === "text") {
      if (value.isError || value.is_error) values.push(value);
      visit(value.structuredContent ?? value.data ?? value.content ?? value.text ?? value.value, depth + 1);
      return;
    }
    if (value.status === "rejected") { values.push({ isError: true, error: value.reason }); return; }
    values.push(value);
    visit(value.executions, depth + 1);
  };
  visit(output);
  return values;
}

function executionMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const state = [value.state, value.s, value.status].find(state => stateSet.has(state));
  const executionId = value.executionId ?? (state && [value.id, value.e].find(id => typeof id === "string" && UUID.test(id)));
  if (!executionId || !state || state === "completed") return null;
  return { executionId, state, runId: value.runId, requestId: value.requestId, businessTool: value.businessTool,
    result: value.result,
    observationId: value.observationId, explicitId: Boolean(value.executionId), trace: normalizeObservationTrace(value.observationTrace), networkCapture: value.networkCapture,
    errorCode: value.error?.code, purpose: value.purpose,
    startedAt: value.startedAt, finishedAt: value.finishedAt, executionStopped: value.executionStopped,
    previousExecutionId: value.previousExecutionId };
}

function outcome(value, operation, transport) {
  if (typeof value === "string" && transport === "cli") {
    const exitCode = value.match(/(?:exited with code|exit code)\s*:?\s*(-?\d+)/i)?.[1];
    if (exitCode != null) return Number(exitCode) === 0 ? "ok" : "fail";
  }
  if (!value || typeof value !== "object") return "unknown";
  if (value.isError === true || value.is_error === true || value.code && typeof value.message === "string") return "fail";
  if (transport === "cli") {
    const exitCode = value.exit_code ?? value.exitCode;
    if (typeof exitCode === "number") return exitCode === 0 ? "ok" : "fail";
  }
  const execution = executionMetadata(value);
  if (execution && /^(?:browser_run|asp_workbench_)/.test(operation)) {
    if (execution.state === "failed") return "fail";
    return execution.state === "succeeded"
      ? outcome(value.result, value.businessTool || operation, transport) : "unknown";
  }
  if (operation === "asp_workbench_open_node" && typeof value.rendered === "boolean") {
    return value.status === "opened" && value.rendered ? "ok" : "fail";
  }
  if (operation === "asp_workbench_query_templates") {
    if (value.status === "queried") return "ok";
    if (["page_type_not_found", "ambiguous_document", "document_not_found"].includes(value.status)) return "fail";
  }
  if (operation === "asp_workbench_query_general_applications") {
    if (value.status === "matched" && value.complete === true) return "ok";
    if (["no_match", "bill_code_required", "query_unavailable"].includes(value.status)) return "fail";
  }
  if (operation === "asp_ui_template_verify_batch" && typeof value.allSelectedFieldsMatch === "boolean") {
    return value.allSelectedFieldsMatch ? "ok" : "fail";
  }
  if (!/^(?:browser_run|asp_workbench_)/.test(operation)) {
    if (value.ok === false || value.success === false) return "fail";
    if (value.ok === true || value.success === true || value.status === "success") return "ok";
  }
  const state = value.state ?? value.s ?? value.status;
  if (state === "failed" || operationFailure.has(state)) return "fail";
  if (state === "succeeded" || operationSuccess.has(state)) return "ok";
  if (operation === "run_begin" && typeof value.runId === "string") return "ok";
  if (operation === "run_finish" && ["completed", "finished", "cancelled"].includes(state)) return "ok";
  if (["run_get", "run_summary", "evidence_query"].includes(operation) && (value.executions || value.records || value.run || value.feedback)) return "ok";
  return "unknown";
}

async function* readLines(file, coverage) {
  if (/\.zs(?:t|td)$/i.test(file)) {
    yield* readSession(file, coverage).split("\n");
    return;
  }
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    yield* lines;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function listFiles(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) listFiles(file, files);
    else if (entry.isFile() && sessionFile.test(file)) files.add(file);
  }
}

function sessionRoots() {
  const home = os.homedir();
  const codex = process.env.CODEX_HOME || path.join(home, ".codex");
  const dsh = path.join(home, ".dsh");
  return {
    dsh: [process.env.DSH_SESSIONS_ROOT || path.join(dsh, "sessions"),
      process.env.DSH_ARCHIVE_ROOT || path.join(dsh, "archive"), path.join(dsh, "archived_sessions")],
    oracle_codex: [path.join(codex, "sessions"), path.join(codex, "archived_sessions")]
  };
}

const callKey = record => `${record.sessionId}\0${record.callId}`;
const laterState = (existing, candidate) => !existing
  || !["succeeded", "failed"].includes(existing.state) && ["succeeded", "failed"].includes(candidate.state)
  || existing.state === candidate.state && (!existing.trace?.available || candidate.trace?.available);

async function scanSource(source, roots, { inDay, until }) {
  const files = new Set(), coverage = {
    roots: [], files: 0, unreadableFiles: [], corruptFrames: 0, malformedLines: 0, malformedArguments: 0,
    unparsedWrappers: 0, dynamicWrapperDispatches: 0, dynamicShellCommands: 0, dynamicWebCalls: 0, uninspectedScriptCommands: 0, missingCallIds: 0, missingTimestamps: 0, duplicateCalls: 0, conflictingExecutionStates: 0,
    dynamicShellCommandRefs: []
  };
  for (const root of new Set(roots.map(root => path.resolve(root)))) {
    try {
      listFiles(root, files);
      coverage.roots.push({ path: root, status: "read" });
    } catch (error) {
      coverage.roots.push({ path: root, status: error.code === "ENOENT" ? "missing" : "unreadable" });
    }
  }
  coverage.files = files.size;
  const outsideDay = { ...coverage };
  coverage.dayScoped = ["malformedArguments", "unparsedWrappers", "dynamicWrapperDispatches", "dynamicShellCommands",
    "dynamicWebCalls", "uninspectedScriptCommands", "missingCallIds", "duplicateCalls", "conflictingExecutionStates"];
  const calls = new Map();
  const waits = new Map();
  const cells = new Map();
  const resultRecords = [];
  const sessions = new Map();
  const processFile = async (file, mode) => {
    let lineNo = 0;
    let sessionId = sessions.get(file) || fileSession(file);
    try {
      for await (const line of readLines(file, mode === "call" ? coverage : { corruptFrames: 0 })) {
        lineNo++;
        if (mode === "call") {
          if (lineNo === 1 || /"type"\s*:\s*"session_meta"/.test(line)) {
            const meta = json(line.replace(/^\uFEFF/, ""));
            if (meta?.type === "session_meta" || meta?.type === "session") {
              sessionId = meta.payload?.id || meta.sessionId || meta.id || sessionId;
              sessions.set(file, sessionId);
              continue;
            }
          }
          if (!/"type"\s*:\s*"(?:tool\/call|function_call|custom_tool_call|mcp_tool_call|command_execution)"/.test(line) || (!callMarker.test(line) && !(source === "oracle_codex" && /"name"\s*:\s*"wait"/.test(line)))) continue;
        } else {
          if (!/"type"\s*:\s*"(?:tool\/result|function_call_output|custom_tool_call_output)"/.test(line)) continue;
          const id = resultId.exec(line)?.[1];
          if (!id || !calls.has(callKey({ sessionId, callId: id })) && !waits.has(callKey({ sessionId, callId: id }))) continue;
        }
        const raw = json(line);
        if (!raw) { coverage.malformedLines++; continue; }
        const record = normalize(raw, source, file, lineNo, sessionId);
        if (!record) continue;
        if (mode === "result") {
          if (record.time !== null && record.time <= until) resultRecords.push(record);
          continue;
        }
        if (record.time > until) continue;
        if (source === "oracle_codex" && record.name === "wait" && record.callId) {
          const cellId = json(record.input)?.cell_id;
          if (typeof cellId === "string") waits.set(callKey(record), cellId);
          continue;
        }
        const selected = record.time !== null && inDay(record.time);
        const dayCoverage = selected ? coverage : outsideDay;
        const dynamicShellBefore = dayCoverage.dynamicShellCommands;
        const operations = readCall(record, dayCoverage);
        if (selected && dayCoverage.dynamicShellCommands > dynamicShellBefore) {
          coverage.dynamicShellCommandRefs.push({ ...evidence(record),
            count: dayCoverage.dynamicShellCommands - dynamicShellBefore });
        }
        if (!operations.length) continue;
        if (record.time === null) { coverage.missingTimestamps++; continue; }
        if (!record.callId) { dayCoverage.missingCallIds++; continue; }
        const key = callKey(record);
        if (calls.has(key)) { dayCoverage.duplicateCalls++; continue; }
        const rows = operations.map((operation, index) => {
          const row = {
            source, transport: operation.transport, operation: operation.operation,
            category: categoryOf(operation.operation),
            status: "unknown", timestamp: new Date(record.time).toISOString(), sessionId, callId: record.callId,
            operationIndex: index + 1, runId: operation.args?.runId ?? null, requestId: operation.args?.requestId ?? null,
            executionId: operation.args?.executionId ?? null, evidence: { call: evidence(record), result: null, state: null }
          };
          if (typeof operation.code === "string" && selected) row.metrics = analyzeCode(operation.code);
          if (operation.args?.purpose) row.purpose = operation.args.purpose;
          if (operation.operation === "run_finish") {
            const verification = operation.args?.verification;
            row.finishRequest = { outcome: operation.args?.outcome ?? null,
              verification: Array.isArray(verification)
                ? verification.map(ref => ({ criterionId: ref?.criterionId, observationId: ref?.observationId }))
                : null };
          }
          if (operation.wrapped) row.wrapperCallSiteOnly = true;
          if (operation.conditional) row.wrapperConditional = true;
          if (operation.skipped) row.wrapperExecution = "condition_not_met";
          return { operation, row };
        });
        calls.set(key, { record, rows, selected });
        if (record.output !== undefined) resultRecords.push(record);
      }
    } catch (error) {
      if (!coverage.unreadableFiles.some(item => item.path === file)) coverage.unreadableFiles.push({ path: file, error: error.code || error.message });
    }
  };
  for (const file of files) await processFile(file, "call");
  if (calls.size) for (const file of files) await processFile(file, "result");

  const states = new Map();
  const conflicts = new Set();
  for (const result of resultRecords.sort((a, b) => a.time - b.time)) {
    const key = callKey(result);
    const cellKey = cellId => `${result.sessionId}\0${cellId}`;
    const waitedCell = waits.get(key);
    const call = waitedCell ? cells.get(cellKey(waitedCell)) : calls.get(key);
    if (!call || result.time < call.record.time) continue;
    const chunks = Array.isArray(result.output) ? result.output.map(item => item?.text ?? item) : [result.output];
    const yieldedCell = chunks.map(chunk => typeof chunk === "string" ? runningCell.exec(chunk)?.[1] : null).find(Boolean);
    if (yieldedCell && !waitedCell) cells.set(cellKey(yieldedCell), call);
    if (waitedCell && !yieldedCell) cells.delete(cellKey(waitedCell));
    const values = outputParts(result.output);
    const tagged = values.filter(value => value?.browserOperation);
    const untagged = values.filter(value => !value?.browserOperation);
    const executions = untagged.map(executionMetadata).filter(Boolean);
    const resultEvidence = evidence(result);
    // A projection with a state and abbreviated ID can refer to a run. Only
    // accept it from an execution tool, or after the execution ID is observed.
    for (const item of executions) {
      const previous = states.get(item.executionId);
      if (previous && ["succeeded", "failed"].includes(previous.state) && ["succeeded", "failed"].includes(item.state) && previous.state !== item.state) {
        conflicts.add(item.executionId);
      }
      if (laterState(previous, item)) {
        const fields = Object.fromEntries(Object.entries(item).filter(([, value]) => value != null));
        states.set(item.executionId, { ...previous, ...fields, evidence: resultEvidence });
      }
    }
    for (const { row, operation } of call.rows) {
      if (operation.wrapped) {
        row.evidence.wrapper ||= resultEvidence;
        if (yieldedCell || waitedCell) {
          row.wrapperCellId = yieldedCell ?? waitedCell;
          if (waitedCell && !yieldedCell) row.evidence.wrapperCompletion = resultEvidence;
        }
        for (const value of tagged) {
          const identity = value.browserOperation;
          if (identity.operation !== row.operation) continue;
          const matches = call.rows.filter(({ row: other }) => other.operation === identity.operation &&
            (identity.operationIndex === undefined || identity.operationIndex === other.operationIndex) &&
            (!other.requestId || other.requestId === identity.requestId) && (!other.runId || other.runId === identity.runId));
          if (matches.length !== 1 || matches[0].row !== row) continue;
          const responses = outputParts(value.result);
          const response = responses.find(item => typeof item?.executionId === "string" || typeof item?.runId === "string" || typeof item?.code === "string");
          const invocation = { requestId: identity.requestId, runId: response?.runId ?? identity.runId,
            executionId: response?.executionId, observationId: response?.observationId,
            errorCode: response?.code ?? response?.error?.code, evidence: resultEvidence };
          if (value.skipped === true && typeof value.reason === "string") {
            (row.wrapperInvocations ||= []).push({ ...invocation, state: "condition_not_met", reason: value.reason });
          } else if (responses.length) {
            const statuses = responses.map(item => outcome(item, row.operation, row.transport));
            const status = statuses.includes("fail") ? "fail" : statuses.includes("ok") ? "ok" : "unknown";
            (row.wrapperInvocations ||= []).push({ ...invocation, state: "observed", status });
            for (const item of responses.map(executionMetadata).filter(Boolean)) {
              const previous = states.get(item.executionId);
              if (laterState(previous, item)) states.set(item.executionId, { ...item, evidence: resultEvidence });
            }
          }
        }
      }
      if (operation.skipped || row.wrapperInvocations?.length) continue;
      const direct = call.rows.length === 1 && operation.attributable !== false;
      const attributed = executions.filter(item => item.executionId === row.executionId
        || row.runId && row.requestId && item.runId === row.runId && item.requestId === row.requestId
          && (!item.businessTool || item.businessTool === row.operation));
      const eligible = attributed.length ? attributed
        : direct && row.category === "operation" && row.transport !== "cli" ? executions.filter(
          item => item.explicitId || /^(?:browser_run|asp_workbench_)/.test(row.operation)) : [];
      const ids = new Set(eligible.map(item => item.executionId));
      if (ids.size === 1) {
        const item = eligible[0];
        row.executionId ||= item.executionId;
        row.runId ||= item.runId ?? null;
        row.requestId ||= item.requestId ?? null;
        row.purpose ||= item.purpose;
      }
      if (!operation.wrapped || attributed.length || direct && untagged.length) row.evidence.result ||= resultEvidence;
      if (operation.wrapped && !row.evidence.result) row.resultScope = "outer_call";
      else delete row.resultScope;
      if (direct) {
        const identity = untagged.find(value => typeof value?.runId === "string");
        if (identity) row.runId ||= identity.runId;
        const reported = untagged.map(value => outcome(value, row.operation, row.transport));
        if (row.status === "unknown" && (reported.includes("ok") || reported.includes("fail"))) {
          row.status = reported.includes("fail") ? "fail" : "ok";
          row.evidence.state = resultEvidence;
          const response = untagged.find(value => typeof value?.code === "string")
            ?? untagged.find(value => stateSet.has(value?.status) || typeof value?.observationId === "string");
          row.errorCode = response?.code ?? response?.error?.code;
          row.observationId ||= response?.observationId;
          row.blockingExecutions ||= response?.blockingExecutions;
        }
      }
      if (row.executionId || row.status !== "unknown") {
        delete row.wrapperCallSiteOnly;
        if (operation.wrapped) row.wrapperExecution = "observed";
      }
    }
  }
  const rows = [...calls.values()].filter(call => call.selected).flatMap(call => call.rows.map(({ row }) => row));
  for (const row of rows) {
    for (const invocation of row.wrapperInvocations || []) {
      const state = states.get(invocation.executionId);
      if (invocation.state !== "observed" || !state) continue;
      invocation.runId ||= state.runId;
      invocation.observationId ||= state.observationId;
      invocation.errorCode ||= state.errorCode;
      invocation.executionState = state.state;
      invocation.businessStatus = outcome(state.result, state.businessTool || row.operation, row.transport);
      invocation.status = outcome(state, row.operation, row.transport);
      invocation.finalEvidence = state.evidence;
    }
    if (row.wrapperInvocations?.length === 1) {
      const invocation = row.wrapperInvocations[0];
      row.wrapperExecution = invocation.state;
      if (invocation.state === "observed") {
        row.runId ||= invocation.runId;
        row.requestId ||= invocation.requestId;
        row.executionId ||= invocation.executionId;
        row.observationId ||= invocation.observationId;
        row.errorCode ||= invocation.errorCode;
        row.status = invocation.status;
        row.evidence.result = invocation.evidence;
        delete row.wrapperCallSiteOnly;
      }
    } else if (row.wrapperInvocations?.length > 1) {
      row.wrapperExecution = "multiple_invocations";
      row.evidence.result ||= row.wrapperInvocations[0].evidence;
      delete row.wrapperCallSiteOnly;
    }
    const state = states.get(row.executionId);
    if (state && row.category === "operation") applyExecution(row, state, state.evidence);
    if (row.wrapperCallSiteOnly) row.wrapperExecution ||= row.evidence.wrapper
      ? row.wrapperConditional ? "conditional_execution_unconfirmed" : "inner_result_unattributed"
      : "wrapper_result_missing";
  }
  coverage.conflictingExecutionStates = new Set(rows.filter(row => conflicts.has(row.executionId)).map(row => row.executionId)).size;
  return { rows, coverage };
}

function applyExecution(row, state, source) {
  row.runId ||= state.runId ?? null;
  row.evidence.execution = source;
  if (state.result != null) {
    row.businessStatus = outcome(state.result, state.businessTool || row.operation, row.transport);
    row.businessResult = { status: state.result.status ?? null,
      ...(typeof state.result.rendered === "boolean" ? { rendered: state.result.rendered } : {}) };
    row.evidence.business = source;
  }
  row.businessStatus ||= "unknown";
  if (!["succeeded", "failed"].includes(row.executionState)) row.executionState = state.state;
  row.purpose ||= state.purpose;
  row.observationId ||= state.observationId;
  if (row.wrapperCallSiteOnly && (row.observationId || row.executionId)) {
    delete row.wrapperCallSiteOnly;
    row.wrapperExecution = "observed";
  }
  for (const field of ["startedAt", "finishedAt", "executionStopped", "previousExecutionId"]) {
    if (state[field] != null) row[field] = state[field];
  }
  row.errorCode ||= state.errorCode;
  if (state.trace) row.observationTrace = state.trace;
  if (state.networkCapture) row.networkCapture = {
    status: state.networkCapture.status, capturedRequests: state.networkCapture.capturedRequests,
    gaps: state.networkCapture.gaps?.map(gap => gap.kind)
  };
  if (state.state === "failed") {
    row.status = "fail";
    row.evidence.state = source;
  } else if (row.status !== "fail" && row.businessStatus !== "unknown") {
    row.status = row.businessStatus;
    row.evidence.state = row.evidence.business;
  }
}

export function summarizeOperations(rows) {
  const totals = { total: rows.length, operations: 0, lifecycle: 0, review: 0, sessions: 0,
    status: { ok: 0, fail: 0, unknown: 0 }, operationStatus: { ok: 0, fail: 0, unknown: 0 },
    byTransport: {}, byOperation: {}, missingResults: 0, wrapperCallSitesOnly: 0, wrapperConditional: 0, wrapperExecution: {} };
  const sessions = new Set();
  for (const row of rows) {
    const category = row.category === "operation" ? "operations" : row.category;
    const operation = totals.byOperation[row.operation] ||= { total: 0, ok: 0, fail: 0, unknown: 0 };
    totals[category]++;
    totals.status[row.status]++;
    if (row.category === "operation") totals.operationStatus[row.status]++;
    totals.byTransport[row.transport] = (totals.byTransport[row.transport] || 0) + 1;
    operation.total++;
    operation[row.status]++;
    if (!row.evidence.result && row.wrapperExecution !== "condition_not_met") totals.missingResults++;
    if (row.wrapperExecution) totals.wrapperExecution[row.wrapperExecution] = (totals.wrapperExecution[row.wrapperExecution] || 0) + 1;
    if (row.wrapperCallSiteOnly) totals.wrapperCallSitesOnly++;
    if (row.wrapperConditional) totals.wrapperConditional++;
    sessions.add(`${row.source}\0${row.sessionId}`);
  }
  totals.sessions = sessions.size;
  return totals;
}

export async function collectBrowserOperations({ day, timeZone = "Asia/Hong_Kong", now = Date.now(), roots = sessionRoots() }) {
  const window = resolveWindow([day, "--time-zone", timeZone], { now });
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const inDay = time => date.format(time) === day;
  const options = { inDay, until: window.until };
  const [dsh, codex] = await Promise.all([scanSource("dsh", roots.dsh, options), scanSource("oracle_codex", roots.oracle_codex, options)]);
  const windows = await readSyncedDsh(day, timeZone);
  const recorder = readRecorderExecutions(day, timeZone);
  const executions = new Map(recorder.executions.map(item => [item.executionId, item]));
  const sources = {};
  const rows = [];
  for (const [source, result] of [["dsh", dsh], ["oracle_codex", codex], ["windows_dsh", windows]]) {
    for (const row of result.rows) {
      row.category = categoryOf(row.operation);
      const state = executions.get(row.executionId);
      if (state && row.source === "oracle_codex" && row.category === "operation") applyExecution(row, state, { path: recorder.path, executionId: state.executionId });
      rows.push(row);
    }
    sources[source] = { ...summarizeOperations(result.rows), coverage: result.coverage };
  }
  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp)
    || a.source.localeCompare(b.source) || String(a.callId).localeCompare(String(b.callId))
    || (a.operationIndex ?? 1) - (b.operationIndex ?? 1));
  return { day, timeZone, observedUntil: new Date(window.until).toISOString(), totals: summarizeOperations(rows), sources, rows, recorder: { ...recorder, executions: recorder.executions.map(({ result, ...item }) => item) } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [flag, day, ...rest] = process.argv.slice(2);
  try {
    if (flag !== "--day" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || rest.length) {
      throw new Error("Usage: node scripts/browser-operation-collector.mjs --day YYYY-MM-DD");
    }
    console.log(JSON.stringify(await collectBrowserOperations({ day })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
