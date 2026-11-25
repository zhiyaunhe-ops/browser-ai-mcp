export const workbench = 'https://global.yonyoucloud.com/';
const tenantTitle = 'All SEASONS PROPERTY CO., LTD';
const workbenchSearch = 'input[placeholder="人员/服务等"]';
const nodePath = '/iuap-apcom-workbench/service/getServiceInfoWithDetail';
const templateNode = { nodeName: 'UI模板', nodeCode: 'GZTTMP011' };

async function waitFor(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

async function ready(page) {
  if (await page.url() !== workbench) await page.goto(workbench);
  const matches = await waitFor(() => page.evaluate(({ search, title }) =>
    location.href === 'https://global.yonyoucloud.com/' && document.title === title && !!document.querySelector(search),
  { search: workbenchSearch, title: tenantTitle }), 45000);
  if (!matches) throw new Error('Expected the All Seasons Property workbench');
}

function nodeCodes({ nodeName, nodeCode }) {
  const codes = [...document.querySelectorAll('[fieldid="nav-node"][id^="degree4th-"]')]
    .filter(element => element.title === nodeName)
    .map(element => element.id.slice('degree4th-'.length));
  return [...new Set(codes)].filter(code => !nodeCode || nodeCode === code);
}

async function openNativeNode({ path, nodeName, nodeCode }) {
  if (typeof window.jDiwork?.openService !== 'function') return { fallbackReason: 'native_navigation_unavailable' };
  const url = path + '?' + new URLSearchParams({ serviceCode: nodeCode, serviceType: '0' });
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', isAjax: 'true' },
      signal: AbortSignal.timeout(8000) });
    const request = { method: 'GET', path, httpStatus: response.status };
    if (!response.ok) return { request, fallbackReason: 'service_request_failed' };
    const body = await response.json();
    if (typeof body.status === 'number') request.businessStatus = body.status;
    if (body.status !== 1 || body.data?.serviceCode !== nodeCode || body.data?.serviceName !== nodeName) {
      return { request, fallbackReason: 'service_identity_unconfirmed' };
    }
    window.jDiwork.openService(nodeCode);
    return { request };
  } catch {
    return { fallbackReason: 'service_request_failed' };
  }
}

export async function observeOpenNode(_task, page, { nodeName, nodeCode }) {
  const rendered = await page.evaluate(({ nodeName, nodeCode }) => {
    const active = [...document.querySelectorAll('[class*="navLi--"].active > p[title]')]
      .find(tab => tab.title === nodeName && tab.getClientRects().length);
    if (!active) return false;
    if (!nodeCode) return true;
    const content = document.getElementById(nodeCode);
    if (nodeCode === 'GZTTMP011' || nodeCode === 'GZTTMP012') return !!content?.getClientRects().length;
    if (content?.getClientRects().length) return true;
    // The workbench's active tab model carries the service code separately from its label.
    const element = active.parentElement;
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    for (let fiber = element[key]; fiber; fiber = fiber.return) {
      const code = fiber.memoizedProps?.['data-id'];
      if (typeof code === 'string') return code === nodeCode;
    }
    return false;
  }, { nodeName, nodeCode });
  return { nodeName, ...(nodeCode ? { nodeCode } : {}), rendered };
}

