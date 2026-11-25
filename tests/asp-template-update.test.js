'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const designerUrl = 'https://example.test/designer';
const target = {
  designerUrl, templateId: '123', templateName: 'Expense', field: 'department', nid: 'node-1',
  billNo: 'znbzbx_expensebill', fieldScope: 'header', entityCode: 'znbzbx_expensebill',
};
const savePath = '/iuap-yonbuilder-designer/iuap-front/ide/module/ext';

function designerPage({ required = false, title = 'Expense', nodeId = target.nid, events = [], properties, nodeAttributes = {}, billNo = target.billNo, nodes } = {}) {
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
      getGlobalData: () => ({ uiTable: 'BillBase', cBillNo: billNo, children: [{ uiTable: 'BillTemplateBase', iTplId: target.templateId, children: nodes || [node] }] }),
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

test('designer selects a header or a named detail entity for the same field', async () => {
  const { locateModel } = await import('../scripts/asp-template.mjs');
  const billNo = 'purchase_order';
  const header = { nid: 'header', uiTable: 'BillItemBase', entityCode: billNo, iTplId: target.templateId, cItemName: 'department', cShowCaption: 'Department' };
  const detail = { ...header, nid: 'detail', entityCode: 'purchase_order_lines' };
  for (const [node, scope] of [[header, 'header'], [detail, 'detail']]) {
    const { page } = designerPage({ billNo, nodeId: node.nid, nodeAttributes: node, nodes: [header, detail] });
    const { nid, entityCode, billNo: ignoredBillNo, ...selection } = target;
    const input = { ...selection, fieldScope: scope, ...(scope === 'detail' ? { detailEntity: node.entityCode } : {}), desired: {} };
    const result = await locateModel({ page: () => page }, page, input);
    assert.equal(result.nid, node.nid);
    assert.equal(result.billNo, billNo);
    assert.equal(result.fieldScope, scope);
    assert.equal(result.entityCode, node.entityCode);
  }
});

test('designer does not write for ambiguous detail fields or a different bill', async () => {
  const { updateModel } = await import('../scripts/asp-template.mjs');
  const billNo = 'purchase_order';
  const first = { nid: 'detail-1', uiTable: 'BillItemBase', entityCode: 'purchase_order_lines', iTplId: target.templateId, cItemName: target.field, cShowCaption: 'Department' };
  const second = { ...first, nid: 'detail-2', entityCode: 'purchase_order_taxes' };
  const ambiguous = designerPage({ billNo, nodeAttributes: first, nodes: [first, second] });
  const { nid, entityCode, ...base } = target;
  const result = await updateModel({}, ambiguous.page, { ...base, billNo, fieldScope: 'detail', desired: { 'UI#required': true } });
  assert.equal(result.status, 'ambiguous_field');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(ambiguous.actions, []);
  const wrongBill = designerPage({ billNo, nodeAttributes: first, nodes: [first] });
  const mismatch = await updateModel({}, wrongBill.page, { ...base, billNo: 'other_bill', fieldScope: 'detail', desired: { 'UI#required': true } });
  assert.equal(mismatch.status, 'template_mismatch');
  assert.deepEqual(wrongBill.actions, []);
});

test('save receipt is attributed to the selected bill as well as template', async () => {
  const { update } = await import('../scripts/asp-template.mjs');
  const billNo = 'purchase_order';
  const events = ['other_bill', billNo].flatMap((bill, index) => [
    { method: 'Network.requestWillBeSent', params: { requestId: `save-${index}`, request: { method: 'POST', url: `https://example.test${savePath}`, postData: JSON.stringify({ businessJson: JSON.stringify({ tplId: target.templateId, billNo: bill }) }) } } },
    { method: 'Network.responseReceived', params: { requestId: `save-${index}`, response: { status: 200 + index, url: `https://example.test${savePath}` } } },
  ]);
  const { page } = designerPage({ billNo, nodeAttributes: { entityCode: billNo }, events });
  const result = await update({}, page, { ...target, billNo, entityCode: billNo, desired: true });
  assert.equal(result.changed, true);
  assert.equal(result.savePost.status, 201);
});

test('reopened designer resolves a persistent field ID when the node ID changes', async () => {
  const { verifyModel } = await import('../scripts/asp-template.mjs');
  const { page } = designerPage({ nodeId: 'new-node', nodeAttributes: { id: '2672308697195610168' } });
  const result = await verifyModel({ newPage: async () => page }, page, {
    ...target, fieldId: '2672308697195610168', desired: {},
  });
  assert.equal(result.nid, 'new-node');
  assert.equal(result.fieldId, '2672308697195610168');
  assert.equal(result.field, target.field);
  assert.equal(result.billNo, target.billNo);
});

test('workbench document selection handles default, missing, duplicate and path-qualified documents', async () => {
  const { locateModel } = await import('../scripts/asp-template.mjs');
  function pageFor(paths, rows = []) {
    let filtered = false;
    let filled;
    function titleNode(path, index) {
      const item = { title: path[index], querySelector: () => ({ textContent: path[index] }) };
      const li = { classList: { contains: name => name === 'wui-tree-treenode-leaf' && index === path.length - 1 },
        querySelector: () => item, parentElement: { closest: () => index ? titleNode(path, index - 1).closest('li') : null } };
      const link = { getAttribute: () => path.join('/'), click() {} };
      item.closest = selector => selector === 'li' ? li : link;
      return item;
    }
    const page = {
      async url() { return 'https://global.yonyoucloud.com/'; },
      async goto() {},
      async fill(selector, value) { if (selector.startsWith('#GZTTMP011')) { filtered = true; filled = value; } },
      async evaluate(fn, arg) {
        if (fn.name === 'nodeCodes') return ['GZTTMP011'];
        if (fn.name === 'openNativeNode') return { request: { method: 'GET', httpStatus: 200 } };
        if (fn.name === 'documentNodes') {
          if (arg.openPosition !== undefined) return true;
          const old = global.document;
          const list = { querySelectorAll: () => paths.map(path => titleNode(path, path.length - 1)), querySelector: () => paths.length ? null : { textContent: '搜索无结果' } };
          global.document = { querySelector: () => list };
          try { return fn(arg); } finally { global.document = old; }
        }
        if (fn.name === 'templateRows') return rows;
        if (fn.name === 'templateListState') {
          const old = global.document;
          const state = { loaded: false };
          const list = { [Symbol.for('asp-template-list-load')]: state,
            querySelector(selector) {
              if (selector.includes('treenode-selected')) return { getAttribute: () => arg.position };
              if (selector.includes('terminaltype')) return { textContent: '终端类型:PC' };
              if (selector.includes('|org')) return { textContent: '组织管理:企业账号级' };
              if (selector.includes('showSearchCommon|viewtype')) return { textContent: '页面类型:通用报销单' };
              if (selector.includes('wui-tag-selected')) return { textContent: '通用报销单' };
              return {};
            },
            querySelectorAll: () => [{ textContent: '通用报销单' }, { textContent: '移动表单(移动端)' }],
          };
          global.document = { querySelector: () => list };
          try {
            assert.equal(fn(arg), false, 'list must wait for a successful new request');
            state.loaded = true;
            return fn(arg);
          } finally { global.document = old; }
        }
        if (typeof arg === 'string') return true;
        if (arg?.position) return '通用报销单';
        return fn.toString().includes('document.title') ? 'All SEASONS PROPERTY CO., LTD' : true;
      },
    };
    return { page, query: () => filled };
  }
  const pathA = ['财务云', '报账服务', '通用报销单'];
  const pathB = ['其他', '通用报销单'];
  const fallback = pageFor([pathA]);
  const result = await locateModel({}, fallback.page, { templateId: '123', field: 'department', desired: {} });
  assert.equal(fallback.query(), '通用报销单');
  assert.equal(result.status, 'template_not_found');
  assert.deepEqual(result.documentPath, pathA);
  const missing = pageFor([]);
  assert.equal((await locateModel({}, missing.page, { templateId: '123', documentName: '不存在', field: 'department', desired: {} })).status, 'document_not_found');
  const duplicate = pageFor([pathA, pathB]);
  const ambiguous = await locateModel({}, duplicate.page, { templateId: '123', documentName: '通用报销单', field: 'department', desired: {} });
  assert.equal(ambiguous.status, 'ambiguous_document');
  assert.equal(ambiguous.candidates.length, 2);
  const qualified = pageFor([pathA, pathB], [{ templateId: '123' }, { templateId: '124' }]);
  const selected = await locateModel({}, qualified.page, { templateName: 'Expense', documentPath: pathB, field: 'department', desired: {} });
  assert.equal(selected.status, 'ambiguous_template');
  assert.deepEqual(selected.documentPath, pathB);
  const missingType = pageFor([pathA]);
  const noType = await locateModel({}, missingType.page, { templateId: '123', pageType: 'missing', field: 'department', desired: {} });
  assert.equal(noType.status, 'page_type_not_found');
  assert.deepEqual(noType.candidates, ['通用报销单']);
});

test('readback rejects a different persistent field ID even if node ID and name match', async () => {
  const { verifyModel } = await import('../scripts/asp-template.mjs');
  const { page } = designerPage({ nodeAttributes: { id: 'different-id' } });
  const result = await verifyModel({ newPage: async () => page }, page, { ...target, fieldId: 'expected-id', desired: {} });
  assert.equal(result.status, 'field_not_found');
});

test('field lookup returns usable cross-scope identities without writing', async () => {
  const { updateModel } = await import('../scripts/asp-template.mjs');
  const billNo = 'purchase_order';
  const detail = { nid: 'detail-node', id: 'persistent-42', uiTable: 'BillItemBase', entityCode: 'purchase_order_lines', iTplId: target.templateId, cItemName: 'department', cShowCaption: 'Department' };
  const { page, actions } = designerPage({ billNo, nodeAttributes: detail, nodes: [detail] });
  const { nid, entityCode, ...base } = target;
  const result = await updateModel({}, page, { ...base, billNo, fieldScope: 'header', desired: { 'UI#required': true } });
  assert.equal(result.status, 'field_not_found');
  assert.deepEqual(result.candidates, [{ fieldScope: 'detail', entityCode: 'purchase_order_lines', detailEntity: 'purchase_order_lines', field: 'department', fieldName: 'Department', nid: 'detail-node', fieldId: 'persistent-42' }]);
  assert.deepEqual(actions, []);
});

test('field lookup describes searched entities when no exact candidate exists', async () => {
  const { locateModel } = await import('../scripts/asp-template.mjs');
  const billNo = 'purchase_order';
  const header = { nid: 'header-node', uiTable: 'BillItemBase', entityCode: billNo, iTplId: target.templateId, cItemName: 'department', cShowCaption: 'Department' };
  const detail = { ...header, nid: 'detail-node', entityCode: 'purchase_order_lines', cItemName: 'amount', cShowCaption: 'Amount' };
  const { page } = designerPage({ billNo, nodes: [header, detail] });
  const result = await locateModel({ page: () => page }, page, { designerUrl, templateId: target.templateId, field: 'missing', desired: {} });
  assert.equal(result.status, 'field_not_found');
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.searchedEntities, [
    { fieldScope: 'header', entityCode: billNo, fieldCount: 1, sampleFields: [{ field: 'department', fieldName: 'Department' }] },
    { fieldScope: 'detail', entityCode: 'purchase_order_lines', fieldCount: 1, sampleFields: [{ field: 'amount', fieldName: 'Amount' }] },
  ]);
});

