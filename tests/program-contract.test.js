'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectProgram, assertProgram, validateCall, assertCall } = require('../src/program-contract');

function issueCodes(code) {
  return inspectProgram(code).issues.map(issue => issue.code);
}

test('program inspection accepts browser globals only inside page.evaluate callbacks', () => {
  assert.deepEqual(issueCodes('const n = await page.evaluate(() => document.querySelectorAll("input").length);'), []);
  assert.deepEqual(issueCodes('const read = () => document.title; await page.evaluate(read);'), []);
  assert.deepEqual(issueCodes('const read = function () { return location.href; }; await page.evaluate(read);'), []);
  assert.deepEqual(issueCodes('await page.evaluate(function read() { return window.location.href; });'), []);
});

test('program inspection reports free browser globals in Node scope but allows lexical bindings', () => {
  assert.ok(issueCodes('const n = document.querySelectorAll("input").length;').includes('EGO_NODE_CONTEXT'));
  assert.ok(issueCodes('const href = location.href;').includes('EGO_NODE_CONTEXT'));
  assert.ok(issueCodes('const title = window.document.title;').includes('EGO_NODE_CONTEXT'));
  assert.deepEqual(issueCodes('const document = { title: "node value" }; console.log(document.title);'), []);
  assert.deepEqual(issueCodes('function read(document) { return document.title; }'), []);
  assert.deepEqual(issueCodes('if (true) { const location = "local"; console.log(location); }'), []);
  assert.deepEqual(issueCodes('class page { locator() {} } new page().locator();'), []);
  assert.deepEqual(issueCodes('class DocumentValue { read(document) { return document.title; } }'), []);
  assert.deepEqual(issueCodes('if (typeof document !== "undefined") console.log("optional");'), []);
});

test('program inspection warns when an unmarked function closes over browser globals', () => {
  const result = inspectProgram('function readLater() { return document.title; }');
  assert.deepEqual(result.issues, []);
  assert.ok(result.warnings.some(warning => warning.code === 'EGO_CONTEXT_UNCERTAIN'));
});

test('assertProgram exposes a stable contract error with located issues', () => {
  assert.throws(() => assertProgram('document.title'), error => {
    assert.equal(error.code, 'EGO_PROGRAM_CONTRACT');
    assert.ok(error.issues.some(issue => issue.line === 1 && Number.isInteger(issue.column)));
    return true;
  });
});

test('documented calls remain valid and observed unsupported forms are rejected', () => {
  assert.deepEqual(validateCall('page.fill', ['#email', 'a@b.test', { clearFirst: true, timeout: 1000 }]), []);
  assert.deepEqual(validateCall('page.goto', ['https://example.test', { timeout: 1000, waitUntil: 'domcontentloaded' }]), []);
  assert.deepEqual(validateCall('page.screenshot', [{ path: 'C:\\temp\\capture.png' }]), []);
  assert.deepEqual(validateCall('page.mouse.wheel', [0, 600, { label: 'scroll' }]), []);
  assert.deepEqual(validateCall('page.mouse.down', [{ button: 'left' }]), []);

  assert.ok(validateCall('page.fill', ['#email', 'a@b.test', { label: 'email' }]).length);
  assert.ok(validateCall('page.goto', ['https://example.test', { timeoutMs: 1000 }]).length);
  assert.ok(validateCall('page.screenshot', [{ label: 'capture' }]).length);
  assert.ok(validateCall('page.screenshot', [{ path: 'capture.png' }]).length);
  assert.ok(validateCall('page.mouse.wheel', [0]).length);
  assert.ok(validateCall('page.mouse.wheel', [0, Number.NaN]).length);
  assert.ok(validateCall('page.mouse.down', ['left']).length);
});

test('unsupported method checks ignore shadowed Page names and computed dynamic calls', () => {
  assert.deepEqual(issueCodes('const page = { locator() {} }; page.locator();'), []);
  assert.deepEqual(issueCodes('page[method]();'), []);
  assert.ok(issueCodes('page.locator("input");').includes('EGO_UNSUPPORTED_API'));
  assert.ok(issueCodes('page["frames"]();').includes('EGO_UNSUPPORTED_API'));
});

test('assertCall exposes actionable API contract details', () => {
  assert.throws(() => assertCall('page.fill', ['#email', 'a@b.test', { label: 'email' }]), error => {
    assert.equal(error.code, 'EGO_API_CONTRACT');
    assert.match(error.message, /does not accept label/);
    return true;
  });
});

test('embedded static imports and exports are rejected while dynamic imports remain valid', () => {
  assert.ok(issueCodes('import value from "./module.js";').includes('EGO_PROGRAM_SYNTAX'));
  assert.ok(issueCodes('export const value = 1;').includes('EGO_PROGRAM_SYNTAX'));
  assert.deepEqual(issueCodes('await import("./module.js");'), []);
});
