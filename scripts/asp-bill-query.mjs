const { workbench, openNode } = await import('./asp-workbench.mjs' + new URL(import.meta.url).search);

const node = { nodeName: '通用申请单', nodeCode: 'znbzbx_memoapplylist' };
const tenantTitle = 'All SEASONS PROPERTY CO., LTD';
const listPath = '/yonbip-fi-expsrbsm/bill/list';
const root = '#' + node.nodeCode;
const codeInput = root + ' #znbzbxInputcode';
const searchButton = root + ' button[fieldid="znbzbx_memoapplylist|search"]';
const clearDate = root + ' [fieldid="znbzbx_memoapplylist|showSearchCommon|vouchdate_close"]';

async function waitFor(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

// All application data and session headers stay in the browser.
async function billListBrowser({ action, path, nodeCode, billCode }) {
  const captureKey = Symbol.for('asp-general-application-capture');
  const contextKey = Symbol.for('asp-general-application-query-context');
  const capture = window[captureKey];

  function responseSummary(json, countRequest) {
    if (json?.code !== 200) return { businessCode: json?.code };
    if (countRequest) return { businessCode: 200, candidateCount: json.data?.recordCount };
    const records = json.data?.recordList;
    if (!Array.isArray(records)) return { businessCode: 200 };
    return { businessCode: 200, returnedCount: records.length,
      matchedCount: records.filter(record => record.code === billCode).length };
  }

  if (action === 'stop') {
    capture?.stop();
    return;
  }
  if (action === 'result') {
    return capture?.list?.returnedCount !== undefined && capture?.count?.candidateCount !== undefined
      ? { ...capture.list, candidateCount: capture.count.candidateCount,
          evidence: [capture.list.evidence, capture.count.evidence] } : null;
  }

  function requestEvidence(url, body, httpStatus, summary) {
    const responseKeys = [];
    if (summary.businessCode !== undefined) responseKeys.push('code');
    if (summary.candidateCount !== undefined) responseKeys.push('data.recordCount');
    if (summary.returnedCount !== undefined) responseKeys.push('data.recordList');
    return { source: 'asp-list-page', method: 'POST', path, httpStatus, businessCode: summary.businessCode,
      queryKeys: [...url.searchParams.keys()], bodyKeys: Object.keys(body),
      conditionKeys: Object.keys(body.condition), conditionItems: body.condition.commonVOs.map(item => item.itemName),
      responseKeys };
  }

  if (action === 'api') {
    const context = window[contextKey];
    if (!context) return { fallbackReason: 'list_context_unavailable' };
    const url = new URL(context.url, location.origin);
    const xsrf = document.cookie.split('; ').find(cookie => cookie.startsWith('XSRF-TOKEN='))?.slice('XSRF-TOKEN='.length);
    if (!xsrf) return { fallbackReason: 'list_session_unavailable' };
    const headers = { 'Content-Type': 'application/json;charset=utf-8',
      'Domain-Key': context.body.ownDomain, 'X-XSRF-TOKEN': decodeURIComponent(xsrf) };
    const commonVOs = [...context.body.condition.commonVOs, { value1: billCode, itemName: 'code' }];
    const base = { ...context.body, bClick: true, page: { ...context.body.page, totalCount: 1 },
      condition: { ...context.body.condition, commonVOs } };
    const reads = [base, { ...base, page: { ...base.page, totalCount: -1 }, isOnlyCount: true }];
    const results = await Promise.all(reads.map(async body => {
      try {
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000) });
        const json = await response.json().catch(() => null);
        const summary = response.ok ? responseSummary(json, body.isOnlyCount) : {};
        return { ...summary, evidence: requestEvidence(url, body, response.status, summary) };
      } catch {
        return {};
      }
    }));
    const [list, count] = results;
    const evidence = results.map(result => result.evidence).filter(Boolean);
    return list.returnedCount !== undefined && count.candidateCount !== undefined
      ? { returnedCount: list.returnedCount, matchedCount: list.matchedCount, candidateCount: count.candidateCount, evidence }
      : { fallbackReason: 'list_request_failed', evidence };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const listRequest = Symbol();
  const state = { stop() {
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    delete window[captureKey];
  } };
  window[captureKey] = state;
  XMLHttpRequest.prototype.open = function (method, url, ...options) {
    if (method === 'POST') {
      const address = URL.parse(url, location.href);
      if (address?.origin === location.origin && address.pathname === path) this[listRequest] = address;
    }
    return originalOpen.call(this, method, url, ...options);
  };
  XMLHttpRequest.prototype.send = function (payload) {
    const url = this[listRequest];
    if (url && typeof payload === 'string') {
      let body;
      try { body = JSON.parse(payload); }
      catch { return originalSend.call(this, payload); }
      if (!body) return originalSend.call(this, payload);
      const conditions = body.condition?.commonVOs;
      if (body.billnum === nodeCode && Array.isArray(conditions)) {
        const scheme = conditions.filter(item => ['schemeName', 'isDefault'].includes(item.itemName));
        const hasDate = conditions.some(item => item.itemName === 'vouchdate');
        const supported = conditions.every(item => ['schemeName', 'isDefault', 'vouchdate', 'code'].includes(item.itemName));
        if (supported && !body.isOnlyCount && body.page && body.ownDomain) {
          const { isOnlyCount, ...listBody } = body;
          const { bInit, ...condition } = body.condition;
          window[contextKey] = { url: url.href, body: { ...listBody,
            page: { ...body.page, pageIndex: 1 }, condition: { ...condition, commonVOs: scheme } } };
        }
        if (supported && !hasDate && conditions.some(item => item.itemName === 'code' && item.value1 === billCode)) {
          this.addEventListener('load', () => {
            let json;
            try { json = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); }
            catch { /* The observed response was not JSON. */ }
            const summary = this.status === 200 ? responseSummary(json, body.isOnlyCount) : {};
            const role = body.isOnlyCount ? 'count' : 'list';
            state[role] = { ...summary, evidence: requestEvidence(url, body, this.status, summary) };
          }, { once: true });
        }
      }
    }
    return originalSend.call(this, payload);
  };
}

