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

// Review history must never read a developer's live Telegram or follow-up database.
const reviewFixtures = temporaryDirectory();
process.env.TELEGRAM_REVIEW_DB = path.join(reviewFixtures, 'telegram.sqlite');
process.env.REVIEW_DB = path.join(reviewFixtures, 'review.sqlite');
test.after(() => fs.rmSync(reviewFixtures, { recursive: true, force: true }));

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

test('MCP exposes tools and completes a verified memory workflow with idempotent requests', async t => {
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
    'asp_ui_template_update_field', 'asp_ui_template_verify_batch', 'asp_workbench_open_node', 'asp_workbench_query_general_applications', 'asp_workbench_query_templates', 'browser_run', 'eval_packet', 'eval_pending', 'eval_session_context', 'eval_submit', 'evidence_query', 'memory_get', 'memory_search', 'recipe_draft', 'review_apply', 'review_history', 'review_improve', 'review_improvements', 'review_observe', 'run_begin', 'run_finish', 'run_get', 'run_summary',
    'yonbuilder_app_get', 'yonbuilder_app_list', 'yonbuilder_bizobj_list', 'yonbuilder_cli', 'yonbuilder_current_page',
    'yonbuilder_field_get', 'yonbuilder_field_preview', 'yonbuilder_field_set', 'yonbuilder_interaction_rule', 'yonbuilder_open', 'yonbuilder_page_list',
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

test('independent clients hand off, submit and retrieve a review with scoped evidence and idempotency', async t => {
  const dataDir = temporaryDirectory();
  const { adapter } = makeAdapter({ async run() { return { state: 'succeeded', spaceId: 41, executionStopped: true,
    result: { padding: 'x'.repeat(15000), customer: { code: 'C-1001' } } }; } });
  const executorService = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const executor = await withMcp(t, executorService);
  const reviewerService = createService({ dataDir, egoAdapter: adapter, idFactory: (() => { let n = 0; return () => `review-${++n}`; })(), waitMs: 5 });
  const reviewer = await withMcp(t, reviewerService);
  await reviewer.listTools();
  const call = (client, name, args) => client.callTool({ name, arguments: args });
  const data = response => { assert.notEqual(response.isError, true, JSON.stringify(response)); return response.structuredContent.data; };
  const begin = async requestId => data(await call(executor, 'run_begin', { requestId, goal: 'Inspect customer',
    url: 'https://example.test/customers', criteria: [{ id: ' customer ', path: 'customer.code', equals: 'C-1001' }] }));
  const observe = async run => {
    const started = data(await call(executor, 'browser_run', { runId: run.runId, requestId: `observe-${run.runId}`,
      purpose: 'observe', code: 'return { customer: { code: "C-1001" } };' }));
    return waitForExecution(executor, run.runId, started.executionId);
  };
  const run = await begin('eval-begin');
  const other = await begin('other-begin');
  const observation = await observe(run);
  const foreign = await observe(other);
  const extra = data(await call(executor, 'browser_run', { runId: run.runId, requestId: 'extra-observe', purpose: 'observe', code: 'return { ok: true };' }));
  await waitForExecution(executor, run.runId, extra.executionId);
  assert.equal(data(await call(reviewer, 'run_get', { runId: run.runId })).reviewState, 'not_ready');
  const finished = data(await call(executor, 'run_finish', { runId: run.runId, requestId: ' handoff ', outcome: 'succeeded',
    note: 'Customer observed.', verification: [{ criterionId: ' customer ', observationId: observation.observationId }] }));
  assert.equal(finished.reviewState, 'pending');
  assert.equal(finished.feedback.decision, 'no-change');
  const pending = data(await call(reviewer, 'eval_pending', { limit: 1 }));
  assert.equal(pending.runs[0].runId, run.runId);
  const packet = data(await call(reviewer, 'eval_packet', { runId: run.runId, limit: 1 }));
  assert.equal(packet.reviewKey, ' handoff ');
  assert.equal(packet.readbacks[0].actual, 'C-1001');
  assert.equal(packet.hasMore, true);
  const missingKey = await call(reviewer, 'eval_packet', { runId: run.runId, cursor: packet.nextCursor, limit: 1 });
  assert.equal(missingKey.isError, true);
  assert.equal(missingKey.structuredContent.data.code, 'EVAL_STALE');
  const next = data(await call(reviewer, 'eval_packet', { runId: run.runId, cursor: packet.nextCursor, limit: 1, reviewKey: packet.reviewKey }));
  assert.equal(next.rounds[0].executionId, extra.executionId);
  assert.equal(packet.rounds[0].observationId, observation.observationId);
  const submission = { runId: run.runId, requestId: 'review-request', reviewKey: packet.reviewKey,
    reviewerModel: 'independent-model', verdict: 'pass', criterionResults: [{ criterionId: ' customer ', verdict: 'met',
      reason: 'Observed the customer code.', evidenceIds: [observation.observationId] }],
    evidenceIds: [observation.observationId], summary: { result: 'Customer verified.' },
    memory: { problem_id: 'customer-lookup', context: 'Customer search', rationale: 'Verify lookup',
      prediction: 'Customer can be found', metric: 'Lookup success', evidence: 'Customer observation' } };
  submission.toolChoice = { status: 'improvable', reason: 'The first lookup already returned the customer.',
    alternative: 'Use the first lookup result for verification.', evidenceIds: [observation.observationId] };
  const invalidRoute = await call(reviewer, 'eval_submit', { ...submission, requestId: 'foreign-route',
    toolChoice: { ...submission.toolChoice, evidenceIds: [foreign.observationId] } });
  assert.equal(invalidRoute.structuredContent.data.code, 'EVAL_EVIDENCE');
  const wrongEvidence = await call(reviewer, 'eval_submit', { ...submission, requestId: 'foreign',
    evidenceIds: [foreign.observationId], criterionResults: [{ ...submission.criterionResults[0], evidenceIds: [foreign.observationId] }] });
  assert.equal(wrongEvidence.isError, true);
  assert.equal(wrongEvidence.structuredContent.data.code, 'EVAL_EVIDENCE');
  const evidence = data(await call(reviewer, 'evidence_query', { runId: run.runId, view: 'records' }));
  const selfReport = evidence.records.find(record => record.kind === 'incident').recordId;
  const unsupported = await call(reviewer, 'eval_submit', { ...submission, requestId: 'self-report', evidenceIds: [selfReport],
    criterionResults: [{ ...submission.criterionResults[0], evidenceIds: [selfReport] }] });
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.structuredContent.data.code, 'EVAL_EVIDENCE');
  const stale = await call(reviewer, 'eval_submit', { ...submission, requestId: 'stale', reviewKey: 'old-handoff' });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.data.code, 'EVAL_STALE');
  const review = data(await call(reviewer, 'eval_submit', submission));
  assert.deepEqual(data(await call(reviewer, 'eval_submit', submission)), review);
  const conflict = await call(reviewer, 'eval_submit', { ...submission, summary: { result: 'Different result.' } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.data.code, 'REQUEST_CONFLICT');
  const duplicate = await call(reviewer, 'eval_submit', { ...submission, requestId: 'another-review' });
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.data.code, 'EVAL_ALREADY_SUBMITTED');
  const summary = data(await call(executor, 'run_summary', { runId: run.runId }));
  assert.equal(summary.reviewState, 'reviewed');
  assert.deepEqual(summary.review, review);
  assert.equal(review.verdict, 'pass');
  assert.deepEqual(review.toolChoice, submission.toolChoice);
  const history = data(await call(reviewer, 'review_history', { problem_id: 'customer-lookup' }));
  const attempt = history.problems[0].attempts.find(item => item.attempt_id === review.reviewId);
  assert.equal(attempt.source, 'browser');
  assert.deepEqual(attempt.assessment.toolChoice, submission.toolChoice);
  assert.equal(attempt.memory.prediction, 'Customer can be found');
  assert.deepEqual(attempt.observations, []);
  assert.equal(data(await call(executor, 'run_get', { runId: run.runId })).reviewState, 'reviewed');
  assert.equal(data(await call(reviewer, 'eval_pending', {})).runs.some(item => item.runId === run.runId), false);
});

