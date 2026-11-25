'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function fakePage(native) {
  const calls = [];
  return { calls, async url() { return 'https://global.yonyoucloud.com/'; },
    async fill(selector, value) { calls.push({ method: 'fill', selector, value }); },
    async evaluate(fn, arg) {
      calls.push({ method: 'evaluate', name: fn.name });
      if (fn.name === 'nodeCodes') return ['GZTTMP011'];
      if (fn.name === 'openNativeNode') return native;
      if (fn.name === 'rendered') return true;
      if (typeof arg === 'string') return 1;
      // ready and independent active-tab observation.
      return true;
    } };
}

test('opening a workbench node prefers the request and verifies the active tab', async () => {
  const { openNode } = await import('../scripts/asp-workbench.mjs');
  const page = fakePage({ request: { method: 'GET', path: '/service', httpStatus: 200 } });
  const result = await openNode({}, page, { nodeName: 'UI模板' });
  assert.equal(result.status, 'opened');
  assert.equal(result.transport, 'api');
  assert.equal(result.rendered, true);
  assert.equal(page.calls.some(call => call.method === 'fill'), false);
});

test('opening a workbench node falls back to search when the request fails', async () => {
  const { openNode } = await import('../scripts/asp-workbench.mjs');
  const page = fakePage({ fallbackReason: 'service_request_failed' });
  const result = await openNode({}, page, { nodeName: 'UI模板' });
  assert.equal(result.status, 'opened');
  assert.equal(result.transport, 'ui');
  assert.equal(result.fallbackReason, 'service_request_failed');
  assert.ok(page.calls.some(call => call.method === 'fill' && call.value === 'UI模板'));
});

function queryPage(native) {
  const calls = [];
  return { calls, async url() { return 'https://global.yonyoucloud.com/'; },
    async fill(selector, value) { calls.push({ method: 'fill', selector, value }); },
    async evaluate(fn, arg) {
      calls.push({ method: 'evaluate', name: fn.name, arg });
      if (fn.name === 'nodeCodes') return ['GZTTMP011'];
      if (fn.name === 'openNativeNode') return { request: { method: 'GET', httpStatus: 200 } };
      if (fn.name === 'queryNativeTemplates') return native;
      if (fn.name === 'documentNodes') return arg.openPosition === undefined
        ? [{ documentName: '报销单', documentPath: ['费用', '报销单'], position: '0-1' }] : true;
      if (fn.name === 'templateListState') return { pageType: '列表' };
      if (fn.name === 'readTemplateTable') return { rows: [{ templateId: '1', templateName: '通用' }],
        matchCount: null, scannedRows: 1, truncated: true };
      return true;
    } };
}

test('template query returns request results with the supplied filters', async () => {
  const { queryTemplates } = await import('../scripts/asp-workbench.mjs');
  const page = queryPage({ status: 'queried', rows: [{ templateId: '1', templateName: '通用' }],
    matchCount: 1, scannedRows: 1, truncated: false });
  const result = await queryTemplates({}, page, { documentName: '报销单', templateName: '通用' });
  assert.equal(result.transport, 'api');
  assert.equal(result.matchCount, 1);
  assert.equal(page.calls.find(call => call.name === 'queryNativeTemplates').arg.templateName, '通用');
  assert.equal(page.calls.some(call => call.method === 'fill'), false);
});

test('template query falls back to the UI and reports incomplete visible rows', async () => {
  const { queryTemplates } = await import('../scripts/asp-workbench.mjs');
  const page = queryPage({ fallbackReason: 'template_list_request_failed' });
  const result = await queryTemplates({}, page, { documentName: '报销单' });
  assert.equal(result.status, 'queried');
  assert.equal(result.transport, 'ui');
  assert.equal(result.fallbackReason, 'template_list_request_failed');
  assert.equal(result.matchCount, null);
  assert.equal(result.truncated, true);
  assert.ok(page.calls.some(call => call.method === 'fill' && call.value === '报销单'));
});
