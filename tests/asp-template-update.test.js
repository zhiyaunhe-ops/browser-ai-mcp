'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const designerUrl = 'https://example.test/designer';
const target = {
  designerUrl, templateId: '123', templateName: 'Expense', field: 'department', nid: 'node-1',
};
const savePath = '/iuap-yonbuilder-designer/iuap-front/ide/module/ext';

function designerPage({ required = false, title = 'Expense', nodeId = target.nid, events = [], properties, nodeAttributes = {} } = {}) {
  const actions = [];
  const node = {
    nid: nodeId, uiTable: 'BillItemBase', entityCode: 'znbzbx_expensebill',
    iTplId: target.templateId, cItemName: target.field, cShowCaption: 'Department', ...nodeAttributes,
  };
  const prop = { code: 'UI#required', name: '必填', value: required, isNormal: true, disabled: false };
  const normalProps = properties || [prop];
  const tools = new Map([
    ['ai.elem.set', { tool: { async execute(args) {
      actions.push(['ai.elem.set', args]);
      normalProps.find(item => item.code === args.propName).value = args.propValue;
      return { nid: args.nid };
    } } }],
    ['ai.elem.setDefaultValue', { tool: { async execute(args) {
      actions.push(['ai.elem.setDefaultValue', args]);
      node.cDefaultValue = Array.isArray(args.cDefaultValue) ? args.cDefaultValue.join(',') : args.cDefaultValue + '-01';
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
      innerCompMeta: { normalProps, getProp: key => normalProps.find(item => item.code === key) },
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
    async goto() {},
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


test('designer resolves exact property names and codes to canonical readback', async () => {
  const { updateModel, verifyModel } = await import('../scripts/asp-template.mjs');
  const properties = [
    { code: 'cTips', name: '提示文本', value: 'old', isNormal: true, disabled: false },
    { code: 'iWidth', name: '布局占比', value: 1, isNormal: true, disabled: false },
  ];
  const { page, actions } = designerPage({ properties });
  const desired = { '提示文本': 'new', iWidth: 2 };
  await updateModel({}, page, { ...target, desired });
  const actual = await verifyModel({ newPage: async () => page }, page, { ...target, desired });
  assert.deepEqual(actual.values, { cTips: 'new', iWidth: 2 });
  assert.equal(actual.matches, true);
  assert.deepEqual(actions.map(([name]) => name), ['ai.elem.set', 'ai.elem.set', 'ai.page.save']);
});

test('designer rejects unknown, ambiguous and duplicate property names without writing', async () => {
  const { updateModel } = await import('../scripts/asp-template.mjs');
  for (const desired of [{ '不存在': true }, { '重复': true }, { '提示文本': 'a', cTips: 'b' }]) {
    const properties = [
      { code: 'cTips', name: '提示文本', value: '', isNormal: true, disabled: false },
      { code: 'a', name: '重复', value: false, isNormal: true, disabled: false },
      { code: 'b', name: '重复', value: false, isNormal: true, disabled: false },
    ];
    const { page, actions } = designerPage({ properties });
    await assert.rejects(updateModel({}, page, { ...target, desired }));
    assert.deepEqual(actions, []);
  }
});

test('inspect exposes actual selectable options from designer metadata', async () => {
  const { verifyModel } = await import('../scripts/asp-template.mjs');
  const properties = [{
    code: 'iWidth', name: '布局占比', value: 2, isNormal: true, disabled: false, controlType: 'Select',
    data: [{ value: 2, label: '占用二列' }, { value: 3, label: '隐藏选项', visible: false }],
  }];
  const { page } = designerPage({ properties });
  const actual = await verifyModel({ newPage: async () => page }, page, { ...target, desired: {} });
  assert.deepEqual(actual.properties[0].options, [{ value: 2, label: '占用二列' }]);
});


test('default values verify against the designer native date and multi-select storage', async () => {
  const { updateModel, verifyModel } = await import('../scripts/asp-template.mjs');
  for (const [nodeAttributes, value, stored] of [
    [{ uitype: 'datepicker', cFormatData: 'YYYY-MM' }, '2026-11', '2026-11-01'],
    [{ uitype: 'select' }, ['a', 'b'], 'a,b'],
  ]) {
    const properties = [{ code: 'cDefaultValue', name: '默认值', value: null, isNormal: true, disabled: false }];
    const { page, actions } = designerPage({ properties, nodeAttributes });
    const desired = { cDefaultValue: value };
    assert.equal((await updateModel({}, page, { ...target, desired })).changed, true);
    const actual = await verifyModel({ newPage: async () => page }, page, { ...target, desired });
    assert.equal(actual.matches, true);
    assert.equal(actual.values.cDefaultValue, stored);
    assert.deepEqual(actions.map(([name]) => name), ['ai.elem.setDefaultValue', 'ai.page.save']);
  }
});
