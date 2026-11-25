'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = require('../src/mcp');
const { createService } = require('../src/service');
const { EgoAdapter } = require('../src/ego');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ai-mcp-test-'));
}

function identifiers() {
  let next = 0;
  return () => `test-id-${++next}`;
}

function makeAdapter(overrides = {}) {
  const calls = { run: [], finish: [], recover: [] };
  const adapter = {
    async run(options) {
      calls.run.push(options);
      const match = options.code.match(/customer\s*:\s*\{\s*code\s*:\s*["']([^"']+)/);
      return { state: 'succeeded', result: match ? { customer: { code: match[1] } } : null,
        spaceId: 41, executionStopped: true };
    },
    async finish(options) {
      calls.finish.push(options);
      return { state: 'succeeded', executionStopped: true };
    },
    async recover(options) { calls.recover.push(options); return null; },
    ...overrides,
  };
  return { adapter, calls };
}

async function withMcp(t, service) {
  const server = createMcpServer(service);
  const client = new Client({ name: 'mcp-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    service.close();
  });
  return client;
}

async function waitForExecution(client, runId, executionId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await client.callTool({ name: 'run_get', arguments: { runId, executionId } });
    const data = response.structuredContent.data;
    const execution = data.executions.find(item => item.executionId === executionId);
    if (execution && !['queued', 'running'].includes(execution.state)) return execution;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`execution ${executionId} did not settle`);
}

test('MCP exposes nine tools and completes a verified memory workflow with idempotent requests', async t => {
  const dataDir = temporaryDirectory();
  const { adapter, calls } = makeAdapter();
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);

  assert.match(client.getInstructions(), /asp_ui_template_update_field/);
  const listed = await client.listTools();
  const templateTool = listed.tools.find(item => item.name === 'asp_ui_template_update_field');
  assert.match(templateTool.description, /changes=\{\}/);
  assert.match(templateTool.description, /changes\.properties/);
  assert.match(templateTool.description, /changes\.formula/);
  assert.ok(templateTool.inputSchema.properties.changes.properties.properties.description);
  assert.ok(templateTool.inputSchema.properties.changes.properties.formula.description);
  assert.deepEqual(listed.tools.map(item => item.name).sort(), [
    'asp_ui_template_update_field', 'asp_workbench_open_node', 'asp_workbench_query_general_applications', 'asp_workbench_query_templates', 'browser_run', 'evidence_query', 'memory_get', 'memory_search', 'recipe_draft', 'run_begin', 'run_finish', 'run_get',
  ]);

  const beginArgs = {
    requestId: 'begin-1', goal: 'Create customer C-1001', url: 'http://127.0.0.1:43127/customers',
    criteria: [{ id: 'saved-customer', path: 'customer.code', equals: 'C-1001' }],
  };
  const begun = (await client.callTool({ name: 'run_begin', arguments: beginArgs })).structuredContent.data;
  assert.equal(begun.state, 'active');
  assert.equal(begun.spaceId, null, 'begin does not implicitly create a browser Space');
  const repeatedBegin = (await client.callTool({ name: 'run_begin', arguments: beginArgs })).structuredContent.data;
  assert.equal(repeatedBegin.runId, begun.runId);
  const conflict = await client.callTool({ name: 'run_begin', arguments: { ...beginArgs, goal: 'Different goal' } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.data.code, 'REQUEST_CONFLICT');

  const observeArgs = { runId: begun.runId, requestId: 'inspect-1', purpose: 'observe', code: 'return { page: "customers" };' };
  const firstObservation = (await client.callTool({ name: 'browser_run', arguments: observeArgs })).structuredContent.data;
  const observationExecution = await waitForExecution(client, begun.runId, firstObservation.executionId);
  assert.equal(observationExecution.state, 'succeeded');
  assert.equal(observationExecution.spaceId, 41);
  const repeatedObservation = (await client.callTool({ name: 'browser_run', arguments: observeArgs })).structuredContent.data;
  assert.equal(repeatedObservation.executionId, firstObservation.executionId);
  assert.equal(calls.run.length, 1);

  const writeArgs = { runId: begun.runId, requestId: 'write-1', purpose: 'execute', code: 'return { saved: true };' };
  const write = (await client.callTool({ name: 'browser_run', arguments: writeArgs })).structuredContent.data;
  const writeExecution = await waitForExecution(client, begun.runId, write.executionId);
  assert.equal(writeExecution.spaceId, 41);
  assert.equal(calls.run[1].spaceId, 41, 'later rounds reuse the returned Space id');

  const premature = await client.callTool({ name: 'run_finish', arguments: {
    runId: begun.runId, requestId: 'finish-too-early', outcome: 'succeeded', decision: 'learned', note: 'premature',
    updates: [{ baseRevision: 0, entry: { key: 'customer-create', name: 'Create customer', summary: 'Create a customer record',
      scope: 'page', url: 'http://127.0.0.1:43127/customers', recipe: { verify: ['customer.code'] } } }],
  } });
  assert.equal(premature.isError, true);
  assert.equal(premature.structuredContent.data.code, 'VERIFICATION_REQUIRED');

  const finalObserveArgs = { runId: begun.runId, requestId: 'verify-1', purpose: 'observe',
    code: 'return { customer: { code: "C-1001" } };' };
  const finalObserve = (await client.callTool({ name: 'browser_run', arguments: finalObserveArgs })).structuredContent.data;
  const finalExecution = await waitForExecution(client, begun.runId, finalObserve.executionId);
  assert.equal(finalExecution.state, 'succeeded');
  const evidence = await client.callTool({ name: 'evidence_query', arguments: { runId: begun.runId, view: 'records' } });
  assert.ok(evidence.structuredContent.data.gaps.some(gap => gap.kind === 'human-actions-not-captured'));
  assert.ok(evidence.structuredContent.data.gaps.some(gap => gap.kind === 'network-not-captured'));

  const draftArgs = { runId: begun.runId, requestId: 'draft-1', name: 'Create customer recipe',
    proposedRecipe: { preconditions: ['Customer form is open'], steps: ['Enter customer code', 'Save'], verify: ['customer.code'] } };
  const draft = (await client.callTool({ name: 'recipe_draft', arguments: draftArgs })).structuredContent.data;
  assert.equal(draft.state, 'draft');
  const repeatedDraft = (await client.callTool({ name: 'recipe_draft', arguments: draftArgs })).structuredContent.data;
  assert.equal(repeatedDraft.draftId, draft.draftId);

  const finishArgs = { runId: begun.runId, requestId: 'finish-1', outcome: 'succeeded', decision: 'learned',
    note: 'Observed the persisted customer code after save.', verification: [{ criterionId: 'saved-customer', observationId: finalExecution.observationId }],
    updates: [{ baseRevision: 0, entry: { key: 'customer-create', name: 'Create customer', summary: 'Create a customer record',
      scope: 'page', url: 'http://127.0.0.1:43127/customers', verification: 'verified',
      recipe: { verify: ['customer.code'] } } }],
  };
  const finished = (await client.callTool({ name: 'run_finish', arguments: finishArgs })).structuredContent.data;
  assert.equal(finished.state, 'completed', JSON.stringify(finished));
  assert.equal(finished.cleanup.state, 'succeeded');
  assert.equal(finished.feedback.changedMemoryIds.length, 1);
  assert.equal(calls.finish.length, 1);
  const repeatedFinish = (await client.callTool({ name: 'run_finish', arguments: finishArgs })).structuredContent.data;
  assert.equal(repeatedFinish.runId, begun.runId);
  assert.equal(calls.finish.length, 1, 'repeated finish does not clean up the Space twice');

  const memories = (await client.callTool({ name: 'memory_search', arguments: { url: beginArgs.url, goal: 'Create customer C-1001' } })).structuredContent.data;
  assert.equal(memories.matches.length, 1);
  assert.equal(memories.matches[0].verification, 'verified');
  const memory = (await client.callTool({ name: 'memory_get', arguments: { memoryId: memories.matches[0].id } })).structuredContent.data;
  assert.equal(memory.recipe.verify[0], 'customer.code');
});

test('failed business verification is rejected and does not call ego cleanup', async t => {
  const { adapter, calls } = makeAdapter();
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'b', goal: 'Create',
    url: 'http://127.0.0.1:43127/customers', criteria: [{ id: 'created', path: 'customer.code', equals: 'wanted' }] } })).structuredContent.data;
  const result = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'o', purpose: 'observe',
    code: 'return { customer: { code: "wrong" } };' } })).structuredContent.data;
  const execution = await waitForExecution(client, run.runId, result.executionId);
  const finish = await client.callTool({ name: 'run_finish', arguments: { runId: run.runId, requestId: 'f', outcome: 'succeeded',
    verification: [{ criterionId: 'created', observationId: execution.observationId }], decision: 'no-change', note: 'wrong value' } });
  assert.equal(finish.isError, true);
  assert.equal(finish.structuredContent.data.code, 'VERIFICATION_FAILED');
  assert.equal(calls.finish.length, 0);
});

