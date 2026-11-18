'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let metricsPromise;
function metrics() { metricsPromise ??= import('../scripts/ego-session-metrics.mjs'); return metricsPromise; }

test('metrics recognize newly added scoped reader calls without inflating API call counts', async () => {
  const { analyzeCode } = await metrics();
  const result = analyzeCode('await ys.readValue({ selector: "#amount" }); await ys.waitIdle({ parts: ["fields"] });');
  assert.equal(result.ys, true);
  assert.equal(result.adapter, true);
  assert.equal(result.adapterCalls, 2);
  assert.equal(result.apiCounts['evaluate'], undefined);
});

test('trace normalization preserves nested counters and marks missing, invalid, dropped and pending evidence', async () => {
  const { normalizeObservationTrace, summarizeRuntime } = await metrics();
  assert.equal(normalizeObservationTrace(null), null);
  const trace = normalizeObservationTrace({ version: 1, droppedEvents: 1, counts: {
    adapter: { attempted: 3, succeeded: 2, failed: 1 }, evaluation: { attempted: 2, succeeded: 1, failed: 1 },
  }, events: [
    { sequence: 2, method: 'ys.readValue', stage: 'adapter', outcome: 'pending', pageLabel: 'p2' },
    { sequence: 1, method: 'page.evaluate', stage: 'evaluation', outcome: 'failed', durationMs: 3, errorCode: 'EVAL' },
    { sequence: 3, method: 'broken', stage: 'adapter', outcome: 'failed', durationMs: -1 },
  ] });
  assert.equal(trace.available, true);
  assert.equal(trace.events.length, 2);
  assert.equal(trace.events[0].sequence, 1);
  assert.equal(trace.invalidEvents, 1);
  assert.equal(trace.droppedEvents, 1);
  assert.equal(trace.settled, false);
  assert.equal(trace.orderingComplete, false);
  assert.deepEqual(trace.counts.evaluation, { attempted: 2, succeeded: 1, failed: 1 });
  const summary = summarizeRuntime([{ callId: 'call-1', executionId: 'exec-1', observationTrace: trace },
    { callId: 'call-2', executionId: 'exec-2', observationTrace: null },
    { callId: 'call-3', executionId: 'exec-3', observationTrace: { available: false, reason: 'bad' } }]);
  assert.equal(summary.identities, 3);
  assert.equal(summary.withTrace, 1);
  assert.equal(summary.unavailable, 2);
  assert.equal(summary.invalidTrace, 1);
  assert.equal(summary.incompleteTrace, 1);
  assert.equal(summary.recordedEvents, 2);
  assert.equal(summary.pendingEvents, 1);
  assert.equal(summary.failedEvents, 1);
  assert.equal(summary.droppedEvents, 1);
  assert.deepEqual(summary.reportedCounts.evaluation, { attempted: 2, succeeded: 1, failed: 1 });
});

test('execution reconciliation is global across source files and preserves first known terminal state', async () => {
  const { evaluateRecords } = await metrics();
  const t = Date.parse('2026-11-17T02:00:00Z');
  const json = value => JSON.stringify({ data: value });
  const records = [
    { type: 'tool/call', time: t, sourceFile: 'a.jsonl', data: { name: 'mcp__browser_ai__browser_run', callId: 'run-call',
      arguments: { runId: 'run-1', code: 'await ys.readValue({ selector: "#status" });' } } },
    { type: 'tool/result', time: t + 1, sourceFile: 'a.jsonl', data: { message: { toolCallId: 'run-call', content: [{ type: 'text',
      text: json({ executionId: 'exec-1', runId: 'run-1', state: 'running' }) }] } } },
    { type: 'tool/call', time: t + 2, sourceFile: 'b.jsonl', data: { name: 'mcp__browser_ai__run_get', callId: 'poll-1', arguments: { runId: 'run-1' } } },
    { type: 'tool/result', time: t + 3, sourceFile: 'b.jsonl', data: { message: { toolCallId: 'poll-1', content: [{ type: 'text',
      text: json({ executions: [{ executionId: 'exec-1', runId: 'run-1', state: 'failed' }] }) }] } } },
    { type: 'tool/call', time: t + 4, sourceFile: 'c.jsonl', data: { name: 'mcp__browser_ai__run_get', callId: 'poll-2', arguments: { runId: 'run-1' } } },
    { type: 'tool/result', time: t + 5, sourceFile: 'c.jsonl', data: { message: { toolCallId: 'poll-2', content: [{ type: 'text',
      text: json({ executions: [{ executionId: 'exec-1', runId: 'run-1', state: 'succeeded' }] }) }] } } },
  ];
  const result = evaluateRecords(records, { since: t, until: t + 5 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].executionState, 'failed');
  assert.equal(result.rows[0].status, 'fail');
  assert.equal(result.gaps.conflictingExecutionStates, 1);
  assert.equal(result.rows[0].sourceFile, 'a.jsonl');
});

test('finish outcomes separate accepted feedback from rejection and cleanup state', async () => {
  const { evaluateRecords } = await metrics();
  const t = Date.parse('2026-11-17T02:00:00Z');
  const payload = value => JSON.stringify(value);
  const records = [
    { type: 'tool/call', time: t, data: { name: 'mcp__browser_ai__run_finish', callId: 'f1',
      arguments: { runId: 'run-1', requestId: 'accepted', outcome: 'succeeded' } } },
    { type: 'tool/result', time: t + 1, data: { message: { toolCallId: 'f1', content: [{ type: 'text', text: payload({ data: {
      runs: [{ runId: 'run-1', state: 'needs_verification', feedback: { requestId: 'accepted' }, cleanup: { state: 'failed' } }],
    } }) }] } } },
    { type: 'tool/call', time: t + 2, data: { name: 'mcp__browser_ai__run_finish', callId: 'f2',
      arguments: { runId: 'run-1', requestId: 'rejected', outcome: 'failed' } } },
    { type: 'tool/result', time: t + 3, data: { message: { toolCallId: 'f2', isError: true, content: [{ type: 'text', text: payload({ isError: true,
      structuredContent: { data: { code: 'VERIFICATION_FAILED' } } }) }] } } },
    { type: 'tool/call', time: t + 4, data: { name: 'mcp__browser_ai__run_finish', callId: 'f3',
      arguments: { runId: 'run-1', requestId: 'unknown', outcome: 'unknown' } } },
  ];
  const result = evaluateRecords(records, { since: t, until: t + 4 });
  assert.deepEqual(result.finishes.totals, { attempts: 3, accepted: 1, rejected: 1, unknown: 1 });
  assert.equal(result.finishes.rows[0].cleanup.state, 'failed');
  assert.equal(result.finishes.rows[0].acceptance, 'accepted');
  assert.equal(result.finishes.rows[1].error.code, 'VERIFICATION_FAILED');
});
