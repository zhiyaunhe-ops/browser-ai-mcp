'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const blocked = { code: 'EGO_PROFILE_COOKIE_CLEAR_BLOCKED' };

test('blocks profile-wide CDP cookie clears on task, existing and later pages, and legacy transports', async () => {
  const { installCookieGuard } = await import('../scripts/ego-cookie-guard.mjs');
  const sent = [];
  class Page {
    async cdp(...args) { sent.push({ receiver: this, args }); }
  }
  class Task {
    async cdp(...args) { sent.push({ receiver: this, args }); }
    newPage() { return new Page(); }
  }
  function sendCDPMessage(message) { sent.push({ receiver: this, message }); }
  const globals = { cdp: sendCDPMessage, sendCDPMessage, ego: { sendCDPMessage } };
  const task = new Task();
  const page = new Page();
  installCookieGuard(task, page, globals);
  installCookieGuard(task, page, globals);

  const nested = { method: 'Target.sendMessageToTarget',
    params: { message: JSON.stringify({ method: 'Storage.clearCookies' }) } };
  for (const endpoint of [task, page, task.newPage(), globals]) {
    const method = ['Network', 'clearBrowserCookies'].join('.');
    await assert.rejects(endpoint.cdp(method), blocked);
    await assert.rejects(endpoint.cdp('Storage.clearCookies', { browserContextId: 'shared' }), blocked);
    await assert.rejects(endpoint.cdp(nested.method, nested.params), blocked);
  }
  for (const endpoint of [globals, globals.ego]) {
    assert.throws(() => endpoint.sendCDPMessage(JSON.stringify({ method: 'Network.clearBrowserCookies' })), blocked);
    assert.throws(() => endpoint.sendCDPMessage(JSON.stringify(nested)), blocked);
  }
  assert.deepEqual(sent, []);
  assert.equal(Object.getOwnPropertyDescriptor(Page.prototype, 'cdp').writable, false);

  const { install } = await import('../scripts/ego-memo.mjs');
  const tracked = [];
  await install(page, { task, network: { track: target => tracked.push(target) }, memo: false });
  await assert.rejects(page.cdp('Storage.clearCookies'), blocked);
  await assert.rejects((await task.newPage()).cdp('Storage.clearCookies'), blocked);

  const options = { timeout: 1000 };
  const payload = { cookies: [{ url: 'https://erp.example.test/', name: 'session', value: 'fixture' }] };
  const scoped = { origin: 'https://erp.example.test', storageTypes: 'cookies' };
  await page.cdp('Storage.setCookies', payload, options);
  await page.cdp('Storage.clearDataForOrigin', scoped);
  const safeMessage = JSON.stringify({ method: 'Browser.getVersion' });
  globals.ego.sendCDPMessage(safeMessage);
  assert.deepEqual(sent, [
    { receiver: page, args: ['Storage.setCookies', payload, options] },
    { receiver: page, args: ['Storage.clearDataForOrigin', scoped] },
    { receiver: globals.ego, message: safeMessage },
  ]);
  assert.ok(tracked.includes(page));
});
