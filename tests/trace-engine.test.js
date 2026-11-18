const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTrace, discoverAPI } = require('../src/trace-engine');

const scope = { sessionId: 'session-a', tabId: 4, frameId: 0, documentId: 'doc-a' };

test('trace groups request phases and links matching command IDs with explicit evidence', () => {
  const trace = buildTrace([
    { ...scope, cursor: 1, eventId: 'action-start-1', type: 'action-start', t: 1000, action: 'click', actionId: 'act-1', commandId: 'cmd-1' },
    { ...scope, cursor: 2, eventId: 'request-1', kind: 'net', type: 'request', method: 'POST', url: 'https://app.test/api/save?trace=x', requestId: 'req-1', commandId: 'cmd-1', t: 1100 },
    { ...scope, cursor: 3, eventId: 'response-1', kind: 'net', type: 'response', status: 204, requestId: 'req-1', commandId: 'cmd-1', t: 1200 },
  ]);
  assert.equal(trace.version, '0.6');
  assert.equal(trace.actions.length, 1);
  assert.equal(trace.network.length, 1);
  assert.deepEqual(trace.network[0].statuses, [204]);
  assert.deepEqual(trace.network[0].phases, ['request', 'response']);
  assert.deepEqual(trace.network[0].evidence.map(source => source.eventId), ['request-1', 'response-1']);
  assert.ok(trace.links.some(link => link.kind === 'explicit' && link.basis === 'commandId' && link.causal === false));
  assert.equal(trace.evidence.length, 3);
  assert.equal(trace.state, 'observed');
});

test('trace keeps ambiguous temporal candidates noncausal and preserves capture gaps', () => {
  const trace = buildTrace([
    { ...scope, cursor: 1, type: 'action-start', actionId: 'a1', action: 'click', t: 1000 },
    { ...scope, cursor: 2, type: 'action-start', actionId: 'a2', action: 'type', t: 1020 },
    { ...scope, cursor: 3, kind: 'net', type: 'request', method: 'GET', url: 'https://app.test/api', requestId: 'req', t: 1050, truncated: true },
  ], { windowMs: 100, gaps: [{ source: 'wire', reason: 'retention' }] });
  const candidate = trace.links.find(link => link.kind === 'temporal-candidate');
  assert.ok(candidate);
  assert.equal(candidate.ambiguous, true);
  assert.equal(candidate.causal, false);
  assert.deepEqual(candidate.candidateActionIds, ['action:1', 'action:2']);
  assert.deepEqual(trace.network[0].captureGaps.map(gap => gap.kind), ['truncated']);
  assert.deepEqual(trace.gaps, [{ source: 'wire', reason: 'retention' }]);
});

test('trace never crosses frame/document scope when associating activity', () => {
  const trace = buildTrace([
    { ...scope, cursor: 1, type: 'action-start', actionId: 'a1', commandId: 'cmd-a', action: 'click', t: 1000 },
    { ...scope, frameId: 3, documentId: 'doc-b', cursor: 2, kind: 'dom-change', type: 'dom-change', summary: 'updated', t: 1010, commandId: 'cmd-a' },
  ]);
  assert.equal(trace.actions.length, 1);
  assert.equal(trace.dom.length, 1);
  assert.equal(trace.links.length, 0);
  assert.equal(trace.scope.frameId, undefined, 'mixed frame scopes are not presented as one trace scope');
});

test('API discovery groups by method and path, reports body shapes, gaps, and unresolved URLs', () => {
  const result = discoverAPI([
    { ...scope, cursor: 1, eventId: 'post-1', kind: 'net', type: 'request', method: 'post', url: 'https://app.test/api/save?attempt=1', reqBody: { name: 'Alice', count: 3 } },
    { ...scope, cursor: 2, eventId: 'post-2', kind: 'net', type: 'response', method: 'POST', url: 'https://app.test/api/save?attempt=2', status: 200, resBody: { ok: true, id: 12 }, sourceGap: true },
    { ...scope, cursor: 3, kind: 'net', type: 'request', method: 'GET', url: 'https://app.test/api/save?attempt=3' },
    { ...scope, cursor: 4, kind: 'net', type: 'request', method: 'GET', url: '/relative' },
  ]);
  assert.equal(result.endpoints.length, 2);
  const post = result.endpoints.find(endpoint => endpoint.method === 'POST');
  assert.equal(post.pathname, '/api/save');
  assert.deepEqual(post.queryKeys, ['attempt']);
  assert.deepEqual(post.statuses, [200]);
  assert.ok(post.requestShapes.some(shape => shape.properties?.name?.type === 'string'));
  assert.ok(post.responseShapes.some(shape => shape.properties?.ok?.type === 'boolean'));
  assert.deepEqual(post.captureGaps.map(gap => gap.kind), ['sourceGap']);
  assert.doesNotMatch(JSON.stringify(result), /Alice/);
  assert.equal(result.unresolved.length, 1);
});