test('unknown ego outcome is never re-dispatched under a repeated or new write request', async t => {
  const { adapter, calls } = makeAdapter({
    async run(options) {
      calls.run.push(options);
      return { state: 'outcome_unknown', result: null, spaceId: 52, executionStopped: false,
        error: { code: 'EGO_TIMEOUT', message: 'late effect possible' } };
    },
    async recover(execution) {
      calls.recover.push(execution);
      return { state: 'outcome_unknown', spaceId: 52, executionStopped: false,
        error: { code: 'EGO_INTERRUPTED', message: 'still unresolved' } };
    },
  });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'b', goal: 'Possibly save',
    url: 'http://127.0.0.1:43127/customers', criteria: [] } })).structuredContent.data;
  const request = { runId: run.runId, requestId: 'ambiguous-write', purpose: 'execute', code: 'return { attempted: true };' };
  const first = (await client.callTool({ name: 'browser_run', arguments: request })).structuredContent.data;
  const settled = await waitForExecution(client, run.runId, first.executionId);
  assert.equal(settled.state, 'outcome_unknown');
  const repeat = (await client.callTool({ name: 'browser_run', arguments: request })).structuredContent.data;
  assert.equal(repeat.executionId, first.executionId);
  assert.equal(calls.run.length, 1);
  const blocked = await client.callTool({ name: 'browser_run', arguments: { ...request, requestId: 'new-write' } });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.data.code, 'OUTCOME_UNKNOWN');
  assert.equal(calls.run.length, 1);
});