test('review lessons are recalled for similar goals on the same origin in later runs', async t => {
  const { adapter } = makeAdapter();
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const url = 'https://example.test/customers';
  const goal = 'Create customer record';
  const initial = await call('run_begin', { requestId: 'lesson-begin', url, goal, criteria: [] });
  assert.deepEqual(initial.recalledMemory.reviewLessons, []);
  const execution = await call('browser_run', { runId: initial.runId, requestId: 'lesson-observe',
    purpose: 'observe', code: 'return { ok: true };' });
  const observation = await waitForExecution(client, initial.runId, execution.executionId);
  await call('run_finish', { runId: initial.runId, requestId: 'lesson-finish', outcome: 'failed', note: 'Save failed.' });
  const review = await call('eval_submit', { runId: initial.runId, requestId: 'lesson-review', reviewKey: 'lesson-finish',
    reviewerModel: 'reviewer', verdict: 'fail', criterionResults: [], evidenceIds: [observation.observationId],
    summary: { result: 'Save failed.', lessons: ['Check the customer form before saving.'], limitations: ['Save was not verified.'] } });
  const expected = { sourceRunId: initial.runId, reviewId: review.reviewId, goal, verdict: 'fail',
    lessons: ['Check the customer form before saving.'], limitations: ['Save was not verified.'], truncated: false };
  const search = await call('memory_search', { url, goal: 'Create customer record' });
  assert.deepEqual(search.reviewLessons, [expected]);
  assert.equal(search.matches.some(item => item.sourceRunId === initial.runId && item.verification === 'verified'), false);
  assert.deepEqual((await call('memory_search', { url, goal: 'Inspect inventory stock' })).reviewLessons, []);
  assert.deepEqual((await call('memory_search', { url: 'https://other.test/customers', goal })).reviewLessons, []);
  assert.deepEqual((await call('memory_search', { url: 'http://example.test/customers', goal })).reviewLessons, []);
  const later = await call('run_begin', { requestId: 'later-begin', url, goal, criteria: [] });
  assert.deepEqual(later.recalledMemory.reviewLessons, [expected]);

  const uncertain = await call('run_begin', { requestId: 'uncertain-begin', url, goal: 'Inspect inventory stock', criteria: [] });
  await call('run_finish', { runId: uncertain.runId, requestId: 'uncertain-finish', outcome: 'unknown', note: 'Outcome unknown.' });
  const uncertainReview = await call('eval_submit', { runId: uncertain.runId, requestId: 'uncertain-review', reviewKey: 'uncertain-finish',
    reviewerModel: 'reviewer', verdict: 'insufficient_evidence', criterionResults: [], evidenceIds: [],
    summary: { result: 'Outcome unknown.', lessons: ['Obtain a readback.'], limitations: ['No readback available.'] } });
  const uncertainSearch = await call('memory_search', { url, goal: 'Inspect inventory stock' });
  assert.deepEqual(uncertainSearch.reviewLessons, [{ sourceRunId: uncertain.runId, reviewId: uncertainReview.reviewId,
    goal: 'Inspect inventory stock', verdict: 'insufficient_evidence', lessons: ['Obtain a readback.'],
    limitations: ['No readback available.'], truncated: false }]);
  assert.equal(uncertainSearch.matches.some(item => item.sourceRunId === uncertain.runId && item.verification === 'verified'), false);
  await call('run_finish', { runId: uncertain.runId, requestId: 'new-handoff', outcome: 'unknown', note: 'Still unknown.' });
  assert.deepEqual((await call('memory_search', { url, goal: 'Inspect inventory stock' })).reviewLessons, []);
});