export function summarizeMatches({ candidateCount, returnedCount, matchedCount }) {
  const complete = Number.isInteger(candidateCount) && candidateCount === returnedCount;
  return { status: !complete ? 'incomplete' : matchedCount > 0 ? 'matched' : 'no_match',
    candidateCount, matchedCount, complete };
}

export async function queryGeneralApplications(task, page, { billCode }) {
  billCode = billCode.trim();
  if (!billCode) return { ...node, status: 'bill_code_required', complete: false };
  const check = action => page.evaluate(billListBrowser, { action, path: listPath, nodeCode: node.nodeCode, billCode });
  const controlVisible = selector => page.evaluate(s => !!document.querySelector(s)?.getClientRects().length, selector);
  if (await page.url() !== workbench) await page.goto(workbench);
  if (await controlVisible(codeInput) && !await page.evaluate(title => document.title === title, tenantTitle)) {
    return { ...node, status: 'query_unavailable', complete: false, fallbackReason: 'workbench_tenant_unconfirmed' };
  }
  await check('start');
  try {
    if (!await controlVisible(codeInput)) {
      const opened = await openNode(task, page, node);
      if (opened.status !== 'opened') return opened;
      if (!await waitFor(() => controlVisible(codeInput), 20000)) {
        return { ...node, status: 'query_unavailable', complete: false, fallbackReason: 'list_controls_unavailable' };
      }
    }

    const api = await check('api');
    if (!api.fallbackReason) {
      return { ...node, transport: 'api', ...summarizeMatches(api), requestEvidence: api.evidence };
    }

    await page.fill(codeInput, billCode);
    if (await controlVisible(clearDate)) await page.click(clearDate);
    await page.click(searchButton);
    const ui = await waitFor(() => check('result'), 15000);
    const transport = { ...node, transport: 'ui', fallbackReason: api.fallbackReason };
    if (!ui) return { ...transport, status: 'query_unavailable', complete: false, requestEvidence: api.evidence ?? [] };
    return { ...transport, ...summarizeMatches(ui), requestEvidence: [...(api.evidence ?? []), ...ui.evidence] };
  } finally {
    try { await check('stop'); }
    catch { /* A closed or navigating page can no longer restore its temporary observer. */ }
  }
}
