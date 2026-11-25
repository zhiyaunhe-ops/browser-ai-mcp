// Runs inside the ego TaskSpace. The workbench list binds the business template
// ID to its designer URL; the designer's PT identifier is a different key.
const workbench = 'https://global.yonyoucloud.com/';
const tenantTitle = 'All SEASONS PROPERTY CO., LTD';
const defaultDocument = '通用报销单';

async function until(read, description) {
  const deadline = Date.now() + 45000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + description);
}

function documentNodes(input) {
  const list = document.querySelector('#GZTTMP011');
  const nodes = [...list.querySelectorAll('.wui-tree .tree-node-title[title]')];
  const empty = list.querySelector('.search-tree-out-container .wui-empty-description');
  if (empty?.textContent.trim() === '搜索无结果') return input.openPosition === undefined ? [] : false;
  const query = input.documentName.toLowerCase();
  const filtered = nodes.some(node => node.querySelector('.high-light')?.textContent.toLowerCase() === query);
  if (!filtered) return false;
  const matches = [];
  for (const node of nodes) {
    const leaf = node.closest('li');
    if (!leaf.classList.contains('wui-tree-treenode-leaf') || node.title !== input.documentName) continue;
    const documentPath = [];
    for (let li = leaf; li; li = li.parentElement.closest('li')) {
      documentPath.unshift(li.querySelector(':scope > div .tree-node-title').title);
    }
    if (input.documentPath && (input.documentPath.length !== documentPath.length ||
        input.documentPath.some((name, index) => name !== documentPath[index]))) continue;
    const link = node.closest('a');
    if (input.openPosition === link.getAttribute('pos')) {
      const state = { startedAt: performance.now(), loaded: false };
      state.observer = new PerformanceObserver(entries => {
        state.loaded ||= entries.getEntries().some(entry => entry.startTime >= state.startedAt &&
          new URL(entry.name, location.href).pathname === '/iuap-metadata-ui/template/manage/listTenantTemplates' &&
          entry.responseStatus === 200);
      });
      state.observer.observe({ type: 'resource' });
      list[Symbol.for('asp-template-list-load')] = state;
      link.click();
      return true;
    }
    matches.push({ documentName: node.title, documentPath, position: link.getAttribute('pos') });
  }
  return input.openPosition === undefined ? matches : false;
}

function templateListState({ position, pageType }) {
  const list = document.querySelector('#GZTTMP011');
  const selected = list.querySelector('.wui-tree-treenode-selected > div > a');
  if (selected?.getAttribute('pos') !== position) return false;
  // The selected filters can render before the tenant-template list is refreshed.
  const state = list[Symbol.for('asp-template-list-load')];
  if (!state?.loaded) return false;
  const tag = key => list.querySelector('[fieldid="mdd_templatelist|showSearchCommon|' + key + '"] .wui-tag-text')?.textContent.trim();
  const selector = '[fieldid^="GZTTMP011|viewtype|"]';
  const view = list.querySelector(selector + '.wui-tag-selected')?.textContent.trim();
  if (tag('terminaltype') !== '终端类型:PC' || tag('org') !== '组织管理:企业账号级' ||
      !view || tag('viewtype') !== '页面类型:' + view) return false;
  if (!list.querySelector('.columnkey-tplId[role=gridcell], .noDataHelper .wui-empty')) return false;
  // The PC terminal also offers options explicitly labeled as mobile pages.
  const options = [...list.querySelectorAll(selector)].map(element => ({ element, name: element.textContent.trim() }))
    .filter(({ name }) => !/[(（]移动端[)）]$/.test(name));
  const requested = pageType ?? view;
  const option = options.find(({ name }) => name === requested);
  if (!option) return { status: 'page_type_not_found', candidates: options.map(({ name }) => name) };
  if (view === requested) return { pageType: view };
  if (state.pageTypeRequested) return false;
  state.pageTypeRequested = true;
  state.startedAt = performance.now();
  state.loaded = false;
  option.element.click();
  return false;
}