test('preregistered prediction survives handoff and cannot be rewritten in the review', async t => {
  const { adapter } = makeAdapter();
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const data = response => { assert.notEqual(response.isError, true, JSON.stringify(response)); return response.structuredContent.data; };
  const memory = { problem_id: 'preregistered', context: 'Fixture', rationale: 'Reason',
    prediction: 'Expected result', metric: 'Result count', evidence: 'Initial evidence' };
  const run = data(await call('run_begin', { requestId: 'preregister', goal: 'Inspect',
    url: 'https://example.test/', criteria: [], reviewMemory: memory }));
  data(await call('run_finish', { runId: run.runId, requestId: 'preregister-finish', outcome: 'unknown', note: 'Unknown' }));
  assert.deepEqual(data(await call('eval_packet', { runId: run.runId })).reviewMemory, memory);
  const submission = { runId: run.runId, requestId: 'preregister-submit', reviewKey: 'preregister-finish',
    reviewerModel: 'reviewer', verdict: 'insufficient_evidence', criterionResults: [], evidenceIds: [], summary: { result: 'Unknown' } };
  const conflict = await call('eval_submit', { ...submission, memory: { ...memory, prediction: 'Different' } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.data.code, 'EVAL_MEMORY_CONFLICT');
  const review = data(await call('eval_submit', submission));
  assert.deepEqual(review.memory, memory);
  assert.equal(review.memoryOrigin, 'run_begin');
});

test('legacy unknown handoff with a later execution is not queued for review', async t => {
  const { adapter } = makeAdapter();
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const invoke = (name, args) => client.callTool({ name, arguments: args });
  const run = (await invoke('run_begin', { requestId: 'legacy-begin', goal: 'Inspect', url: 'https://example.test/', criteria: [] })).structuredContent.data;
  const finish = await invoke('run_finish', { runId: run.runId, requestId: 'legacy-finish', outcome: 'unknown', note: 'Unknown.' });
  assert.notEqual(finish.isError, true, JSON.stringify(finish));
  const later = (await invoke('browser_run', { runId: run.runId, requestId: 'legacy-later', purpose: 'observe', code: 'return { ok: true };' })).structuredContent.data;
  await waitForExecution(client, run.runId, later.executionId);
  const legacy = service.run(run.runId);
  delete legacy.feedback.sequence;
  service.store.put('run', run.runId, legacy);
  assert.equal((await invoke('run_get', { runId: run.runId })).structuredContent.data.reviewState, 'not_ready');
  const pending = (await invoke('eval_pending', {})).structuredContent.data;
  assert.equal(pending.runs.some(item => item.runId === run.runId), false);
});

test('idle active and needs-verification runs receive an idempotent automatic review handoff', async t => {
  let now = Date.UTC(2026, 10, 25, 0, 0, 0);
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: makeAdapter().adapter,
    idFactory: identifiers(), clock: () => now, waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const active = await call('run_begin', { requestId: 'idle-active-begin', goal: 'Inspect active run',
    url: 'https://example.test/active', criteria: [] });
  const blocked = await call('run_begin', { requestId: 'idle-blocked-begin', goal: 'Inspect blocked run',
    url: 'https://example.test/blocked', criteria: [] });
  const oldBlocked = service.run(blocked.runId);
  oldBlocked.state = 'needs_verification';
  oldBlocked.outcome = 'unknown';
  oldBlocked.updatedAt = now - 31 * 60 * 1000;
  service.store.put('run', blocked.runId, oldBlocked);

  now += 31 * 60 * 1000;
  const pending = await call('eval_pending');
  const rows = new Map(pending.runs.map(run => [run.runId, run]));
  assert.ok(rows.has(active.runId));
  assert.ok(rows.has(blocked.runId));
  const activePacket = await call('eval_packet', { runId: active.runId });
  const blockedPacket = await call('eval_packet', { runId: blocked.runId });
  assert.equal(activePacket.executionOutcome, 'unknown');
  assert.equal(blockedPacket.executionOutcome, 'unknown');
  assert.equal(service.run(active.runId).state, 'active');
  assert.equal(service.run(blocked.runId).state, 'needs_verification');

  const repeated = await call('eval_pending');
  assert.equal(repeated.runs.find(run => run.runId === active.runId).reviewKey, activePacket.reviewKey);
  assert.equal(repeated.runs.find(run => run.runId === blocked.runId).reviewKey, blockedPacket.reviewKey);
  assert.equal(service.run(active.runId).updatedAt, active.updatedAt);
  assert.equal(service.run(blocked.runId).updatedAt, oldBlocked.updatedAt);
});

test('awaiting-user runs are handed off immediately and explicit unknown finish replaces the automatic handoff', async t => {
  const { adapter } = makeAdapter({ async run() {
    return { state: 'failed', executionStopped: true, spaceId: null,
      error: { code: 'USER_IN_CONTROL', message: 'Waiting for user confirmation.' } };
  } });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter,
    idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const run = await call('run_begin', { requestId: 'awaiting-user-begin', goal: 'Wait for confirmation',
    url: 'https://example.test/confirm', criteria: [] });
  const started = await call('browser_run', { runId: run.runId, requestId: 'awaiting-user-action',
    purpose: 'execute', code: 'return { waiting: true };' });
  await waitForExecution(client, run.runId, started.executionId);
  assert.equal(service.run(run.runId).state, 'awaiting_user');

  const first = await call('eval_pending');
  const automatic = first.runs.find(item => item.runId === run.runId);
  assert.ok(automatic, 'awaiting_user is immediately reviewable');
  const packet = await call('eval_packet', { runId: run.runId, reviewKey: automatic.reviewKey });
  const repeated = await call('eval_pending');
  assert.equal(repeated.runs.find(item => item.runId === run.runId).reviewKey, automatic.reviewKey);

  const finished = await call('run_finish', { runId: run.runId, requestId: 'explicit-unknown-finish',
    outcome: 'unknown', note: 'Waiting for explicit user confirmation.' });
  assert.equal(finished.feedback.requestId, 'explicit-unknown-finish');
  assert.equal(service.run(run.runId).state, 'awaiting_user', 'unknown handoff must preserve the resume gate');
  const refreshed = await call('eval_pending');
  assert.equal(refreshed.runs.find(item => item.runId === run.runId).reviewKey, 'explicit-unknown-finish');
  const stale = await client.callTool({ name: 'eval_packet', arguments: { runId: run.runId, reviewKey: packet.reviewKey } });
  assert.equal(stale.isError, true);
});

test('a new execution sequence invalidates an automatic review packet', async t => {
  let now = Date.UTC(2026, 10, 25, 1, 0, 0);
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: makeAdapter().adapter,
    idFactory: identifiers(), clock: () => now, waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const run = await call('run_begin', { requestId: 'resume-invalidation-begin', goal: 'Check resume invalidation',
    url: 'https://example.test/resume', criteria: [] });
  now += 31 * 60 * 1000;
  const handoff = (await call('eval_pending')).runs.find(item => item.runId === run.runId);
  assert.ok(handoff);
  const packet = await call('eval_packet', { runId: run.runId, reviewKey: handoff.reviewKey });
  assert.equal(packet.reviewKey, handoff.reviewKey);

  await call('browser_run', { runId: run.runId, requestId: 'resume-after-handoff', purpose: 'observe',
    code: 'return { resumed: true };' });
  const refreshedRun = service.run(run.runId);
  now = refreshedRun.updatedAt + 31 * 60 * 1000;
  const stale = await client.callTool({ name: 'eval_packet', arguments: { runId: run.runId, reviewKey: handoff.reviewKey } });
  assert.equal(stale.isError, true, 'the old packet must not remain submit-ready after sequence advances');
  assert.equal(service.reviewState(refreshedRun), 'not_ready');
});

test('review lessons follow the ASP edition across environments and isolate other editions', async t => {
  const { adapter } = makeAdapter();
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const tag = '超级版和旗舰版';
  const url = 'https://asp-a.example.test/expense';
  const goal = 'Configure expense control';
  const run = await call('run_begin', { requestId: 'edition-start', url, goal, criteria: [], domain_tag: tag });
  assert.equal(run.domain_tag, tag);
  await call('run_finish', { runId: run.runId, requestId: 'edition-finish', outcome: 'unknown', note: 'Fixture.' });
  assert.equal((await call('eval_packet', { runId: run.runId })).domain_tag, tag);
  const review = await call('eval_submit', { runId: run.runId, requestId: 'edition-review', reviewKey: 'edition-finish',
    domain_tag: tag, reviewerModel: 'reviewer', verdict: 'insufficient_evidence', criterionResults: [], evidenceIds: [],
    summary: { result: 'Unknown', lessons: ['Check configuration'], limitations: ['No readback'] } });
  assert.equal(review.domain_tag, tag);
  assert.equal((await call('run_summary', { runId: run.runId })).domain_tag, tag);
  const same = await call('memory_search', { url: 'https://asp-b.example.test/expense', goal, domain_tag: tag });
  assert.equal(same.reviewLessons[0].reviewId, review.reviewId);
  assert.deepEqual((await call('memory_search', { url, goal, domain_tag: '其他版本' })).reviewLessons, []);
  assert.deepEqual((await call('memory_search', { url, goal })).reviewLessons, []);
  const later = await call('run_begin', { requestId: 'edition-later', url: 'https://asp-b.example.test/expense', goal, criteria: [], domain_tag: tag });
  assert.equal(later.recalledMemory.reviewLessons[0].reviewId, review.reviewId);
});

test('Toolkit central eval actions read and submit a Browser handoff offline', async t => {
  const app = process.env.YONCLAW_TOOLKIT_APP || '/home/ubuntu/yonclaw-toolkit/runtime/app.py';
  if (!fs.existsSync(app)) return t.skip('Toolkit runtime unavailable');
  const { spawnSync } = require('node:child_process');
  const dataDir = temporaryDirectory();
  const { adapter } = makeAdapter();
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const provider = path.resolve(__dirname, '../scripts/review-provider.js');
  const db = path.join(dataDir, 'tasks.sqlite');
  const central = (action, args) => {
    const proc = spawnSync('python3', [app, '--db', db, 'call', action], {
      input: JSON.stringify(args), encoding: 'utf8', env: { ...process.env, BROWSER_AI_DATA_DIR: dataDir,
        YONCLAW_BROWSER_REVIEW_PROVIDER: provider, YONCLAW_BROWSER_NODE: process.execPath },
    });
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout).data;
  };
  const run = await call('run_begin', { requestId: 'central-start', url: 'https://example.test/', goal: 'Inspect fixture', criteria: [], domain_tag: '超级版和旗舰版' });
  await call('run_finish', { runId: run.runId, requestId: 'central-finish', outcome: 'unknown', note: 'No readback.' });
  assert.ok(central('eval_pending', { domain_tag: '超级版和旗舰版' }).runs.some(item => item.runId === run.runId));
  assert.equal(central('eval_pending', { domain_tag: '其他版本' }).runs.some(item => item.runId === run.runId), false);
  const packet = central('eval_packet', { runId: run.runId });
  assert.equal(packet.reviewKey, 'central-finish');
  const review = central('eval_submit', { runId: run.runId, requestId: 'central-submit', reviewKey: packet.reviewKey,
    domain_tag: '超级版和旗舰版', reviewerModel: 'fixture-reviewer', verdict: 'insufficient_evidence', criterionResults: [], evidenceIds: [],
    summary: { result: 'Unknown', lessons: [], limitations: ['No readback'] } });
  assert.equal(review.runId, run.runId);
  assert.equal(central('run_summary', { runId: run.runId }).review.reviewId, review.reviewId);
  assert.ok(Array.isArray(central('evidence_query', { runId: run.runId, view: 'records' }).records));
  assert.equal(central('eval_pending', {}).runs.some(item => item.runId === run.runId), false);
});