test('a stopped unknown execution can be resolved only with a later observation', async t => {
  let round = 0;
  const { adapter, calls } = makeAdapter({
    async run(options) {
      calls.run.push(options);
      round++;
      if (round === 1) return { state: 'outcome_unknown', spaceId: 62, executionStopped: true,
        error: { code: 'EGO_RESULT_MISSING', message: 'process stopped without result' } };
      return { state: 'succeeded', result: { customer: { code: 'C-1001' } }, spaceId: 62, executionStopped: true };
    },
  });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'b', goal: 'Save and verify',
    url: 'http://127.0.0.1:43127/customers', criteria: [{ id: 'customer', path: 'customer.code', equals: 'C-1001' }] } })).structuredContent.data;
  const ambiguous = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'write',
    purpose: 'execute', code: 'return { write: true };' } })).structuredContent.data;
  const unknown = await waitForExecution(client, run.runId, ambiguous.executionId);
  assert.equal(unknown.state, 'outcome_unknown');
  assert.equal(unknown.executionStopped, true);
  const tooEarly = await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'resolve-too-early',
    purpose: 'observe', code: 'return { customer: { code: "C-1001" } };',
    resolutions: [{ executionId: ambiguous.executionId, observationId: 'not-yet-observed', note: 'too early' }] } });
  assert.equal(tooEarly.isError, true);
  assert.equal(tooEarly.structuredContent.data.code, 'INVALID_RESOLUTION');
  assert.equal(calls.run.length, 1, 'invalid resolution is rejected before dispatch');

  const observation = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'observe-after-unknown',
    purpose: 'observe', code: 'return { customer: { code: "C-1001" } };' } })).structuredContent.data;
  const observed = await waitForExecution(client, run.runId, observation.executionId);
  assert.equal(observed.state, 'succeeded');
  const resolutionRound = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'resolve-unknown',
    purpose: 'observe', code: 'return { customer: { code: "C-1001" } };',
    resolutions: [{ executionId: ambiguous.executionId, observationId: observed.observationId,
      note: 'A later read confirmed the target customer record.' }] } })).structuredContent.data;
  const resolvedObservation = await waitForExecution(client, run.runId, resolutionRound.executionId);
  const savedState = (await client.callTool({ name: 'run_get', arguments: { runId: run.runId } })).structuredContent.data;
  const resolved = savedState.executions.find(item => item.executionId === ambiguous.executionId);
  assert.deepEqual(resolved.resolution, { observationId: observed.observationId,
    note: 'A later read confirmed the target customer record.' });

  const finishArgs = { runId: run.runId, requestId: 'f', outcome: 'succeeded', decision: 'learned', note: 'Verified after unknown write.',
    verification: [{ criterionId: 'customer', observationId: resolvedObservation.observationId }],
    updates: [{ baseRevision: 0, entry: { key: 'customer-save', name: 'Save customer', summary: 'Save and verify a customer',
      url: 'http://127.0.0.1:43127/customers', scope: 'page', verification: 'verified', recipe: { verify: ['customer.code'] } } }],
  };
  const completed = (await client.callTool({ name: 'run_finish', arguments: finishArgs })).structuredContent.data;
  assert.equal(completed.feedback.resolvedUnknownExecutions.includes(ambiguous.executionId), true);
  assert.equal(calls.run.length, 3, 'the ambiguous write was never automatically repeated');
});