async function openList(page, input) {
  await page.goto(workbench);
  const search = 'input[placeholder="人员/服务等"]';
  await until(() => page.evaluate(s => !!document.querySelector(s), search), 'ASP workbench search');
  if (await page.evaluate(() => document.title) !== tenantTitle) throw new Error('Expected the All Seasons Property workbench');
  await page.fill(search, 'UI模板');
  await until(() => page.evaluate(() => {
    const entry = [...document.querySelectorAll('p.name')].find(el => el.textContent.trim() === 'UI模板' && el.getClientRects().length);
    if (entry) entry.click();
    return !!entry;
  }), 'UI模板 search result');
  const keyword = '#GZTTMP011 input[placeholder="请输入关键字"]';
  await until(() => page.evaluate(s => !!document.querySelector(s) &&
    !!document.querySelector('#GZTTMP011 .wui-tree .tree-node-title[title]'), keyword), 'template tree');
  const documentName = input.documentName ?? input.documentPath?.at(-1) ?? defaultDocument;
  const documentQuery = { documentName, documentPath: input.documentPath };
  await page.fill(keyword, documentName);
  const documents = await until(() => page.evaluate(documentNodes, documentQuery), 'filtered template tree');
  if (documents.length !== 1) {
    return { status: documents.length ? 'ambiguous_document' : 'document_not_found',
      candidates: documents.map(({ documentName, documentPath }) => ({ documentName, documentPath })) };
  }
  const [{ position, documentPath }] = documents;
  try {
    await until(() => page.evaluate(documentNodes, { ...documentQuery, openPosition: position }),
      'document selection for ' + documentName);
    const selection = await until(() => page.evaluate(templateListState, { position, pageType: input.pageType }),
      'enterprise PC templates for ' + documentName);
    return { documentName, documentPath, ...selection };
  } finally {
    await page.evaluate(() => {
      const list = document.querySelector('#GZTTMP011');
      const key = Symbol.for('asp-template-list-load');
      if (list?.[key]) {
        list[key].observer.disconnect();
        delete list[key];
      }
    });
  }
}

function templateRows(input) {
  const matches = new Map();
  for (const row of document.querySelectorAll('#GZTTMP011 [role=row]')) {
    const cell = key => row.querySelector('.columnkey-' + key)?.textContent.trim();
    const templateId = cell('tplId'), templateName = cell('tplName'), transactionType = cell('transTypeName');
    if (!/^\d+$/.test(templateId) || (input.templateId && input.templateId !== templateId) ||
        (input.templateName && input.templateName !== templateName) ||
        (input.transactionType && input.transactionType !== transactionType)) continue;
    const button = row.querySelector('[id^="btnDesign"]');
    if (input.openId === templateId) {
      if (button) {
        button.click();
        return { opened: true };
      }
      const more = row.querySelector('[fieldid*="|more-action-menu|"]');
      if (more) return { more: more.getAttribute('fieldid') };
    }
    matches.set(templateId, { templateId, templateName, transactionType });
  }
  return input.openId ? false : [...matches.values()];
}

async function locateDesigner(task, page, input) {
  const document = await openList(page, input);
  if (document.status) return document;
  const candidates = await page.evaluate(templateRows, input);
  if (candidates.length !== 1) {
    return { ...document, status: candidates.length ? 'ambiguous_template' : 'template_not_found', candidates };
  }
  const [target] = candidates;
  const previous = (await task.tabs()).map(tab => tab.label);
  const action = await until(() => page.evaluate(templateRows, { ...input, openId: target.templateId }),
    'design action for template ' + target.templateId);
  if (action.more) {
    await page.hover('[fieldid="' + action.more + '"]');
    const index = action.more.split('|').at(-1);
    await until(() => page.evaluate(i => {
      const item = document.querySelector('[role=menuitem] [fieldid="mdd_templatelist|btnDesign|' + i + '"]');
      if (!item?.getClientRects().length) return false;
      item.click();
      return true;
    }, index), 'Design in the selected template menu');
  }
  const tab = await until(async () => (await task.tabs()).find(tab => tab.label && !previous.includes(tab.label) &&
    tab.url.startsWith(workbench + 'iuap-yonbuilder-designer/') &&
    tab.title.replace(/\s*-\s*单据设计器$/, '') === target.templateName), 'designer for ' + target.templateName);
  return { ...document, ...target, designerUrl: tab.url, pageLabel: tab.label };
}