test('template fields inherit template identity when their own iTplId is absent', async () => {
  const { locateModel } = await import('../scripts/asp-template.mjs');
  const dynamic = { nid: 'dynamic-node', uiTable: 'BillItemBase', entityCode: target.billNo, cItemName: 'dynamic_field', cShowCaption: 'Dynamic field' };
  const { page } = designerPage({ nodes: [dynamic], nodeId: dynamic.nid, nodeAttributes: dynamic });
  const result = await locateModel({ page: () => page }, page, { designerUrl, templateId: target.templateId, field: 'dynamic_field', desired: {} });
  assert.equal(result.nid, 'dynamic-node');
  assert.equal(result.field, 'dynamic_field');
  assert.equal(result.templateId, target.templateId);
});

test('template field lookup excludes fields nested in another template', async () => {
  const { locateModel } = await import('../scripts/asp-template.mjs');
  const dynamic = { nid: 'other-node', uiTable: 'BillItemBase', entityCode: target.billNo, cItemName: 'dynamic_field', cShowCaption: 'Dynamic field' };
  const { page } = designerPage({ nodes: [] });
  page.evaluate = async (fn, arg) => {
    const oldWindow = global.window;
    const oldDocument = global.document;
    const tools = new Map([['ai.page.save', {}]]);
    global.window = { ydf: { scene: { yonCodePanelModel: { _aiTools: tools }, aiPageSave() {} } }, yyds: { getGlobalData: () => ({ cBillNo: target.billNo, children: [
      { uiTable: 'BillTemplateBase', iTplId: target.templateId, children: [] },
      { uiTable: 'BillTemplateBase', iTplId: 'other', children: [dynamic] },
    ] }) } };
    global.document = { title: 'Expense - 单据设计器' };
    try { return await fn(arg); } finally { global.window = oldWindow; global.document = oldDocument; }
  };
  const result = await locateModel({ page: () => page }, page, { designerUrl, templateId: target.templateId, field: 'dynamic_field', desired: {} });
  assert.equal(result.status, 'field_not_found');
  assert.deepEqual(result.candidates, []);
});