test('cleanup retry requires a known-stopped undispatched finish and a new request id', async t => {
  let finishAttempt = 0;
  const { adapter, calls } = makeAdapter({
    async finish(options) {
      calls.finish.push(options);
      finishAttempt++;
      return finishAttempt === 1
        ? { state: 'failed', executionStopped: true, finishDispatched: false,
          error: { code: 'EGO_START_FAILED', message: 'could not start cli' } }
        : { state: 'succeeded', executionStopped: true, finishDispatched: true };
    },
  });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'b', goal: 'Observe',
    url: 'http://127.0.0.1:43127/customers', criteria: [] } })).structuredContent.data;
  const observation = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'o',
    purpose: 'observe', code: 'return { page: "customers" };' } })).structuredContent.data;
  await waitForExecution(client, run.runId, observation.executionId);
  const finishArgs = { runId: run.runId, requestId: 'finish-first', outcome: 'failed', decision: 'no-change', note: 'Task failed.' };
  const failed = (await client.callTool({ name: 'run_finish', arguments: finishArgs })).structuredContent.data;
  assert.equal(failed.cleanup.state, 'failed');
  assert.equal(failed.cleanup.finishDispatched, false);
  const retry = (await client.callTool({ name: 'run_finish', arguments: { ...finishArgs, requestId: 'finish-retry', retryCleanup: true } })).structuredContent.data;
  assert.equal(retry.cleanup.state, 'succeeded');
  assert.equal(retry.state, 'failed');
  assert.equal(calls.finish.length, 2);
  assert.equal(retry.feedback.requestId, 'finish-first', 'cleanup retry preserves the frozen business feedback');
});

test('possibly dispatched cleanup is never retried automatically', async t => {
  const { adapter, calls } = makeAdapter({
    async finish(options) {
      calls.finish.push(options);
      return { state: 'outcome_unknown', executionStopped: false, finishDispatched: true,
        error: { code: 'EGO_TIMEOUT', message: 'cleanup may still be running' } };
    },
  });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'b', goal: 'Observe',
    url: 'http://127.0.0.1:43127/customers', criteria: [] } })).structuredContent.data;
  const observation = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'o',
    purpose: 'observe', code: 'return { page: "customers" };' } })).structuredContent.data;
  await waitForExecution(client, run.runId, observation.executionId);
  const finishArgs = { runId: run.runId, requestId: 'finish-first', outcome: 'failed', decision: 'no-change', note: 'Task failed.' };
  const finished = (await client.callTool({ name: 'run_finish', arguments: finishArgs })).structuredContent.data;
  assert.equal(finished.cleanup.state, 'outcome_unknown');
  const retry = await client.callTool({ name: 'run_finish', arguments: { ...finishArgs, requestId: 'finish-retry', retryCleanup: true } });
  assert.equal(retry.isError, true);
  assert.equal(retry.structuredContent.data.code, 'CLEANUP_OUTCOME_UNKNOWN');
  assert.equal(calls.finish.length, 1);
});