test('API discovery resolves relative URLs against the captured frame URL', () => {
  const result = discoverAPI([{ ...scope, kind: 'net', type: 'request', method: 'GET', requestId: 'r1',
    url: '../api/items?active=1', frameUrl: 'https://app.test/records/view' }]);
  assert.equal(result.endpoints[0].origin, 'https://app.test');
  assert.equal(result.endpoints[0].pathname, '/api/items');
  assert.equal(result.unresolved.length, 0);
});

test('large temporal correlation preserves counts while bounding links per node and globally', () => {
  const events = [];
  for (let index = 0; index < 20000; index++) events.push({ ...scope, cursor: index + 1, eventId: `input-${index}`,
    type: 'input', actionId: `a${index}`, t: 1000 });
  for (let index = 0; index < 640; index++) events.push({ ...scope, cursor: 20001 + index, eventId: `request-${index}`,
    kind: 'net', type: 'request', requestId: `r${index}`, method: 'POST', url: 'https://app.test/save', t: 1000 });
  const trace = buildTrace(events);
  assert.equal(trace.actions.length, 20000);
  assert.equal(trace.links.length, 20000);
  for (const request of trace.network) assert.ok(trace.links.filter(link => link.to === request.id).length <= 32);
  assert.ok(trace.links.every(link => link.ambiguous === true && link.causal === false));
  assert.ok(trace.links.every(link => link.candidateActionCount === 20000));
  assert.ok(trace.gaps.some(gap => gap.kind === 'correlation-truncated'));
});

test('DOM association links only the exact scoped source/request ID, never URL coincidence', () => {
  const events = [
    { ...scope, cursor: 1, eventId: 'net-exact', kind: 'net', type: 'request', src: 'page', requestId: 'r1', url: 'https://app.test/save', t: 1000 },
    { ...scope, cursor: 2, eventId: 'dom-exact', type: 'dom-change', requestId: 'r1', networkSource: 'page', association: { kind: 'temporal-candidate', requestId: 'r1', networkSource: 'page' }, t: 1001 },
    { ...scope, cursor: 3, eventId: 'net-other', kind: 'net', type: 'request', src: 'page', requestId: 'r2', url: 'https://app.test/save', t: 1000 },
    { ...scope, frameId: 2, cursor: 4, eventId: 'dom-other-frame', type: 'dom-change', requestId: 'r1', networkSource: 'page', association: { kind: 'temporal-candidate', requestId: 'r1', networkSource: 'page' }, t: 1001 },
  ];
  const trace = buildTrace(events);
  const networkLink = trace.links.find(link => link.basis === 'same-scope-source-requestId');
  assert.ok(networkLink);
  assert.equal(networkLink.from, trace.network.find(item => item.requestId === 'r1').id);
  assert.equal(networkLink.to, trace.dom[0].id);
  assert.equal(trace.links.filter(link => link.basis === 'same-scope-source-requestId').length, 1);
});

test('debounced input grouping uses capture time and the latest captured value, not cursor order', () => {
  const trace = buildTrace([
    { ...scope, cursor: 1, eventId: 'click', type: 'action-start', actionId: 'shared', t: 2000,
      replay: { action: 'click', params: { css: '#save' } } },
    { ...scope, cursor: 2, eventId: 'input-late', type: 'input', actionId: 'shared', actor: 'user', t: 2050,
      replay: { action: 'type', params: { css: '#name', text: 'latest' } } },
    { ...scope, cursor: 3, eventId: 'input-delayed', type: 'input', actionId: 'shared', actor: 'user', t: 1900,
      replay: { action: 'type', params: { css: '#name', text: 'older' } } },
  ]);
  assert.equal(trace.actions.length, 1);
  assert.equal(trace.actions[0].action, 'click');
  assert.equal(trace.actions[0].t, 2000);
  assert.equal(trace.actions[0].replay.params.css, '#save', 'authoritative action-start descriptor is not replaced by later inputs');
});
