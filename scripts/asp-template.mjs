// Runs inside the ego TaskSpace. The workbench list binds the business template
// ID to its designer URL; the designer's PT identifier is a different key.
const { workbench, openTemplateList } = await import('./asp-workbench.mjs' + new URL(import.meta.url).search);

async function until(read, description) {
  const deadline = Date.now() + 45000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + description);
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
  const document = await openTemplateList(task, page, input);
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
  const scopeOf = node => node.entityCode === headerEntity ? 'header' : 'detail';
  const matchesScope = node => scopeOf(node) === fieldScope &&
    (!input.detailEntity || node.entityCode === input.detailEntity) &&
    (!input.entityCode || node.entityCode === input.entityCode);
  const fieldIdOf = node => node.id ? String(node.id) : undefined;
  const matchesName = node => [node.cItemName, node.cShowCaption, node.cCaption, node.uititle].includes(input.field);
  const reopenByFieldCode = input.reopened && !input.write && input.nid && !input.fieldId && !input.fieldNid &&
    input.billNo && input.fieldScope && input.entityCode;
  const matchesIdentity = node => {
    if (input.fieldId && fieldIdOf(node) !== input.fieldId) return false;
    if (input.fieldNid && node.nid !== input.fieldNid) return false;
    if (input.nid) {
      // The designer can assign a new nid each time it opens a stored field.
      return (input.fieldId || reopenByFieldCode || node.nid === input.nid) && node.cItemName === input.field;
    }
    return matchesName(node);
  };
  const fields = [];
  function visit(node, inTemplate = false) {
    if (node.isDeleted) return;
    if (node.uiTable === 'BillTemplateBase') {
      if (String(node.iTplId) !== input.templateId) return;
      inTemplate = true;
    }
    // Custom fields can inherit their template from the enclosing designer node.
    const belongsToTemplate = node.iTplId == null || node.iTplId === ''
      ? inTemplate
      : String(node.iTplId) === input.templateId;
    if (node.uiTable === 'BillItemBase' && node.nid && node.cItemName && node.entityCode &&
        belongsToTemplate) {
      fields.push(node);
    }
    node.children?.forEach(child => visit(child, inTemplate));
  }
  visit(template ?? tree);
  const matches = fields.filter(node => matchesScope(node) && matchesIdentity(node));
  const fieldNameOf = node => node.cShowCaption || node.cCaption || node.uititle || node.cItemName;
  const identify = node => ({ fieldScope: scopeOf(node), entityCode: node.entityCode, field: node.cItemName,
    fieldName: fieldNameOf(node), nid: node.nid,
    ...(fieldIdOf(node) ? { fieldId: fieldIdOf(node) } : {}) });
  if (matches.length !== 1) {
    // A candidate outside the selection can only be used in a new lookup.
    const candidates = (matches.length ? matches : fields.filter(node =>
      matchesName(node) || (input.fieldId && fieldIdOf(node) === input.fieldId))).map(node => {
      const identity = identify(node);
      const needsNid = !identity.fieldId && fields.some(other =>
        other !== node && other.entityCode === node.entityCode && other.cItemName === node.cItemName);
      return { ...identity,
        ...(identity.fieldScope === 'detail' ? { detailEntity: identity.entityCode } : {}),
        ...(needsNid ? { fieldNid: identity.nid } : {}) };
    });
    const result = { status: matches.length ? 'ambiguous_field' : 'field_not_found', candidates };
    if (candidates.length) return result;

    const searchedEntities = new Map();
    for (const node of fields) {
      const { entityCode, cItemName } = node;
      if (!searchedEntities.has(entityCode)) {
        searchedEntities.set(entityCode, { fieldScope: scopeOf(node), entityCode, fieldCount: 0, sampleFields: [] });
      }
      const entity = searchedEntities.get(entityCode);
      entity.fieldCount++;
      if (entity.sampleFields.length < 5) entity.sampleFields.push({ field: cItemName, fieldName: fieldNameOf(node) });
    }
    return { ...result, searchedEntities: [...searchedEntities.values()] };
  }
  const identity = { templateId: input.templateId, templateName, billNo, ...identify(matches[0]) };
  const { nid } = identity;
  if (reopenByFieldCode && nid !== input.nid) identity.reopenedByFieldCode = true;
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
    if (input.exactPropertyCodes && prop?.code !== key) prop = undefined;
    if (!prop && !input.exactPropertyCodes) {
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
  return until(() => reader.evaluate(designerModel, { ...input, reopened: true }), 'reopened designer field model');
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
  const result = requiredValue(await verifyModel(task, page, {
    ...target, desired: { 'UI#required': true },
  }));
  // The workbench bound the transaction type to this template during lookup.
  if (result.status || result.templateId !== target.templateId) return result;
  return { ...result, transactionType: target.transactionType };
}

export async function verifyBatchField(task, _page, { index, target, previousRows, targets }) {
  const { templateId, templateName, designerUrl, field, fieldScope, detailEntity, fieldId, fieldNid, expected } = target;
  const row = { index, templateId, templateName, designerUrl, field, fieldScope, detailEntity, fieldId, fieldNid,
    expected, actual: null };
  const desired = { ...expected };
  if (desired.formula) {
    desired.formula = { expression: desired.formula.expression, display: desired.formula.display ?? '' };
  }
  try {
    const reader = await task.newPage();
    try {
      await reader.goto(designerUrl);
      const observed = await until(() => reader.evaluate(designerModel, { templateId, templateName, field,
        fieldScope, detailEntity, fieldId, fieldNid, desired, exactPropertyCodes: true }), 'fresh designer field model');
      const { status, values, matches, changed: _changed, candidates, searchedEntities, ...identity } = observed;
      Object.assign(row, { status: status ?? (matches ? 'matched' : 'mismatch'), actual: values ?? null });
      if (identity.templateId) row.identity = identity;
      if (candidates) row.candidates = candidates;
      if (searchedEntities) row.searchedEntities = searchedEntities;
    } finally {
      // The round's network collector can drain this Page only while it is open.
      try { await reader.events(); } catch { /* The collector reports unavailable page events. */ }
      await reader.close();
    }
  } catch (error) {
    row.status = 'read_error';
    row.error = { message: error.message, ...(error.code ? { code: error.code } : {}) };
  }
  if (!previousRows) return { row };
  const rows = [...previousRows, row];
  const allSelectedFieldsMatch = row.status === 'matched' &&
    previousRows.every(item => item.status === 'matched' && item.observationId);
  return { allSelectedFieldsMatch, rows, ...(allSelectedFieldsMatch ? { verifiedTargets: targets } : {}) };
}