test('embedded review toolkit supports session context and browser review observations without external checkout', async t => {
  const configured = Object.fromEntries(['BROWSER_AI_REVIEW_TOOLKIT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_SESSIONS_ROOT', 'APPDATA']
    .map(key => [key, process.env[key]]));
  delete process.env.BROWSER_AI_REVIEW_TOOLKIT;
  const dataDir = temporaryDirectory();
  const codexHome = path.join(dataDir, 'codex-home');
  const claudeHome = path.join(dataDir, 'claude-home');
  const dshRoot = path.join(dataDir, 'dsh-sessions');
  const appData = path.join(dataDir, 'appdata');
  Object.assign(process.env, { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
    DSH_SESSIONS_ROOT: dshRoot, APPDATA: appData });
  t.after(() => {
    for (const [key, value] of Object.entries(configured)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { adapter } = makeAdapter();
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const sessionPath = path.join(dataDir, 'session.jsonl');
  const sessionRows = [
    { type: 'message', role: 'user', text: 'Inspect fixture' },
    { type: 'message', role: 'assistant', text: 'Checked the fixture.' },
  ];
  fs.writeFileSync(sessionPath, `${sessionRows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const run = await call('run_begin', { requestId: 'embedded-review-start', url: 'https://example.test/', goal: 'Inspect fixture', criteria: [],
    sessionSource: { path: sessionPath, sessionId: 'fixture-session', startLine: 1 } });
  await call('run_finish', { runId: run.runId, requestId: 'embedded-review-finish', outcome: 'unknown', note: 'No business readback.' });
  assert.ok((await call('eval_pending', {})).runs.some(item => item.runId === run.runId));
  const packet = await call('eval_packet', { runId: run.runId });
  assert.deepEqual(packet.sessionSource, { path: sessionPath, sessionId: 'fixture-session', startLine: 1 });
  assert.match(packet.sessionSearch.instructions, /session ID/);
  for (const expected of [
    { client: 'Codex', path: path.join(codexHome, 'sessions') },
    { client: 'YonBuddy', path: path.join(appData, 'yonyou-bridge', 'codex-home', 'sessions') },
    { client: 'Claude Code', path: path.join(claudeHome, 'projects') },
    { client: 'DSH', path: dshRoot },
  ]) assert.ok(packet.sessionSearch.roots.some(root => root.client === expected.client && root.path === path.resolve(expected.path)),
    `missing ${expected.client} root ${expected.path}`);
  const review = await call('eval_submit', { runId: run.runId, requestId: 'embedded-review-submit', reviewKey: packet.reviewKey,
    reviewerModel: 'fixture-reviewer', verdict: 'insufficient_evidence', criterionResults: [], evidenceIds: [],
    summary: { result: 'Evidence is insufficient.', lessons: [], limitations: ['No business readback'] },
    sessionRefs: [{ path: sessionPath, sessionId: 'fixture-session', line: 1 }] });
  assert.deepEqual(review.sessionRefs, [{ path: sessionPath, sessionId: 'fixture-session', line: 1 }]);
  assert.match(review.deliveryHint, /PR/);
  const summaryReview = (await call('run_summary', { runId: run.runId })).review;
  assert.equal(summaryReview.reviewId, review.reviewId);
  assert.match(summaryReview.deliveryHint, /PR/);
  assert.equal((await call('eval_pending', {})).runs.some(item => item.runId === run.runId), false);
  const first = await call('eval_session_context', { path: sessionPath, startLine: 1, limit: 1 });
  assert.equal(first.records.length, 1);
  assert.deepEqual(first.records[0], { line: 1, record: sessionRows[0] });
  assert.equal(first.nextLine, 2);
  const second = await call('eval_session_context', { path: sessionPath, startLine: first.nextLine, limit: 1 });
  assert.deepEqual(second.records[0], { line: 2, record: sessionRows[1] });
  assert.equal(second.nextLine, null);

  const hktDate = new Date(review.submittedAt + 8 * 60 * 60 * 1000).toISOString();
  const observation = { day: hktDate.slice(0, 10), observed_at: `${hktDate.slice(0, -1)}+08:00`,
    version: 'fixture-v1', eligible: 1, affected: 0, finding: 'observed', evidence: 'session fixture lines 1-2' };
  const recorded = await call('review_observe', { attempt_id: review.reviewId, observation });
  const replayed = await call('review_observe', { attempt_id: review.reviewId, observation });
  assert.deepEqual({ source: recorded.source, recorded: recorded.recorded, replayed: recorded.replayed },
    { source: 'browser', recorded: 1, replayed: 0 });
  assert.deepEqual({ source: replayed.source, recorded: replayed.recorded, replayed: replayed.replayed },
    { source: 'browser', recorded: 0, replayed: 1 });
  const history = await call('review_history', { attempt_id: review.reviewId, source: 'browser' });
  assert.ok(JSON.stringify(history).includes('session fixture lines 1-2'));
});

test('improvement loop requires a version-matched linked pass and records fail/retry attempts', async t => {
  const { execFileSync } = require('node:child_process');
  const nativeRequest = { src: 'ego-page', netType: 'request', requestId: 'fixture-http-1', tabId: 'main',
    method: 'POST', url: 'https://example.test/api/items?filter=open', queryKeys: ['filter'], t: 1 };
  const requestCapture = () => ({ version: 1, source: 'ego-page', status: 'captured', capturedRequests: 1, gaps: [],
    records: [nativeRequest, { ...nativeRequest, netType: 'response', status: 200, t: 2 }] });
  const { adapter } = makeAdapter({
    async run(options) {
      const version = options.improvementVersion ?? options.improvement?.version ?? 'unlinked';
      return { state: 'succeeded', result: { saved: true, improvementVersion: version }, networkCapture: requestCapture(),
        spaceId: 41, executionStopped: true };
    },
  });
  const dataDir = temporaryDirectory();
  const artifactRepo = temporaryDirectory();
  t.after(() => fs.rmSync(artifactRepo, { recursive: true, force: true }));
  execFileSync('git', ['init', artifactRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', artifactRepo, 'config', 'user.name', 'Eval Fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', artifactRepo, 'config', 'user.email', 'eval-fixture@example.test'], { stdio: 'ignore' });
  const artifactPath = path.join(artifactRepo, 'scripts', 'verify-saved.js');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, 'module.exports = () => false;\n', 'utf8');
  execFileSync('git', ['-C', artifactRepo, 'add', 'scripts/verify-saved.js'], { stdio: 'ignore' });
  execFileSync('git', ['-C', artifactRepo, 'commit', '-m', 'fixture baseline', '-m', 'Submitted-by: Codex (GPT-6)'], { stdio: 'ignore' });
  fs.writeFileSync(artifactPath, 'module.exports = () => true;\n', 'utf8');
  execFileSync('git', ['-C', artifactRepo, 'add', 'scripts/verify-saved.js'], { stdio: 'ignore' });
  execFileSync('git', ['-C', artifactRepo, 'commit', '-m', 'fix saved indicator', '-m', 'Submitted-by: Codex (GPT-6)'], { stdio: 'ignore' });
  const version = execFileSync('git', ['-C', artifactRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const criterion = { id: 'saved', path: 'saved', equals: true };
  const sourceRun = await call('run_begin', { requestId: 'improve-source-start', url: 'https://example.test/',
    goal: 'Repair the saved indicator', criteria: [] });
  const sourceEvidence = await call('browser_run', { runId: sourceRun.runId, requestId: 'improve-source-observe',
    purpose: 'observe', code: 'return { saved: false };' });
  await waitForExecution(client, sourceRun.runId, sourceEvidence.executionId);
  await call('run_finish', { runId: sourceRun.runId, requestId: 'improve-source-finish', outcome: 'unknown', note: 'Initial evidence only.' });
  const sourcePacket = await call('eval_packet', { runId: sourceRun.runId });
  const sourceReview = await call('eval_submit', { runId: sourceRun.runId, requestId: 'improve-source-review',
    reviewKey: sourcePacket.reviewKey, reviewerModel: 'fixture-reviewer', verdict: 'insufficient_evidence',
    criterionResults: [], evidenceIds: [], summary: { result: 'Needs a reusable fix.', lessons: [], limitations: [] } });

  const planned = await call('review_improve', { reviewId: sourceReview.reviewId, requestId: 'improve-plan', kind: 'script',
    problemId: 'fixture-saved-indicator', change: 'Add a script regression check for the persisted saved indicator.', criterion });
  assert.equal(planned.state, 'planned');
  const applied = await call('review_apply', { improvementId: planned.improvementId, requestId: 'improve-apply',
    artifact: { repository: artifactRepo, commit: version, file: 'scripts/verify-saved.js' } });
  assert.equal(applied.state, 'applied');
  assert.equal(applied.artifact.version, version);
  const staleLink = await client.callTool({ name: 'run_begin', arguments: { requestId: 'stale-improvement-version',
    url: 'https://example.test/', goal: 'Verify old artifact', criteria: [criterion],
    improvement: { improvementId: planned.improvementId, version: 'c'.repeat(40) } } });
  assert.equal(staleLink.isError, true);
  assert.equal(staleLink.structuredContent.data.code, 'IMPROVEMENT_INVALID');

  const requestPlan = await call('review_improve', { reviewId: sourceReview.reviewId, requestId: 'request-improve-plan', kind: 'request',
    problemId: 'fixture-saved-indicator', change: 'Build the observed request with validated parameters.', criterion });
  const sourceRequest = (await call('evidence_query', { runId: sourceRun.runId, view: 'records' })).records
    .find(record => record.kind === 'network' && record.payload.netType === 'request');
  assert.ok(sourceRequest, 'source review must carry a captured request record');
  const callerOnlyEvidence = await client.callTool({ name: 'review_apply', arguments: { improvementId: requestPlan.improvementId,
    requestId: 'request-improve-apply', artifact: { repository: artifactRepo, commit: version,
      file: 'scripts/verify-saved.js', evidenceId: 'caller-asserted-request-id' } } });
  assert.equal(callerOnlyEvidence.isError, true);
  assert.equal(callerOnlyEvidence.structuredContent.data.code, 'IMPROVEMENT_ARTIFACT');
  const stillPlanned = (await call('review_improvements', { reviewId: sourceReview.reviewId })).items
    .find(row => row.improvementId === requestPlan.improvementId);
  assert.equal(stillPlanned.state, 'planned');
  const requestApplied = await call('review_apply', { improvementId: requestPlan.improvementId, requestId: 'request-improve-apply-valid',
    artifact: { repository: artifactRepo, commit: version, file: 'scripts/verify-saved.js', evidenceId: sourceRequest.recordId } });
  assert.equal(requestApplied.state, 'applied');
  assert.deepEqual({ method: requestApplied.artifact.request.method, url: requestApplied.artifact.request.url,
    queryKeys: requestApplied.artifact.request.queryKeys }, { method: 'POST', url: nativeRequest.url, queryKeys: ['filter'] });

  async function runReview(prefix, { linked = false, improvementId = planned.improvementId, linkedVersion = version,
    verdict = 'pass', adapterVersion = version } = {}) {
    adapter.run = async () => ({ state: 'succeeded', result: { saved: true, improvementVersion: adapterVersion },
      networkCapture: requestCapture(), spaceId: 41, executionStopped: true });
    const run = await call('run_begin', { requestId: `${prefix}-start`, url: 'https://example.test/',
      goal: 'Verify the saved indicator', criteria: [criterion],
      ...(linked ? { improvement: { improvementId, version: linkedVersion } } : {}) });
    const write = await call('browser_run', { runId: run.runId, requestId: `${prefix}-write`, purpose: 'execute', code: 'return { saved: true };' });
    await waitForExecution(client, run.runId, write.executionId);
    const observe = await call('browser_run', { runId: run.runId, requestId: `${prefix}-observe`, purpose: 'observe', code: 'return { saved: true };' });
    const observed = await waitForExecution(client, run.runId, observe.executionId);
    const outcome = verdict === 'pass' ? 'succeeded' : 'failed';
    const finish = await call('run_finish', { runId: run.runId, requestId: `${prefix}-finish`, outcome,
      ...(verdict === 'pass' ? { verification: [{ criterionId: criterion.id, observationId: observed.observationId }] } : {}),
      note: `Fixture ${verdict} review.` });
    const packet = await call('eval_packet', { runId: run.runId });
    await call('eval_submit', { runId: run.runId, requestId: `${prefix}-review`, reviewKey: packet.reviewKey,
      reviewerModel: 'fixture-reviewer', verdict, criterionResults: [{ criterionId: criterion.id,
        verdict: verdict === 'pass' ? 'met' : 'unmet', reason: `Fixture ${verdict}.`, evidenceIds: [observed.observationId] }],
      evidenceIds: [observed.observationId], summary: { result: `Fixture ${verdict}.`, lessons: [], limitations: [] } });
    return { run, finish };
  }

  // A matching independent pass on an unrelated run cannot verify this item.
  await runReview('unrelated-pass');
  let item = (await call('review_improvements', { reviewId: sourceReview.reviewId })).items.find(row => row.improvementId === planned.improvementId);
  assert.equal(item.state, 'applied');

  // A linked pass with a mismatched observed build version also remains applied.
  await runReview('wrong-version', { linked: true, adapterVersion: 'b'.repeat(40) });
  item = (await call('review_improvements', { reviewId: sourceReview.reviewId })).items.find(row => row.improvementId === planned.improvementId);
  assert.equal(item.state, 'applied');

  // A linked failure records an attempt but does not close the loop.
  await runReview('linked-failure', { linked: true, verdict: 'fail' });
  item = (await call('review_improvements', { reviewId: sourceReview.reviewId })).items.find(row => row.improvementId === planned.improvementId);
  assert.equal(item.state, 'applied');

  // Retrying the same improvement at the applied version with a met readback closes it.
  await runReview('linked-retry', { linked: true });
  item = (await call('review_improvements', { reviewId: sourceReview.reviewId })).items.find(row => row.improvementId === planned.improvementId);
  assert.equal(item.state, 'verified');
  assert.ok(item.attempts.length >= 3);

  await runReview('request-linked', { linked: true, improvementId: requestPlan.improvementId });
  const requestItem = (await call('review_improvements', { reviewId: sourceReview.reviewId })).items
    .find(row => row.improvementId === requestPlan.improvementId);
  assert.equal(requestItem.state, 'verified', 'request verification requires the fresh same-method, URL and query-key capture');
  assert.ok(requestItem.attempts[0].requestRecordId);
});

test('review submission can atomically plan a memory update and verifies its stored revision when used', async t => {
  const dataDir = temporaryDirectory();
  const { adapter } = makeAdapter({ async run() {
    return { state: 'succeeded', result: { saved: true }, spaceId: 41, executionStopped: true };
  } });
  const service = createService({ dataDir, egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const criterion = { id: 'saved', path: 'saved', equals: true };
  const source = await call('run_begin', { requestId: 'memory-source-start', url: 'https://example.test/',
    goal: 'Keep the saved indicator guidance current', criteria: [criterion] });
  const seedWrite = await call('browser_run', { runId: source.runId, requestId: 'memory-seed-write', purpose: 'execute', code: 'return { saved: true };' });
  await waitForExecution(client, source.runId, seedWrite.executionId);
  const seedObserve = await call('browser_run', { runId: source.runId, requestId: 'memory-seed-observe',
    purpose: 'observe', code: 'return { saved: true };' });
  const seedObserved = await waitForExecution(client, source.runId, seedObserve.executionId);
  const initial = await call('run_finish', { runId: source.runId, requestId: 'memory-source-finish', outcome: 'succeeded',
    decision: 'learned', note: 'Seed a reusable memory for the fixture.',
    verification: [{ criterionId: criterion.id, observationId: seedObserved.observationId }], updates: [{ baseRevision: 0,
      entry: { scope: 'domain', key: 'fixture-save-guidance', name: 'Fixture save guidance',
        summary: 'Initial guidance.', goal: 'Keep the saved indicator guidance current', verification: 'unverified' } }] });
  const memoryId = initial.feedback.changedMemoryIds[0];
  assert.ok(memoryId);
  const sourcePacket = await call('eval_packet', { runId: source.runId });
  const submitted = await call('eval_submit', { runId: source.runId, requestId: 'memory-source-review',
    reviewKey: sourcePacket.reviewKey, reviewerModel: 'fixture-reviewer', verdict: 'insufficient_evidence',
    criterionResults: [{ criterionId: criterion.id, verdict: 'insufficient_evidence',
      reason: 'The first run only seeds the memory example.', evidenceIds: [] }],
    evidenceIds: [], summary: { result: 'A memory update is needed.', lessons: [], limitations: [] },
    improvements: [{ kind: 'memory', problemId: 'fixture-saved-memory', change: 'Clarify how to verify the persisted saved indicator.',
      criterion }] });
  assert.equal(submitted.improvementIds.length, 1);
  const improvementId = submitted.improvementIds[0];
  let item = (await call('review_improvements', { reviewId: submitted.reviewId })).items
    .find(row => row.improvementId === improvementId);
  assert.equal(item.state, 'planned');

  const before = await call('memory_get', { memoryId });
  const applied = await call('review_apply', { improvementId, requestId: 'memory-apply',
    artifact: { memoryUpdate: { memoryId, baseRevision: before.revision, patch: { summary: 'Clarified guidance.' } } } });
  assert.equal(applied.state, 'applied');
  assert.equal(applied.artifact.memoryId, memoryId);
  const after = await call('memory_get', { memoryId });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.summary, 'Clarified guidance.');

  const run = await call('run_begin', { requestId: 'memory-verification-start', url: 'https://example.test/',
    goal: 'Verify saved indicator with updated guidance', criteria: [criterion], recipeIds: [memoryId],
    improvement: { improvementId, version: applied.artifact.version } });
  const write = await call('browser_run', { runId: run.runId, requestId: 'memory-verification-write', purpose: 'execute', code: 'return { saved: true };' });
  await waitForExecution(client, run.runId, write.executionId);
  const observe = await call('browser_run', { runId: run.runId, requestId: 'memory-verification-observe',
    purpose: 'observe', code: 'return { saved: true };' });
  const observed = await waitForExecution(client, run.runId, observe.executionId);
  await call('run_finish', { runId: run.runId, requestId: 'memory-verification-finish', outcome: 'succeeded',
    decision: 'confirmed', usedMemoryIds: [memoryId], verification: [{ criterionId: criterion.id, observationId: observed.observationId }],
    note: 'Observed the expected saved value using the updated memory.' });
  const packet = await call('eval_packet', { runId: run.runId });
  const review = await call('eval_submit', { runId: run.runId, requestId: 'memory-verification-review', reviewKey: packet.reviewKey,
    reviewerModel: 'fixture-reviewer', verdict: 'pass', criterionResults: [{ criterionId: criterion.id, verdict: 'met',
      reason: 'Independent readback matched.', evidenceIds: [observed.observationId] }], evidenceIds: [observed.observationId],
    summary: { result: 'The revised memory was used and the criterion passed.', lessons: [], limitations: [] } });
  assert.equal(review.improvementResult.accepted, true);
  item = (await call('review_improvements', { reviewId: submitted.reviewId })).items
    .find(row => row.improvementId === improvementId);
  assert.equal(item.state, 'verified');
  assert.equal(item.attempts[0].exposureConfirmed, true);
});

test('known historical ASP review is classified when an existing database is reopened', async t => {
  const { Store } = require('../src/storage');
  const dataDir = temporaryDirectory();
  const runId = '9f9cb9bd-7830-4cee-8cff-980262a3de50';
  const reviewId = '7d732627-a871-43e6-a706-56de49635276';
  const store = new Store(dataDir);
  store.put('run', runId, { runId, url: 'https://old.example.test/expense', goal: 'Configure expense control',
    state: 'completed', sequence: 1, reviewId, feedback: { requestId: 'old-handoff', sequence: 1, outcome: 'failed' } });
  store.put('evaluation', reviewId, { reviewId, runId, reviewKey: 'old-handoff', verdict: 'fail', submittedAt: 1,
    summary: { result: 'Failed', lessons: ['Review expense settings'], limitations: ['No verification'] } });
  store.close();
  const service = createService({ dataDir, idFactory: identifiers() });
  t.after(() => service.close());
  assert.equal(service.run(runId).domain_tag, '超级版和旗舰版');
  const recalled = service.searchMemory({ url: 'https://new.example.test/expense', goal: 'Configure expense control', domain_tag: '超级版和旗舰版' });
  assert.equal(recalled.reviewLessons[0].reviewId, reviewId);
});

test('tagged page procedures are recalled, confirmed and corrected across environments', async t => {
  const { adapter } = makeAdapter({ async run() { return { state: 'succeeded', result: {}, spaceId: 42,
    pageContext: { url: 'https://second.example.test/expense', pageLabel: 'main' }, executionStopped: true }; } });
  const service = createService({ dataDir: temporaryDirectory(), egoAdapter: adapter, idFactory: identifiers(), waitMs: 5 });
  const client = await withMcp(t, service);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.data;
  };
  const tag = '超级版和旗舰版';
  const first = await call('run_begin', { requestId: 'memo-start', goal: 'Configure expense',
    url: 'https://first.example.test/expense', criteria: [], domain_tag: tag });
  const learned = await call('run_finish', { runId: first.runId, requestId: 'memo-learn', outcome: 'failed',
    decision: 'learned', note: 'Save setup procedure', updates: [{ baseRevision: 0, entry: {
      scope: 'page', key: 'expense', name: 'Expense', summary: 'Same-edition setup', match: { path: '/expense' } } }] });
  const id = learned.feedback.changedMemoryIds[0];
  const url = 'https://second.example.test/expense';
  const search = await call('memory_search', { url, goal: 'Configure expense', domain_tag: tag });
  assert.equal(search.matches[0].id, id);
  assert.equal(search.matches[0].sourceOrigin, 'https://first.example.test');
  assert.deepEqual((await call('memory_search', { url, goal: 'Configure expense', domain_tag: '其他版本' })).matches, []);
  assert.deepEqual((await call('memory_search', { url, goal: 'Configure expense' })).matches, []);
  const next = await call('run_begin', { requestId: 'memo-next', goal: 'Configure expense', url, criteria: [], domain_tag: tag });
  const started = await call('browser_run', { runId: next.runId, requestId: 'memo-observe', purpose: 'observe', code: 'return {};' });
  const observed = await waitForExecution(client, next.runId, started.executionId);
  assert.equal(observed.pageMemos[0].id, id);
  const confirmed = await call('run_finish', { runId: next.runId, requestId: 'memo-confirm', outcome: 'failed',
    decision: 'confirmed', note: 'Used procedure', usedMemoryIds: [id] });
  assert.ok(confirmed.feedback.recalledMemoryIds.includes(id));
  const correctionRun = await call('run_begin', { requestId: 'memo-correct-start', goal: 'Configure expense', url, criteria: [], domain_tag: tag });
  const current = await call('memory_get', { memoryId: id });
  const corrected = await call('run_finish', { runId: correctionRun.runId, requestId: 'memo-correct', outcome: 'failed',
    decision: 'corrected', note: 'Update procedure', usedMemoryIds: [id], updates: [{ memoryId: id, baseRevision: current.revision,
      patch: { summary: 'Updated setup' } }] });
  assert.equal(corrected.feedback.changedMemoryIds[0], id);
  assert.equal((await call('memory_get', { memoryId: id })).summary, 'Updated setup');
});
