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

async function setup(t, statuses = ['matched', 'matched'], scoped = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-batch-test-'));
  const calls = [];
  let next = 0;
  const adapter = {
    async run(options) {
      calls.push(options);
      if (!options.code.includes('verifyBatchField')) return { state: 'succeeded', result: { saved: true }, spaceId: 41, executionStopped: true };
      const { index, target, previousRows, targets: manifest } = options.args;
      const status = statuses[index];
      const row = { index, ...target, fieldScope: target.fieldScope || 'header', status,
        actual: status === 'read_error' ? null : { bShowIt: status === 'mismatch' }, identity: { field: target.field } };
      const rows = [...(previousRows || []), row];
      const result = previousRows ? { rows, allSelectedFieldsMatch: rows.every(item => item.status === 'matched'), ...(rows.every(item => item.status === 'matched') ? { verifiedTargets: manifest } : {}) } : { row };
      return { state: 'succeeded', result, spaceId: 41, executionStopped: true };
    },
    async finish() { return { state: 'succeeded', executionStopped: true }; },
    async recover() { return null; },
  };
  const service = createService({ dataDir: directory, egoAdapter: adapter, idFactory: () => `id-${++next}`, waitMs: 5 });
  const server = createMcpServer(service);
  const client = new Client({ name: 'batch-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const targets = ['department', 'amount'].map(field => ({ templateId: '1', designerUrl: 'https://global.yonyoucloud.com/iuap-yonbuilder-designer/ucf-wh/designer/apps/quickdev/index.html#/onepage/design/a/PT1/ysmdd', field, expected: { bShowIt: false } }));
  const criteria = [{ id: 'all', path: 'allSelectedFieldsMatch', equals: true }, ...(scoped ? [{ id: 'scope', path: 'verifiedTargets', equals: targets }] : [])];
  const begin = await call('run_begin', { requestId: 'begin', goal: 'Verify fields', url: 'https://example.test/', domain_tag: '超级版和旗舰版', criteria });
  const runId = begin.structuredContent.data.runId;
  async function write(requestId) {
    const response = await call('browser_run', { runId, requestId, purpose: 'execute', code: 'return { saved: true };' });
    const executionId = response.structuredContent.data.executionId;
    for (let i = 0; i < 30; i++) {
      const current = await call('run_get', { runId, executionId });
      const execution = current.structuredContent.data.executions.find(item => item.executionId === executionId);
      if (execution && execution.state === 'succeeded') return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('write did not finish');
  }
  await write('write-1');
  return { call, calls, runId, write, targets };
}

test('batch reads every field after the write, returns observations and reuses identical requests', async t => {
  const { call, calls, runId, targets } = await setup(t);
  const args = { runId, requestId: 'batch', targets };
  const first = await call('asp_ui_template_verify_batch', args);
  assert.notEqual(first.isError, true, JSON.stringify(first.structuredContent));
  const result = first.structuredContent.data;
  assert.equal(result.allSelectedFieldsMatch, true);
  assert.equal(result.domain_tag, '超级版和旗舰版');
  assert.ok(result.observationId);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(row => row.actual), [{ bShowIt: false }, { bShowIt: false }]);
  assert.ok(result.rows.every(row => row.observationId));
  assert.deepEqual(calls.map(item => item.purpose), ['execute', 'observe', 'observe']);
  const retry = await call('asp_ui_template_verify_batch', args);
  assert.deepEqual(retry.structuredContent.data, result);
  assert.equal(calls.length, 3);
  const conflict = await call('asp_ui_template_verify_batch', { ...args, targets: targets.slice(0, 1) });
  assert.equal(conflict.isError, true);
  assert.match(JSON.stringify(conflict.structuredContent), /REQUEST_CONFLICT|different payload/i);
  assert.equal(calls.length, 3);
  const finish = await call('run_finish', { runId, requestId: 'finish', outcome: 'succeeded', decision: 'no-change', note: 'Verified all selected fields', verification: result.verification });
  assert.notEqual(finish.isError, true, JSON.stringify(finish.structuredContent));
});

test('batch never passes a mismatch or read error', async t => {
  for (const status of ['mismatch', 'read_error']) {
    const { call, runId, targets } = await setup(t, ['matched', status]);
    const response = await call('asp_ui_template_verify_batch', { runId, requestId: 'batch', targets });
    assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
    const result = response.structuredContent.data;
    assert.equal(result.allSelectedFieldsMatch, false);
    assert.equal(result.rows[1].status, status);
    assert.deepEqual(result.verification, []);
  }
});

test('batch evidence becomes stale after a later write', async t => {
  const { call, runId, targets, write } = await setup(t);
  const args = { runId, requestId: 'batch', targets };
  const first = await call('asp_ui_template_verify_batch', args);
  assert.notEqual(first.isError, true, JSON.stringify(first.structuredContent));
  await write('write-2');
  const stale = await call('asp_ui_template_verify_batch', args);
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.structuredContent), /BATCH_STALE/);
  const fresh = await call('asp_ui_template_verify_batch', { ...args, requestId: 'batch-2' });
  assert.notEqual(fresh.isError, true, JSON.stringify(fresh.structuredContent));
  assert.notEqual(fresh.structuredContent.data.observationId, first.structuredContent.data.observationId);
});


test('preregistered target scope rejects omissions and replacements and verifies the full list', async t => {
  const { call, calls, runId, targets } = await setup(t, ['matched', 'matched'], true);
  for (const altered of [targets.slice(0, 1), [targets[0], { ...targets[1], field: 'other' }]]) {
    const response = await call('asp_ui_template_verify_batch', { runId, requestId: `bad-${altered.length}-${altered.at(-1).field}`, targets: altered });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.structuredContent), /BATCH_SCOPE_MISMATCH/);
  }
  assert.equal(calls.length, 1);
  const response = await call('asp_ui_template_verify_batch', { runId, requestId: 'complete', targets });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(response.structuredContent.data.allSelectedFieldsMatch, true);
  assert.equal(response.structuredContent.data.verification.length, 2);
  const finish = await call('run_finish', { runId, requestId: 'finish', outcome: 'succeeded', verification: response.structuredContent.data.verification });
  assert.notEqual(finish.isError, true, JSON.stringify(finish.structuredContent));
});
