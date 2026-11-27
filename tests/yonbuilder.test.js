'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerYonbuilder } = require('../src/yonbuilder');

test('YonBuilder scopes reads, disambiguates pages and builds a dry-run preview', async () => {
  const tools = new Map();
  const commands = [];
  async function invoke(entry, argv) {
    commands.push(argv);
    if (argv[0] === 'system') return { defaultSessionId: 'a', sessions: [
      {sessionId:'a', baseUrl:'https://a.example'}, {sessionId:'b', baseUrl:'https://b.example'}] };
    assert.deepEqual(argv.slice(-2), ['--session-id','b']);
    if (argv[2] === 'list') return {pages:['p1','p2'].map(pageCode => ({pageCode,name:'Example'}))};
    if (argv[2] === 'fields') return {fields:[{fieldName:'custom1'},{fieldName:'custom10'}]};
    return {dryRun:argv.includes('--dry-run')};
  }
  registerYonbuilder((name, description, schema, call) => tools.set(name,call), {}, invoke);
  const args = {baseUrl:'https://b.example',appCode:'app',bizobjCode:'obj',pageName:'Example'};
  await assert.rejects(tools.get('yonbuilder_open')({...args,kind:'preview'}), e =>
    e.code === 'PAGE_AMBIGUOUS' && e.candidates.length === 2);
  const field = {...args, microservice:'example',bill:'bill',template:'id',field:'custom1'};
  assert.equal((await tools.get('yonbuilder_field_get')(field)).count,1);
  assert.equal((await tools.get('yonbuilder_field_preview')({...field,group:'group',property:'visible',value:'false'})).dryRun,true);
});

test('a tenant-scoped CLI query checks its session before dispatch', async () => {
  const tools = new Map();
  const calls = [];
  const argv = ['template', 'importtpl', 'list', '--session-id', 'example-session'];
  const probe = ['whoami', '--format', 'json', '--session-id', 'example-session'];
  let identity = { tenantid: 'tenant-b' };
  registerYonbuilder((name, description, schema, call) => tools.set(name, call), {}, async (entry, args) => {
    assert.equal(entry, 'bip-cli');
    calls.push(args);
    return args[0] === 'whoami' ? identity : ['example-template'];
  });
  const query = tools.get('yonbuilder_cli');
  const request = { entry: 'bip-cli', argv, targetTenantId: 'tenant-a' };
  await assert.rejects(query(request), { code: 'TENANT_MISMATCH' });
  assert.deepEqual(calls.splice(0), [probe]);
  identity = {};
  await assert.rejects(query(request), { code: 'TENANT_UNKNOWN' });
  assert.deepEqual(calls.splice(0), [probe]);
  identity = { tenantid: 'tenant-a' };
  assert.deepEqual(await query(request), ['example-template']);
  assert.deepEqual(calls.splice(0), [probe, argv]);
  await query({ entry: 'bip-cli', argv });
  assert.deepEqual(calls, [argv]);
});

test('field set uses the verified session for the write and an independent readback', async t => {
  const previous = process.env.YONCLAW_REQ_PROXY_BASE_URL;
  delete process.env.YONCLAW_REQ_PROXY_BASE_URL;
  t.after(() => { if (previous !== undefined) process.env.YONCLAW_REQ_PROXY_BASE_URL = previous; });
  const tools = new Map();
  const calls = [];
  let readStatus = 'unchanged';
  let tenant = 'expected';
  registerYonbuilder((name, description, schema, call) => tools.set(name, call), {}, async (entry, args) => {
    if (args[0] === 'system') return { sessions: [{ tenantId: 'expected', sessionId: 's' }] };
    assert.deepEqual(args.slice(-2), ['--session-id', 's']);
    if (args[0] === 'whoami') return { tenantid: tenant };
    assert.ok(args.includes('--value=false'));
    const dryRun = args.includes('--dry-run');
    calls.push(dryRun ? 'read' : 'write');
    return { success: true, dryRun, microserviceCode: 'svc', billNo: 'bill', tplId: '42', field: 'name',
      prop: 'required', appliedCount: 1, results: [{ groupId: 'header', designId: '1',
        status: dryRun ? readStatus : 'changed', oldValue: false }] };
  });
  const set = tools.get('yonbuilder_field_set');
  const args = { microservice: 'svc', bill: 'bill', template: '42', field: 'name', group: 'header',
    property: 'required', value: 'false', targetTenantId: 'expected' };
  assert.equal((await set(args)).verified, true);
  readStatus = 'changed';
  await assert.rejects(set(args), { code: 'FIELD_VERIFICATION_FAILED' });
  tenant = 'other';
  await assert.rejects(set(args), { code: 'TENANT_MISMATCH' });
  assert.deepEqual(calls, ['write', 'read', 'write', 'read']);
});