// Executed in the designer tab. Use YonCode's own field actions and save flow.
async function designerModel(input) {
  const scene = window.ydf?.scene;
  const tree = window.yyds?.getGlobalData('tplTree');
  const tools = scene?.yonCodePanelModel?._aiTools;
  if (!tree?.children || !tools?.get('ai.page.save') || typeof scene.aiPageSave !== 'function') return false;

  const templateName = document.title.replace(/\s*-\s*单据设计器$/, '');
  const billNo = tree.cBillNo;
  if (!billNo || (input.billNo && input.billNo !== billNo) ||
      (input.templateName && input.templateName !== templateName)) {
    return { status: 'template_mismatch' };
  }
  const templates = tree.children.filter(node => node.uiTable === 'BillTemplateBase' && !node.isDeleted);
  const template = templates.find(node => String(node.iTplId) === input.templateId);
  if (templates.length && !template) return { status: 'template_mismatch' };

  const fieldScope = input.fieldScope ?? 'header';
  const entities = tree.children.find(node => node.uiTable === 'BillEntityBaseList');
  const headerEntity = entities?.children?.find(node => node.bMain === true)?.cCode ?? billNo;
  const matchesScope = node => node.entityCode && (node.entityCode === headerEntity ? 'header' : 'detail') === fieldScope &&
    (!input.detailEntity || node.entityCode === input.detailEntity) &&
    (!input.entityCode || node.entityCode === input.entityCode);
  const fieldIdOf = node => node.id ? String(node.id) : undefined;
  const matchesIdentity = node => {
    if (input.fieldId && fieldIdOf(node) !== input.fieldId) return false;
    if (input.nid) {
      // The designer can assign a new nid each time it opens a stored field.
      return (input.fieldId || node.nid === input.nid) && node.cItemName === input.field;
    }
    return (!input.fieldNid || node.nid === input.fieldNid) &&
      [node.cItemName, node.cShowCaption, node.cCaption, node.uititle].includes(input.field);
  };
  const matches = [];
  function visit(node) {
    if (node.isDeleted) return;
    if (node.uiTable === 'BillItemBase' && node.nid && node.cItemName &&
        String(node.iTplId) === input.templateId && matchesScope(node) &&
        matchesIdentity(node)) {
      matches.push(node);
    }
    node.children?.forEach(visit);
  }
  visit(template ?? tree);
  const identify = node => ({ fieldScope, entityCode: node.entityCode, field: node.cItemName,
    fieldName: node.cShowCaption || node.cCaption || node.uititle || node.cItemName, nid: node.nid,
    ...(fieldIdOf(node) ? { fieldId: fieldIdOf(node) } : {}) });
  if (matches.length !== 1) {
    return { status: matches.length ? 'ambiguous_field' : 'field_not_found', candidates: matches.map(identify) };
  }
  const identity = { templateId: input.templateId, templateName, billNo, ...identify(matches[0]) };
  const { nid } = identity;
  const props = scene.propSettingModel;
  const hasFieldPanel = () => props.innerTplNode?.nid === nid && props.innerCompMeta;
  if (!hasFieldPanel()) {
    scene.updateCurrNode(nid);
    // Reissuing selection too quickly postpones the designer's debounced update.
    for (let attempt = 0; attempt < 15 && !hasFieldPanel(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!hasFieldPanel()) return false;
  }

  const meta = props.innerCompMeta;
  const referConfig = meta.getProp('UI#referConfig');
  // The reference dialog owns this setting. Its code is exposed by the native action.
  const referenceType = referConfig && tools.get('ai.elem.setRefType') && {
    code: 'cRefType', name: '参照编码', controlType: 'string', isNormal: true,
    disabled: referConfig.disabled, visible: referConfig.visible,
  };
  const properties = referenceType && !meta.getProp(referenceType.code)
    ? [...meta.normalProps, referenceType]
    : meta.normalProps;
  if (!properties.length) return { status: 'field_properties_unavailable', ...identity };
  const getProp = key => meta.getProp(key) ?? (key === referenceType?.code ? referenceType : undefined);
  const actions = {
    formula: ['ai.elem.setFormula', value => value === null ? {} : { formula: value.expression, formulaDisplay: value.display }],
    'UI#cShowCaption': ['ai.elem.setCaption', value => ({ caption: value })],
    cDefaultValue: ['ai.elem.setDefaultValue', value => ({ cDefaultValue: value })],
    cEnumType: ['ai.elem.setEnumType', value => ({ cEnumType: value })],
    cRefType: ['ai.elem.setRefType', value => ({ cRefType: value })],
  };
  const canEdit = prop => {
    if (!prop.isNormal || prop.disabled) return false;
    if (prop.code === 'cRefType' && window.yyds.getReferCanNotEditReferType?.(matches[0])) return false;
    if (Object.hasOwn(actions, prop.code)) return Boolean(tools.get(actions[prop.code][0]));
    return prop.controlType !== 'IframeModal';
  };
  const isReference = ['refer', 'treerefer', 'listrefer', 'multirefer'].includes(matches[0].uitype);
  const read = key => {
    const node = window.yyds.getNodeByNid(nid);
    if (key === 'formula') {
      return Number(node.iFormula) === 1
        ? { expression: node.formula, display: node.formulaDisplay ?? '' }
        : null;
    }
    if (key === 'cDefaultValue' && isReference && node.cRefDefaultValue) return JSON.parse(node.cRefDefaultValue);
    if (['cDefaultValue', 'cEnumType', 'cRefType'].includes(key)) return node[key] ?? null;
    return props.innerCompMeta.getProp(key)?.value ?? null;
  };
  if (!Object.keys(input.desired).length) {
    const describe = prop => {
      const { code, name, controlType: type, visible } = prop;
      const result = { code, name, type, visible, disabled: !canEdit(prop), value: read(code) };
      if (type === 'Select' || type === 'Radio') {
        const source = type === 'Select' && Array.isArray(prop.data) && prop.data.length ? prop.data : prop.options;
        if (Array.isArray(source)) result.options = source.filter(option => type !== 'Select' || option?.visible !== false)
          .map(option => option && typeof option === 'object'
            ? { value: option[prop.valueKey || 'value'], label: option[prop.labelKey || 'label'] ?? option.text }
            : { value: option });
      }
      return result;
    };
    return { ...identity, properties: properties.map(describe), matches: true };
  }
  const desired = new Map();
  for (const [key, value] of Object.entries(input.desired)) {
    let prop = getProp(key);
    if (!prop) {
      const named = properties.filter(item => item.name === key);
      if (named.length > 1) throw new Error('Ambiguous field property name: ' + key + ' (' + named.map(item => item.code).join(', ') + ')');
      [prop] = named;
    }
    if (!prop) throw new Error('Field property is unavailable: ' + key);
    if (prop.code === 'formula' && key !== 'formula') throw new Error('Use changes.formula to set or clear a calculation formula');
    if (desired.has(prop.code)) throw new Error('Supply field property ' + prop.code + ' once');
    desired.set(prop.code, value);
  }
  const snapshot = () => Object.fromEntries([...desired.keys()].map(key => [key, read(key)]));
  const same = (value, expected) => {
    if (Array.isArray(expected)) {
      return Array.isArray(value) && value.length === expected.length && expected.every((v, i) => same(value[i], v));
    }
    if (expected && typeof expected === 'object') {
      return !!value && typeof value === 'object' && Object.keys(value).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, v]) => Object.hasOwn(value, key) && same(value[key], v));
    }
    return value === expected;
  };
  // The default-value action stores dates and multi-select values in its protocol format.
  const expected = (key, value) => {
    if (key !== 'cDefaultValue') return value;
    if (value === null || value === '') return null;
    const node = window.yyds.getNodeByNid(nid);
    if (node.uitype === 'datepicker') {
      if (node.cFormatData === 'YYYY') return value + '-01-01';
      if (node.cFormatData === 'YYYY-MM') return value + '-01';
    }
    if (node.uitype === 'datetimepicker' && node.cFormatData === 'YYYY-MM-DD HH:mm') return value + ':00';
    if (Array.isArray(value) && ['select', 'radio', 'booleanoption'].includes(node.uitype)) return value.join(',');
    if (isReference && value && typeof value === 'object' && !Array.isArray(value)) {
      const { children, ...record } = value;
      return Object.keys(record).length ? record : null;
    }
    return value;
  };
  const before = snapshot();
  const pending = [...desired].filter(([key, value]) => !same(before[key], expected(key, value)));
  if (!input.write || !pending.length) return { ...identity, values: before, matches: !pending.length, changed: false };
  // Other changes can reset defaults. Apply an explicitly supplied default last.
  const otherChanges = pending.filter(([key]) => key !== 'cDefaultValue');
  const updates = desired.has('cDefaultValue') ? [...otherChanges, ['cDefaultValue', desired.get('cDefaultValue')]] : otherChanges;

  const execute = async (name, args) => {
    const action = tools.get(name)?.tool;
    if (!action) throw new Error('Designer action is unavailable: ' + name);
    const result = await action.execute(args);
    if (typeof result === 'string') throw new Error(name + ': ' + result);
    return result;
  };
  for (const [key] of updates) {
    if (!canEdit(getProp(key))) throw new Error('Field property is unavailable for editing: ' + key);
  }
  if (scene.viewNoSave) throw new Error('The designer has unsaved changes');

  for (const [key, value] of updates) {
    if (same(read(key), expected(key, value))) continue;
    const [name, args] = Object.hasOwn(actions, key)
      ? actions[key]
      : ['ai.elem.set', propValue => ({ propName: key, propValue })];
    const result = await execute(name, { nid, ...args(value) });
    if (result?.nid !== nid) throw new Error('The designer did not confirm the change to ' + key);
  }
  const staged = snapshot();
  if ([...desired].some(([key, value]) => !same(staged[key], expected(key, value)))) {
    throw new Error('The designer staged different values: ' + JSON.stringify(staged));
  }
  const saved = await execute('ai.page.save', {});
  if (!saved?.success) throw new Error('Designer save failed: ' + JSON.stringify(saved));
  return { ...identity, changed: true };
}