export async function openNode(task, page, input) {
  const { nodeName } = input;
  await ready(page);
  const codes = await page.evaluate(nodeCodes, input);
  if (codes.length > 1) return { status: 'ambiguous_node', nodeName, candidates: codes, rendered: false };
  const nodeCode = codes[0] ?? input.nodeCode ?? (nodeName === templateNode.nodeName ? templateNode.nodeCode : undefined);
  const target = { nodeName, ...(nodeCode ? { nodeCode } : {}) };
  const observe = async () => {
    const result = await observeOpenNode(task, page, target);
    return result.rendered ? result : null;
  };
  const native = nodeCode ? await page.evaluate(openNativeNode, { path: nodePath, ...target })
    : { fallbackReason: 'node_missing_from_catalog' };
  if (!native.fallbackReason) {
    const observed = await waitFor(observe, 12000);
    if (observed) return { ...observed, status: 'opened', transport: 'api', request: native.request };
    native.fallbackReason = 'native_navigation_unconfirmed';
  }

  let found;
  if (input.nodeCode) {
    found = await page.evaluate(({ nodeCode, nodeName }) => {
      const entry = document.getElementById('degree4th-' + nodeCode);
      if (entry?.title !== nodeName || entry.getAttribute('fieldid') !== 'nav-node') return 0;
      entry.click();
      return 1;
    }, target);
  } else {
    // The global search supplies the entry for nodes absent from the catalog.
    await page.fill(workbenchSearch, nodeName);
    found = await waitFor(() => page.evaluate(name => {
      const entries = [...document.querySelectorAll('.service-search-com-workbench p.name')]
        .filter(entry => entry.textContent.trim() === name && entry.getClientRects().length);
      if (entries.length === 1) entries[0].click();
      return entries.length;
    }, nodeName), 10000);
  }
  if (found !== 1) return { status: found ? 'ambiguous_node' : 'node_not_found', ...target, rendered: false, ...native };
  const observed = await waitFor(observe, 25000);
  return { ...target, status: observed ? 'opened' : 'node_unconfirmed', rendered: !!observed, transport: 'ui', ...native };
}

const defaultDocument = '通用报销单';

