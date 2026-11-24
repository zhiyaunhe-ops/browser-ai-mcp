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

async function setup(t, { required = false, ambiguous = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-template-test-'));
  let next = 0;
  const calls = [];
  const identity = { templateId: 'template-1', templateName: 'General', transactionType: 'Travel', field: 'department', fieldName: 'Department' };
  const adapter = {
    async run(options) {
      const step = options.code.match(/workflow\.(locate|update|verify)\(/)[1];
      calls.push({ step, purpose: options.purpose });
      let result;
      if (step === 'locate') result = ambiguous
        ? { status: 'ambiguous_template', candidates: [{ templateId: 'template-1' }, { templateId: 'template-2' }] }
        : { ...identity, required, designerUrl: 'https://example.test/designer', pageLabel: 'p1' };
      if (step === 'update') { required = options.args.desired; result = { changed: true }; }
      if (step === 'verify') result = { ...identity, required };
      return { state: 'succeeded', result, spaceId: 41, executionStopped: true };
    },
    async finish() { return { state: 'succeeded', executionStopped: true }; },
    async recover() { return null; },
  };
  const service = createService({ dataDir: directory, egoAdapter: adapter, idFactory: () => `id-${++next}`, waitMs: 5 });
  const server = createMcpServer(service);
  const client = new Client({ name: 'asp-template-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { client, calls };
}

const args = { requestId: 'request-1', templateId: 'template-1', field: 'department', changes: { required: true } };
async function update(client) {
  const response = await client.callTool({ name: 'asp_ui_template_update_field', arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  return response.structuredContent.data;
}

test('MCP updates the field, independently reads it back, and does not rewrite on retry', async t => {
  const { client, calls } = await setup(t);
  const result = await update(client);
  assert.equal(result.status, 'updated');
  assert.equal(result.before, false);
  assert.equal(result.after, true);
  assert.equal(result.verified, true);
  assert.ok(result.observationId);
  assert.deepEqual(calls, [
    { step: 'locate', purpose: 'observe' },
    { step: 'update', purpose: 'execute' },
    { step: 'verify', purpose: 'observe' },
  ]);
  assert.deepEqual(await update(client), result);
  assert.equal(calls.filter(call => call.step === 'update').length, 1);
});

test('MCP skips the write when the field already has the requested value', async t => {
  const { client, calls } = await setup(t, { required: true });
  const result = await update(client);
  assert.equal(result.status, 'already_set');
  assert.equal(result.verified, true);
  assert.equal(result.before, true);
  assert.equal(result.after, true);
  assert.deepEqual(calls.map(call => call.step), ['locate', 'verify']);
});

test('MCP returns candidates and does not write when the target is ambiguous', async t => {
  const { client, calls } = await setup(t, { ambiguous: true });
  const result = await update(client);
  assert.equal(result.status, 'ambiguous_template');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(calls.map(call => call.step), ['locate']);
});