test('network and DOM evidence returned by a script appear in trace and API projections', async t => {
  const { adapter, calls } = makeAdapter({
    async run(options) {
      calls.run.push(options);
      return { state: 'succeeded', spaceId: 71, executionStopped: true, result: { saved: true, evidence: [
        { kind: 'network', payload: { requestId: 'req-1', method: 'GET', url: 'http://127.0.0.1:43127/api/customers/C-1001', status: 200 } },
        { kind: 'dom', payload: { type: 'dom-change', selector: '#status', text: 'Saved' } },
      ] } };
    },
  });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'b', goal: 'Inspect evidence',
    url: 'http://127.0.0.1:43127/customers', criteria: [] } })).structuredContent.data;
  const invocation = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'o',
    purpose: 'observe', code: 'return { saved: true };' } })).structuredContent.data;
  await waitForExecution(client, run.runId, invocation.executionId);
  const trace = (await client.callTool({ name: 'evidence_query', arguments: { runId: run.runId, view: 'trace' } })).structuredContent.data;
  assert.equal(trace.projection.network.length, 1);
  assert.equal(trace.projection.dom.length, 1);
  const api = (await client.callTool({ name: 'evidence_query', arguments: { runId: run.runId, view: 'api' } })).structuredContent.data;
  assert.equal(api.projection.endpoints.length, 1);
  assert.equal(api.projection.endpoints[0].method, 'GET');
  assert.equal(api.projection.endpoints[0].pathname, '/api/customers/C-1001');
});

test('browser code contract failures return structured issues before execution dispatch', async t => {
  const dataDir = temporaryDirectory();
  const { adapter, calls } = makeAdapter();
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'begin-contract', goal: 'Inspect a customer page',
    url: 'http://127.0.0.1:43127/customers', criteria: [] } })).structuredContent.data;

  const domGlobal = await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'node-dom',
    purpose: 'observe', code: 'return { title: document.title };' } });
  assert.equal(domGlobal.isError, true);
  assert.equal(domGlobal.structuredContent.data.code, 'EGO_PROGRAM_CONTRACT');
  assert.equal(domGlobal.structuredContent.data.issues[0].code, 'EGO_NODE_CONTEXT');
  assert.equal(calls.run.length, 0);

  const unsupportedOption = await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'bad-fill-option',
    purpose: 'execute', code: 'await page.fill("#amount", "10", { label: "fill amount" });' } });
  assert.equal(unsupportedOption.isError, true);
  assert.equal(unsupportedOption.structuredContent.data.code, 'EGO_PROGRAM_CONTRACT');
  assert.ok(unsupportedOption.structuredContent.data.issues.some(issue => issue.code === 'EGO_API_CONTRACT'));
  assert.equal(calls.run.length, 0, 'preflight failure does not dispatch a business action');

  const accepted = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId: 'valid-observe',
    purpose: 'observe', code: 'return await page.evaluate(() => ({ title: document.title }));' } })).structuredContent.data;
  await waitForExecution(client, run.runId, accepted.executionId);
  assert.equal(calls.run.length, 1, 'a valid Page evaluate callback remains executable after rejection');
});

test('stale reference failures return a recovery hint without replaying the failed write', async t => {
  const dataDir = temporaryDirectory();
  const { adapter, calls } = makeAdapter({
    async run(options) {
      calls.run.push(options);
      return { state: 'failed', result: null, spaceId: 91, executionStopped: true,
        error: { code: 'EGO_STALE_REF', message: 'Unknown ref: 857; take a new snapshot' } };
    },
  });
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'begin-recovery', goal: 'Select a customer',
    url: 'http://127.0.0.1:43127/customers', criteria: [] } })).structuredContent.data;
  const args = { runId: run.runId, requestId: 'failed-click', purpose: 'execute', code: 'await page.click("@857");' };
  const first = (await client.callTool({ name: 'browser_run', arguments: args })).structuredContent.data;
  const settled = await waitForExecution(client, run.runId, first.executionId);
  assert.equal(settled.state, 'failed');
  assert.deepEqual(settled.recovery, { kind: 'refresh-snapshot',
    next: 'Take a fresh page.snapshot() on the observed Page; choose refs from that snapshot before acting.' });

  const repeated = (await client.callTool({ name: 'browser_run', arguments: args })).structuredContent.data;
  assert.equal(repeated.executionId, first.executionId);
  assert.equal(calls.run.length, 1, 'recovery advice does not replay an action');
});