async function until(read, description) {
  const result = await waitFor(read, 45000);
  if (result === null) throw new Error('Timed out waiting for ' + description);
  return result;
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

export async function openTemplateList(task, page, input, nodeReady = false) {
  if (!nodeReady) {
    const opened = await openNode(task, page, { nodeName: 'UI模板' });
    if (opened.status !== 'opened') return opened;
  }
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

const listUrl = '/template/manage/listTenantTemplates';
const listPath = '/iuap-metadata-ui' + listUrl;

async function queryNativeTemplates(input) {
  const { serviceCode, listUrl, listPath, documentName, documentPath, pageType, templateId, templateName,
    transactionType, limit } = input;
  const rest = window.cb?.rest;
  if (typeof rest?.ajax !== 'function') return { fallbackReason: 'native_query_unavailable' };

  // This is the same browser-side request builder that adds the workbench's session context.
  const post = (path, params) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 8000);
    try {
      rest.ajax(path + '?serviceCode=' + serviceCode, { method: 'POST', domainKey: 'ucf-mdf', diworkCode: serviceCode, params,
        callback(error, data) {
          clearTimeout(timer);
          resolve(error ? null : data);
        } });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
  const orgId = '666666';
  const terminalType = '1';
  const tree = await post('/tpl/mgmt/getLeftTree', { orgId });
  if (!Array.isArray(tree)) return { fallbackReason: 'document_tree_request_failed' };
  const matches = [];
  const visit = (nodes, parents) => {
    for (const node of nodes) {
      const path = [...parents, node.name];
      if (node.children?.length) visit(node.children, path);
      else if (node.name === documentName && (!documentPath ||
        documentPath.length === path.length && documentPath.every((name, index) => name === path[index]))) {
        matches.push({ node, documentPath: path });
      }
    }
  };
  visit(tree, []);
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous_document' : 'document_not_found', documentName,
    candidates: matches.map(match => ({ documentName, documentPath: match.documentPath })) };
  const [{ node, documentPath: actualPath }] = matches;
  const { appCode, serviceCode: wbServiceCode } = node;
  if (!appCode || !wbServiceCode) return { fallbackReason: 'document_context_unavailable' };
  const group = await post('/tpl/mgmt/getTplGroupType', { appCode, wbServiceCode });
  const terminal = group?.terminalTypes?.find(item => item.terminalType === terminalType);
  if (!Array.isArray(terminal?.bills)) return { fallbackReason: 'page_type_request_failed' };
  const pages = terminal.bills.filter(bill => bill.billType === 'Voucher' && bill.billName &&
    !/[(（]移动端[)）]$/.test(bill.billName));
  const requested = pageType ?? documentName;
  const types = pages.filter(bill => bill.billName === requested);
  const bill = types.length === 1 ? types[0] : !pageType && pages.length === 1 ? pages[0] : null;
  if (!bill || !bill.billNo || !bill.ownDomain || !bill.domainKey || !bill.billUiType || !bill.regType ||
      bill.appCode !== appCode || bill.wbServiceCode !== wbServiceCode) {
    return { fallbackReason: 'page_type_context_unavailable' };
  }

  const start = performance.now();
  const data = await post(listUrl, { ownDomain: bill.ownDomain, domain: bill.domainKey, appCode,
    serviceCode: wbServiceCode, wbServiceCode, orgId, terminalType, billNo: bill.billNo,
    billUiType: bill.billUiType, regType: bill.regType });
  if (!Array.isArray(data)) return { fallbackReason: 'template_list_request_failed' };
  const request = { method: 'POST', path: listPath, businessStatus: 200 };
  const timing = performance.getEntriesByType('resource').findLast(entry =>
    entry.startTime >= start && new URL(entry.name, location.href).pathname === listPath);
  if (timing?.responseStatus) request.httpStatus = timing.responseStatus;

  const rows = [];
  for (const item of data) {
    const row = { templateId: item.tplId, templateName: item.tplName, transactionType: item.transTypeName ?? '' };
    if (!/^\d+$/.test(row.templateId) || (templateId && row.templateId !== templateId) ||
        (templateName && row.templateName !== templateName) || (transactionType && row.transactionType !== transactionType)) continue;
    rows.push(row);
  }
  return { status: 'queried', documentName, documentPath: actualPath, pageType: bill.billName, billNo: bill.billNo,
    rows: rows.slice(0, limit), matchCount: rows.length, scannedRows: data.length, truncated: rows.length > limit, request };
}

function readTemplateTable({ templateId, templateName, transactionType, limit }) {
  const list = document.querySelector('#GZTTMP011');
  const renderedRows = new Map();
  for (const row of list.querySelectorAll('[role=row]')) {
    const cell = key => row.querySelector('.columnkey-' + key)?.textContent.trim();
    const id = cell('tplId');
    if (!/^\d+$/.test(id)) continue;
    renderedRows.set(id, { templateId: id, templateName: cell('tplName'), transactionType: cell('transTypeName') ?? '' });
  }
  const rows = [...renderedRows.values()].filter(row => (!templateId || row.templateId === templateId) &&
    (!templateName || row.templateName === templateName) && (!transactionType || row.transactionType === transactionType));
  const rowCount = list.querySelector('[role=grid]')?.getAttribute('aria-rowcount');
  const complete = rowCount != null && Number(rowCount) === renderedRows.size + 1 ||
    !renderedRows.size && !!list.querySelector('.noDataHelper .wui-empty');
  return { rows: rows.slice(0, limit), matchCount: complete ? rows.length : null, scannedRows: renderedRows.size,
    truncated: !complete || rows.length > limit };
}

export async function queryTemplates(task, page, input) {
  const documentName = input.documentName ?? input.documentPath?.at(-1) ?? defaultDocument;
  const args = { ...input, documentName, limit: input.limit ?? 10 };
  const opened = await openNode(task, page, { nodeName: templateNode.nodeName });
  if (opened.status !== 'opened') return opened;
  const native = await page.evaluate(queryNativeTemplates, { ...args, serviceCode: templateNode.nodeCode, listUrl, listPath });
  if (!native.fallbackReason) return { ...native, transport: 'api' };
  const document = await openTemplateList(task, page, args, true);
  const path = { transport: 'ui', fallbackReason: native.fallbackReason };
  if (document.status) return { ...document, ...path };
  const result = await page.evaluate(readTemplateTable, args);
  return { ...document, ...result, ...path, status: 'queried' };
}
