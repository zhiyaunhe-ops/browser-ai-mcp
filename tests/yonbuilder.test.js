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