test('ego CLI launch failures are definite pre-start failures and do not masquerade as unknown browser effects', async () => {
  const dataDir = temporaryDirectory();
  const adapter = new EgoAdapter({ command: path.join(dataDir, 'missing-ego-browser.exe') });
  const result = await adapter.run({ runId: 'run-1', executionId: 'execution-1', name: 'browser-ai:test',
    purpose: 'execute', code: 'throw new Error("must not run");', directory: path.join(dataDir, 'execution-1') });
  assert.equal(result.state, 'failed');
  assert.equal(result.executionStarted, false);
  assert.equal(result.executionStopped, true);
  assert.equal(result.error.executionStarted, false);
  assert.equal(adapter.children.size, 0);

  const finish = await adapter.finish({ runId: 'run-1', executionId: 'finish-1', spaceId: 1,
    name: 'browser-ai:test', keep: [], directory: path.join(dataDir, 'finish-1') });
  assert.equal(finish.state, 'failed');
  assert.equal(finish.executionStarted, false);
  assert.equal(finish.finishDispatched, false);
  assert.equal(adapter.children.size, 0);
});


test('page memos match trusted page context across rounds and appear in finish feedback', async t => {
  const contexts = [
    { url: 'https://example.test/items#edit/1', dialogTitle: 'Edit item', pageLabel: 'main' },
    { url: 'https://example.test/items#edit/2', dialogTitle: 'Edit item details', pageLabel: 'main' },
    { url: 'https://other.test/items#edit/1', dialogTitle: 'Edit item', pageLabel: 'main' },
  ];
  const { adapter } = makeAdapter({ async run() {
    return { state: 'succeeded', result: { ok: true }, pageContext: contexts.shift(), spaceId: 100, executionStopped: true };
  } });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const url = 'https://example.test/items#edit/1';
  const seed = (key, match, verification = 'unverified', seedUrl = url) => service.memory.applyUpdates(
    { runId: 'seed', url: seedUrl }, [{ baseRevision: 0, entry: { key, name: key, summary: `Rule ${key}`,
      scope: 'page', url: seedUrl, match, verification } }], [], 'failed')[0];
  const stale = seed('stale', { path: '/items', hashPrefix: '#edit', dialogTitle: 'Edit item' }, 'stale');
  const wrongPath = seed('wrong-path', { path: '/elsewhere', dialogTitle: 'Edit item' });
  const wrongHash = seed('wrong-hash', { path: '/items', hashPrefix: '#view', dialogTitle: 'Edit item' });
  const foreign = seed('foreign', { path: '/items', hashPrefix: '#edit', dialogTitle: 'Edit item' }, 'unverified', 'https://other.test/items');
  const initial = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'seed-begin', goal: 'Learn rule', url, criteria: [] } })).structuredContent.data;
  const saved = await client.callTool({ name: 'run_finish', arguments: { runId: initial.runId, requestId: 'seed-finish',
    outcome: 'failed', decision: 'learned', note: 'Save a page rule.', updates: [{ baseRevision:  0, entry: {
      key: 'edit-dialog', name: 'Edit dialog', summary: 'Use the edit dialog', scope: 'page', url,
      match: { path: '/items', hashPrefix: '#edit', dialogTitle: 'Edit item' },
    } }] } });
  assert.equal(saved.isError, undefined, JSON.stringify(saved));
  const id = saved.structuredContent.data.feedback.changedMemoryIds[0];
  const stored = (await client.callTool({ name: 'memory_get', arguments: { memoryId: id } })).structuredContent.data;
  assert.deepEqual(stored.match, { path: '/items', hashPrefix: '#edit', dialogTitle: 'Edit item' });

  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'begin-context', goal: 'Unrelated task',
    url: 'https://example.test/start', criteria: [] } })).structuredContent.data;
  const execute = async requestId => {
    const invocation = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId, requestId,
      purpose: 'observe', code: 'return { ok: true };' } })).structuredContent.data;
    return waitForExecution(client, run.runId, invocation.executionId);
  };
  const first = await execute('first-context');
  assert.equal(first.pageMemos.length, 1);
  assert.deepEqual((({ id, summary, revision }) => ({ id, summary, revision }))(first.pageMemos[0]),
    { id, summary: 'Use the edit dialog', revision: 1 });
  const second = await execute('different-dialog');
  assert.deepEqual(second.pageMemos, []);
  const third = await execute('foreign-domain');
  assert.deepEqual(third.pageMemos, []);
  const finished = (await client.callTool({ name: 'run_finish', arguments: { runId: run.runId, requestId: 'finish-context',
    outcome: 'failed', decision: 'no-change', note: 'Observed page rules.' } })).structuredContent.data;
  assert.ok(finished.feedback.recalledMemoryIds.includes(id));
  for (const excluded of [stale, wrongPath, wrongHash, foreign]) assert.ok(!finished.feedback.recalledMemoryIds.includes(excluded));
});