test('readback uniquely resolves an ID-less field in the same entity after nid changes', async () => {
  const { verifyModel } = await import('../scripts/asp-template.mjs');
  const node = { nid: 'new-node', id: '', iTplId: '', uiTable: 'BillItemBase', entityCode: target.billNo, cItemName: target.field, cShowCaption: 'Department' };
  const { page } = designerPage({ nodeId: node.nid, nodeAttributes: node, nodes: [node] });
  const result = await verifyModel({ newPage: async () => page }, page, { ...target, desired: {} });
  assert.equal(result.nid, 'new-node');
  assert.equal(result.reopenedByFieldCode, true);
});

test('readback does not substitute an explicitly selected nid or choose among duplicate codes', async () => {
  const { verifyModel } = await import('../scripts/asp-template.mjs');
  const node = { nid: 'new-node', id: '', iTplId: '', uiTable: 'BillItemBase', entityCode: target.billNo, cItemName: target.field, cShowCaption: 'Department' };
  for (const [nodes, extra] of [[[node], { fieldNid: 'original-node' }], [[node, { ...node, nid: 'another-node' }], {}]]) {
    const { page } = designerPage({ nodeId: node.nid, nodeAttributes: node, nodes });
    const result = await verifyModel({ newPage: async () => page }, page, { ...target, ...extra, desired: {} });
    assert.notEqual(result.matches, true);
    assert.ok(['field_not_found', 'ambiguous_field'].includes(result.status));
  }
});

