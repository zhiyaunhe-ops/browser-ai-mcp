// Runs inside the ego TaskSpace. The workbench list binds the business template
// ID to its designer URL; the designer's PT identifier is a different key.
const workbench = 'https://global.yonyoucloud.com/';
const tenantTitle = 'All SEASONS PROPERTY CO., LTD';
const codeInput = '[fieldid="design|InputText|cItemName|Input"]';
const requiredSwitch = 'button[fieldid="design|InputBool|UI#required|Switch"]';
const saveButton = '.designLayoutTopRight button.saveBtn';

async function until(read, description) {
  const deadline = Date.now() + 45000;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 350));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + description);
}

async function openList(page) {
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
  await until(() => page.evaluate(s => !!document.querySelector(s), keyword), 'template tree');
  await page.fill(keyword, '报销');
  for (const name of ['财务云', '费控服务', '报账服务', '通用报销单']) {
    await until(() => page.evaluate(n => {
      const item = [...document.querySelectorAll('#GZTTMP011 .wui-tree-title [title]')].find(e => e.title === n);
      if (!item) return false;
      const li = item.closest('li');
      if (n === '通用报销单') item.closest('a').click();
      else if (li.classList.contains('wui-tree-treenode-close')) li.querySelector('.wui-tree-switcher').click();
      return true;
    }, name), name);
  }
  await until(() => page.evaluate(() => {
    const list = document.querySelector('#GZTTMP011');
    return ['终端类型:PC','页面类型:通用报销单','组织管理:企业账号级'].every(flag => list.innerText.includes(flag)) &&
      [...list.querySelectorAll('.columnkey-tplId[role=gridcell]')].some(cell => /^\d+$/.test(cell.textContent.trim()));
  }), 'enterprise PC reimbursement templates');
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

async function selectField(page, field) {
  const labels = '.labelWrapper[fieldid^="znbzbx_expensebill|"][fieldid$="_tips"]';
  await until(() => page.evaluate(s => !!document.querySelector(s), labels), 'reimbursement header fields');
  const candidates = await page.evaluate(({ labels, field }) => {
    const found = [...document.querySelectorAll(labels)].map(el => ({
      field: el.getAttribute('fieldid').split('|')[1].slice(0, -5), fieldName: el.title, el
    })).filter(item => item.field === field || item.fieldName === field);
    if (found.length === 1) found[0].el.click();
    return found.map(({ field, fieldName }) => ({ field, fieldName }));
  }, { labels, field });
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous_field' : 'field_not_found', candidates };
  const [selected] = candidates;
  const property = await until(() => page.evaluate(({ codeInput, requiredSwitch, field }) => {
    const code = document.querySelector(codeInput), toggle = document.querySelector(requiredSwitch);
    return code?.value === field && toggle && { required: toggle.classList.contains('is-checked') };
  }, { codeInput, requiredSwitch, field: selected.field }), 'required property for ' + selected.field);
  return { ...selected, ...property };
}

export async function locate(task, page, input) {
  await openList(page);
  const candidates = await page.evaluate(templateRows, input);
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous_template' : 'template_not_found', candidates };
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
  const designer = task.page(tab.label);
  return { ...target, ...await selectField(designer, input.field), designerUrl: tab.url, pageLabel: tab.label };
}

export async function update(task, page, target) {
  if (await page.url() !== target.designerUrl) throw new Error('The selected designer changed before saving');
  const state = await selectField(page, target.field);
  if (state.field !== target.field) throw new Error('The selected field changed before saving');
  if (state.required === target.desired) return { changed: false };
  const clicked = await page.evaluate(({ codeInput, requiredSwitch, target }) => {
    const toggle = document.querySelector(requiredSwitch);
    if (document.querySelector(codeInput)?.value !== target.field || !toggle || toggle.disabled ||
        toggle.classList.contains('is-checked') === target.desired) return false;
    toggle.click();
    return true;
  }, { codeInput, requiredSwitch, target });
  if (!clicked) throw new Error('Required switch could not be changed');
  await until(() => page.evaluate(({ codeInput, requiredSwitch, saveButton, target }) => {
    const toggle = document.querySelector(requiredSwitch), save = document.querySelector(saveButton);
    return document.querySelector(codeInput)?.value === target.field && toggle &&
      toggle.classList.contains('is-checked') === target.desired && save && !save.disabled;
  }, { codeInput, requiredSwitch, saveButton, target }), 'changed property and enabled Save');
  await page.click(saveButton);
  await until(() => page.evaluate(s => document.querySelector(s)?.disabled, saveButton), 'designer save completion');
  return { changed: true };
}

export async function verify(task, page, target) {
  // Resolve the template ID again from the workbench, then open the designer
  // captured from that row in a fresh page to read the persisted property.
  const rows = await page.evaluate(templateRows, { templateId: target.templateId, templateName: target.templateName,
    transactionType: target.transactionType });
  if (rows.length !== 1) throw new Error('Template identity changed before verification');
  const reader = await task.newPage();
  await reader.goto(target.designerUrl);
  await until(() => reader.evaluate(name => document.title.replace(/\s*-\s*单据设计器$/, '') === name, target.templateName),
    'reopened template');
  return { ...rows[0], ...await selectField(reader, target.field) };
}
