'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadMemo() {
  return import(`../scripts/ego-memo.mjs?trace-test=${Date.now()}-${Math.random()}`);
}

function fakePage(label, calls) {
  return {
    label,
    async evaluate(callback) { calls.push({ method: 'evaluate', callback: typeof callback }); return { complete: true, ok: true }; },
    async goto() { calls.push({ method: 'goto' }); throw Object.assign(new Error('navigation failed'), { code: 'EGO_NAV' }); },
    async fill(selector, value, options) { calls.push({ method: 'fill', selector, value, options }); },
  };
}

test('observation trace shares ordered page events and stage counts across a task', async () => {
  const memo = await loadMemo();
  const calls = [];
  const first = fakePage('p1', calls), second = fakePage('p2', calls);
  const task = { page(label) { return label === 'p2' ? second : first; } };
  await memo.install(first, { task, pageLabel: 'p1', catalog: false });
  await first.evaluate(() => 1);
  await assert.rejects(first.goto('https://example.test'), /navigation failed/);
  const other = task.page('p2');
  await other.evaluate(() => 2);

  const trace = memo.observationTrace(first);
  assert.equal(trace.version, 1);
  assert.deepEqual(trace.events.map(event => [event.sequence, event.method, event.stage, event.outcome]), [
    [1, 'page.evaluate', 'evaluation', 'succeeded'],
    [2, 'page.goto', 'action', 'failed'],
    [3, 'page.evaluate', 'evaluation', 'succeeded'],
  ]);
  assert.equal(trace.events[2].pageLabel, 'p2');
  assert.deepEqual(trace.counts.evaluation, { attempted: 2, succeeded: 2, failed: 0 });
  assert.deepEqual(trace.counts.action, { attempted: 1, succeeded: 0, failed: 1 });
  assert.equal(trace.events[1].errorCode, 'EGO_NAV');
  assert.equal(calls.length, 3, 'instrumentation calls each original Page method once');
});

test('observation trace reserves first 128 events and counts dropped calls', async () => {
  const memo = await loadMemo();
  const calls = [];
  const page = fakePage('p1', calls);
  await memo.install(page, { catalog: false });
  for (let i = 0; i < 130; i++) await page.evaluate(() => i);
  const trace = memo.observationTrace(page);
  assert.equal(trace.events.length, 128);
  assert.equal(trace.events[0].sequence, 1);
  assert.equal(trace.events.at(-1).sequence, 128);
  assert.equal(trace.droppedEvents, 2);
  assert.deepEqual(trace.counts.evaluation, { attempted: 130, succeeded: 130, failed: 0 });
});

test('reinstall resets round telemetry without stacking wrappers', async () => {
  const memo = await loadMemo();
  const calls = [];
  const page = fakePage('p1', calls);
  await memo.install(page, { catalog: false });
  await page.evaluate(() => 1);
  await memo.install(page, { catalog: false });
  await page.evaluate(() => 2);
  const trace = memo.observationTrace(page);
  assert.equal(trace.events.length, 1);
  assert.equal(trace.events[0].sequence, 1);
  assert.deepEqual(trace.counts.evaluation, { attempted: 1, succeeded: 1, failed: 0 });
  assert.equal(calls.length, 2, 'the underlying method was invoked once per call');
});

test('runtime Page guard validates dynamic fill options before the native action', async () => {
  const memo = await loadMemo();
  const calls = [];
  const page = fakePage('p1', calls);
  await memo.install(page, { catalog: false });
  await assert.rejects(page.fill('#amount', '10', { label: 'unsupported option' }), /does not accept label/);
  assert.equal(calls.some(call => call.method === 'fill'), false);
  const trace = memo.observationTrace(page);
  assert.equal(trace.events.length, 1);
  assert.equal(trace.events[0].method, 'page.fill');
  assert.equal(trace.events[0].stage, 'action');
  assert.equal(trace.events[0].outcome, 'failed');
  assert.equal(trace.events[0].errorCode, 'EGO_API_CONTRACT');
  assert.deepEqual(trace.counts.action, { attempted: 1, succeeded: 0, failed: 1 });
});
