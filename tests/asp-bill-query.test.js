'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('general application query matches the exact bill code and reports incomplete results', async () => {
  const { queryGeneralApplications } = await import('../scripts/asp-bill-query.mjs');
  const saved = { window: global.window, document: global.document, location: global.location, fetch: global.fetch };
  const contextKey = Symbol.for('asp-general-application-query-context');
  global.window = { [contextKey]: { url: 'https://example.test/yonbip-fi-expsrbsm/bill/list', body: {
    ownDomain: 'domain', page: {}, condition: { commonVOs: [] },
  } } };
  global.document = { cookie: 'XSRF-TOKEN=token' };
  global.location = { origin: 'https://example.test' };
  let candidateCount = 2;
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, async json() { return { code: 200, data: body.isOnlyCount
      ? { recordCount: candidateCount } : { recordList: [{ code: 'APP-100' }, { code: 'APP-1000' }] } }; } };
  };
  const page = { async url() { return 'https://global.yonyoucloud.com/'; }, async evaluate(fn, arg) {
    if (fn.name !== 'billListBrowser') return true;
    if (arg.action !== 'api') return undefined;
    return fn(arg);
  } };
  try {
    const match = await queryGeneralApplications({}, page, { billCode: 'APP-100' });
    assert.equal(match.status, 'matched');
    assert.equal(match.matchedCount, 1);
    assert.equal(match.complete, true);
    const absent = await queryGeneralApplications({}, page, { billCode: 'APP-10' });
    assert.equal(absent.status, 'no_match');
    assert.equal(absent.matchedCount, 0);
    candidateCount = 3;
    const incomplete = await queryGeneralApplications({}, page, { billCode: 'APP-10' });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.matchedCount, 0);
  } finally {
    Object.assign(global, saved);
  }
});
