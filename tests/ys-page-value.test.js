'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadReader() {
  return import(`../scripts/ys-page.mjs?value-test=${Date.now()}-${Math.random()}`);
}

function element(doc, values = {}) {
  return { tagName: 'INPUT', value: '', checked: false, getBoundingClientRect: () => ({ width: 40, height: 20 }),
    ownerDocument: doc, ...values };
}

function pageWithElements(elementsBySelector) {
  const doc = {
    defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) },
    querySelectorAll(selector) { return selector === 'iframe' ? [] : (elementsBySelector[selector] || []); },
  };
  for (const elements of Object.values(elementsBySelector)) for (const node of elements) node.ownerDocument = doc;
  return { async evaluate(callback, config) {
    const prior = globalThis.document;
    globalThis.document = doc;
    try { return callback(config); }
    finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
  } };
}

test('readValue invokes the Page callback with a validated selector configuration', async () => {
  const { readValue } = await loadReader();
  let callbackArgs;
  let callbackType;
  const page = pageWithElements({ '#amount': [element(null, { value: '42' })] });
  const observedPage = { async evaluate(callback, config) {
    callbackType = typeof callback;
    callbackArgs = config;
    return page.evaluate(callback, config);
  } };
  const result = await readValue(observedPage, { selector: '#amount', kind: 'value', framePath: '0', maxChars: 20 });
  assert.equal(callbackType, 'function');
  assert.deepEqual(callbackArgs, { selector: '#amount', framePath: '0', scope: null, kind: 'value', maxChars: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.value, '42');
  assert.equal(result.framePath, '0');
});

test('readValue treats null, arrays and scalar callback responses as malformed results', async () => {
  const { readValue } = await loadReader();
  for (const malformed of [null, [], ['valid-looking'], 'value', false]) {
    const result = await readValue({ async evaluate() { return malformed; } }, { selector: '#status' });
    assert.equal(result.ok, false);
    assert.equal(result.complete, false);
    assert.equal(result.found, null);
    assert.equal(result.reason, 'invalid-result-shape');
  }
});

test('readValue separates missing, empty and malformed field values', async () => {
  const { readValue } = await loadReader();
  const missing = await readValue(pageWithElements({ '#missing': [] }), { selector: '#missing' });
  assert.equal(missing.found, false);
  assert.equal(missing.reason, 'missing');

  const empty = await readValue(pageWithElements({ '#empty': [element(null, { value: '' })] }), { selector: '#empty' });
  assert.equal(empty.found, true);
  assert.equal(empty.value, '');

  const shape = await readValue(pageWithElements({ '#unexpected': [element(null, { checked: 'yes' })] }), { selector: '#unexpected', kind: 'checked' });
  assert.equal(shape.found, true);
  assert.equal(shape.reason, 'shape-mismatch');

  const duplicate = await readValue(pageWithElements({ '#duplicate': [element(null), element(null)] }), { selector: '#duplicate' });
  assert.equal(duplicate.found, null);
  assert.equal(duplicate.reason, 'ambiguous');
});

test('readValue rejects invalid selectors, frame paths and kinds before Page evaluation', async () => {
  const { readValue } = await loadReader();
  let evaluations = 0;
  const page = { async evaluate() { evaluations++; return null; } };
  await assert.rejects(readValue(page, { selector: ' ' }), /selector is required/);
  await assert.rejects(readValue(page, { selector: '#x', framePath: '1/2' }), /framePath/);
  await assert.rejects(readValue(page, { selector: '#x', kind: 'html' }), /kind/);
  assert.equal(evaluations, 0);
});