export async function locateModel(task, page, input) {
  const target = input.designerUrl
    ? { templateId: input.templateId, templateName: input.templateName, designerUrl: input.designerUrl, pageLabel: 'p1' }
    : await locateDesigner(task, page, input);
  if (target.status) return target;
  const designer = task.page(target.pageLabel);
  if (input.designerUrl) await designer.goto(input.designerUrl);
  const found = await until(() => designer.evaluate(designerModel, { ...input, ...target }), 'designer field model');
  return { ...target, ...found };
}

export async function updateModel(task, page, input) {
  if (await page.url() !== input.designerUrl) throw new Error('The selected designer changed before saving');
  // Work on a dedicated designer tab. Only return the save receipt, never the
  // request body or headers. The independent readback also works without a receipt.
  const capture = await page.cdp('Network.enable', { maxPostDataSize: 262144 })
    .then(() => page.events()).then(() => true, () => false);
  const result = await until(() => page.evaluate(designerModel, { ...input, write: true }), 'designer field update');
  if (!capture || !result.changed) return result;
  const events = await page.events().catch(() => []);
  const path = '/iuap-yonbuilder-designer/iuap-front/ide/module/ext';
  const endpoint = new URL(path, input.designerUrl);
  const requests = new Set();
  for (const { method, params } of events) {
    if (method === 'Network.requestWillBeSent') {
      const request = params.request;
      if (request.method !== 'POST' || request.url.split('?')[0] !== endpoint.href) continue;
      try {
        const business = JSON.parse(JSON.parse(request.postData).businessJson);
        const billNo = result.billNo ?? input.billNo;
        if (billNo && business.tplId === input.templateId && business.billNo === billNo) requests.add(params.requestId);
      } catch { /* The browser can omit large request bodies from its event buffer. */ }
    }
    if (method === 'Network.responseReceived' && requests.has(params.requestId) &&
        params.response.url.split('?')[0] === endpoint.href) {
      return { ...result, savePost: { method: 'POST', path, templateId: input.templateId, status: params.response.status } };
    }
  }
  return result;
}

export async function verifyModel(task, page, input) {
  const reader = await task.newPage();
  await reader.goto(input.designerUrl);
  return until(() => reader.evaluate(designerModel, input), 'reopened designer field model');
}

// Keep the scalar required-field result used by existing MCP callers and runs.
function requiredValue(result) {
  if (result.status) return result;
  const { values, matches, changed, ...identity } = result;
  return { ...identity, required: values['UI#required'] };
}

export async function locate(task, page, input) {
  return requiredValue(await locateModel(task, page, { ...input, desired: { 'UI#required': true } }));
}

export async function update(task, page, target) {
  return updateModel(task, page, { ...target, desired: { 'UI#required': target.desired } });
}

export async function verify(task, page, target) {
  const rows = await page.evaluate(templateRows, { templateId: target.templateId, templateName: target.templateName,
    transactionType: target.transactionType });
  if (rows.length !== 1) throw new Error('Template identity changed before verification');
  return { ...rows[0], ...requiredValue(await verifyModel(task, page, { ...target, desired: { 'UI#required': true } })) };
}