test('template lookup excludes a leaf with a conflicting explicit template ID', async () => {
  const { locateModel } = await import('../scripts/asp-template.mjs');
  const node = { nid: 'other-node', iTplId: 'other', uiTable: 'BillItemBase', entityCode: target.billNo, cItemName: 'dynamic_field' };
  const { page } = designerPage({ nodes: [node] });
  const result = await locateModel({ page: () => page }, page, { designerUrl, templateId: target.templateId, field: 'dynamic_field', desired: {} });
  assert.equal(result.status, 'field_not_found');
  assert.deepEqual(result.candidates, []);
});

test('batch workflow opens a fresh designer, reads actual values and closes without writing', async () => {
  const { verifyBatchField } = await import('../scripts/asp-template.mjs');
  const properties = [{ code: 'bShowIt', name: '显示', value: false, isNormal: true, disabled: false }];
  const { page, actions } = designerPage({ properties });
  const events = [];
  page.goto = async url => { events.push(['goto', url]); };
  page.events = async () => { events.push(['events']); return []; };
  page.close = async () => { events.push(['close']); };
  const selection = { templateId: target.templateId, designerUrl, field: target.field, fieldScope: 'header', expected: { bShowIt: false } };
  const result = await verifyBatchField({ newPage: async () => { events.push(['newPage']); return page; } }, null, { index: 0, target: selection, previousRows: [], targets: [selection] });
  assert.equal(result.allSelectedFieldsMatch, true);
  assert.deepEqual(result.rows[0].actual, { bShowIt: false });
  assert.equal(result.rows[0].status, 'matched');
  assert.deepEqual(events, [['newPage'], ['goto', designerUrl], ['events'], ['close']]);
  assert.deepEqual(actions, []);
});
