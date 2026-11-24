'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const designerUrl = 'https://example.test/designer';
const target = {
  designerUrl, templateId: '123', templateName: 'Expense', field: 'department', nid: 'node-1',
};
const savePath = '/iuap-yonbuilder-designer/iuap-front/ide/module/ext';

function designerPage({ required = false, title = 'Expense', nodeId = target.nid, events = [] } = {}) {
  const actions = [];
  const node = {
    nid: nodeId, uiTable: 'BillItemBase', entityCode: 'znbzbx_expensebill',
    iTplId: target.templateId, cItemName: target.field, cShowCaption: 'Department',
  };
  const prop = { code: 'UI#required', value: required, isNormal: true, disabled: false };
  const tools = new Map([
    ['ai.elem.set', { tool: { async execute(args) {
      actions.push(['ai.elem.set', args]);
      prop.value = args.propValue;
      return { nid: args.nid };
    } } }],
    ['ai.page.save', { tool: { async execute(args) {
      actions.push(['ai.page.save', args]);
      return { success: true };
    } } }],
  ]);
  const scene = {
    yonCodePanelModel: { _aiTools: tools },
    aiPageSave() {},
    propSettingModel: {
      innerTplNode: node,
      innerCompMeta: { getProp: key => key === prop.code ? prop : undefined },
    },
  };
  const window = {
    ydf: { scene },
    yyds: {
      getGlobalData: () => ({ cBillNo: 'znbzbx_expensebill', children: [node] }),
      getNodeByNid: () => node,
    },
  };
  const page = {
    async url() { return designerUrl; },
    async cdp() {},
    async events() { return events; },
    async evaluate(fn, arg) {
      const oldWindow = global.window;
      const oldDocument = global.document;
      global.window = window;
      global.document = { title: `${title} - 单据设计器` };
      try { return await fn(arg); } finally {
        global.window = oldWindow;
        global.document = oldDocument;
      }
    },
  };
  return { page, actions, value: () => prop.value };
}

test('update uses designer actions to set required and save for both boolean values', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  for (const desired of [true, false]) {
    const { page, actions, value } = designerPage({ required: !desired });
    const result = await update({}, page, { ...target, desired });
    assert.equal(result.changed, true);
    assert.equal(value(), desired);
    assert.deepEqual(actions, [
      ['ai.elem.set', { nid: target.nid, propName: 'UI#required', propValue: desired }],
      ['ai.page.save', {}],
    ]);
    assert.equal(result.savePost, undefined);
  }
});

test('update does not save when required already matches', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  const { page, actions } = designerPage({ required: true });
  const result = await update({}, page, { ...target, desired: true });
  assert.equal(result.changed, false);
  assert.deepEqual(actions, []);
  assert.equal(result.savePost, undefined);
});

test('update does not write when template or node does not match', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  for (const options of [{ title: 'Other template' }, { nodeId: 'other-node' }]) {
    const { page, actions } = designerPage(options);
    await update({}, page, { ...target, desired: true });
    assert.deepEqual(actions, []);
  }
});

test('update reports the observed same-origin designer save request', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  const events = [
    { method: 'Network.requestWillBeSent', params: { requestId: 'save', request: { method: 'POST', url: `https://example.test${savePath}`, postData: JSON.stringify({ businessJson: JSON.stringify({ tplId: target.templateId, billNo: 'znbzbx_expensebill' }) }) } } },
    { method: 'Network.responseReceived', params: { requestId: 'save', response: { status: 200, url: `https://example.test${savePath}` } } },
  ];
  const { page } = designerPage({ events });
  const result = await update({}, page, { ...target, desired: true });
  assert.deepEqual(result.savePost, { method: 'POST', path: savePath, templateId: target.templateId, status: 200 });
});


test('a save response for another template is not attributed to the target', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  const events = [
    { method: 'Network.requestWillBeSent', params: { requestId: 'other', request: { method: 'POST', url: `https://example.test${savePath}`, postData: JSON.stringify({ businessJson: JSON.stringify({ tplId: 'other-template', billNo: 'znbzbx_expensebill' }) }) } } },
    { method: 'Network.responseReceived', params: { requestId: 'other', response: { status: 200, url: `https://example.test${savePath}` } } },
  ];
  const { page } = designerPage({ events });
  const result = await update({}, page, { ...target, desired: true });
  assert.equal(result.changed, true);
  assert.equal(result.savePost, undefined);
});