test('run_begin recalls with at most 500 goal characters while preserving the full goal', async t => {
  const dataDir = temporaryDirectory();
  const service = createService({ dataDir, idFactory: identifiers() });
  t.after(() => { service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const searches = [];
  service.memory.search = query => { searches.push(query); return []; };
  const goal = 'x'.repeat(650);
  const run = service.begin({ requestId: 'long-goal', goal, url: 'https://example.test/', criteria: [] });
  assert.equal(searches[0].goal, goal.slice(0, 500));
  assert.equal(run.goal, goal);
  assert.equal(service.run(run.runId).goal, goal);
});

test('automatic request evidence is stored and referenced by a recipe draft', async t => {
  const request = { src: 'ego-page', netType: 'request', requestId: 'execution:1', tabId: 'main',
    method: 'POST', url: 'https://example.test/api/items', queryKeys: ['filter'],
    requestShape: { format: 'json', type: 'object', properties: { name: { type: 'string' } } }, t: 1 };
  const response = { src: 'ego-page', netType: 'response', requestId: 'execution:1', tabId: 'main',
    method: 'POST', url: request.url, queryKeys: request.queryKeys, status: 200, t: 2 };
  const { adapter } = makeAdapter({ async run() { return { state: 'succeeded', spaceId: 71, executionStopped: true,
    result: { ok: true }, networkCapture: { version: 1, source: 'ego-page', status: 'captured', capturedRequests: 1,
      gaps: [], records: [request, response] } }; } });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const run = (await client.callTool({ name: 'run_begin', arguments: { requestId: 'begin-network', goal: 'Inspect',
    url: 'https://example.test/', criteria: [] } })).structuredContent.data;
  const invocation = (await client.callTool({ name: 'browser_run', arguments: { runId: run.runId,
    requestId: 'observe-network', purpose: 'observe', code: 'return { ok: true };' } })).structuredContent.data;
  await waitForExecution(client, run.runId, invocation.executionId);
  const evidence = (await client.callTool({ name: 'evidence_query', arguments: { runId: run.runId, view: 'records' } })).structuredContent.data;
  const records = evidence.records.filter(record => record.kind === 'network');
  assert.equal(records.length, 2);
  const draft = (await client.callTool({ name: 'recipe_draft', arguments: { runId: run.runId,
    requestId: 'draft-network', name: 'Inspect items' } })).structuredContent.data;
  assert.equal(draft.requestEvidence.capturedRequests, 1);
  assert.equal(draft.requestEvidence.hasMore, false);
  assert.deepEqual(draft.requestEvidence.requests[0], { evidenceId: records[0].recordId,
    responseEvidenceId: records[1].recordId, executionId: invocation.executionId, method: 'POST', url: request.url,
    queryKeys: ['filter'], requestShape: request.requestShape, status: 200 });
});
