'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('network capture drains requests and responses, retaining structure without values', async () => {
  const { createNetworkCapture } = await import('../scripts/ego-network.mjs');
  const capture = createNetworkCapture('exec-1', 1000);
  capture.track({ async events() { return [
    { method: 'Network.requestWillBeSent', params: { requestId: 'raw-id', type: 'XHR', wallTime: 2, timestamp: 2,
      request: { method: 'POST', url: 'https://example.test/api/customers/123456?search=secret',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
        postData: JSON.stringify({ name: 'Alice', nested: { count: 3 } }) } } },
    { method: 'Network.responseReceived', params: { requestId: 'raw-id', timestamp: 2.1, response: { status: 200 } } },
  ]; } }, 'main');
  const result = await capture.finish();
  assert.equal(result.capturedRequests, 1);
  assert.equal(result.status, 'captured');
  assert.equal(result.records.length, 2);
  const [request, response] = result.records;
  assert.equal(request.url, 'https://example.test/api/customers/:value');
  assert.deepEqual(request.queryKeys, ['search']);
  assert.equal(request.requestShape.properties.name.type, 'string');
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(result), /Alice|secret|Bearer|raw-id/);
});

test('network capture reports unavailable page events rather than inventing requests', async () => {
  const { createNetworkCapture } = await import('../scripts/ego-network.mjs');
  const capture = createNetworkCapture('exec-2', 1000);
  capture.track({ async events() { throw new Error('events unavailable'); } }, 'main');
  const result = await capture.finish();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.capturedRequests, 0);
  assert.ok(result.gaps.some(gap => gap.kind === 'network-page-events-unavailable'));
});
