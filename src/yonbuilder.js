'use strict';

const { readSchema } = require('./schema');

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { z } = require('zod');

const execute = promisify(execFile);
const word = z.string().min(1);
const optional = word.optional();
const environment = { sessionId: optional, baseUrl: z.string().url().optional() };
const space = z.number().int().nonnegative();
const endpoint = value => value.replace(/\/+$/, '');

async function cli(entry, argv) {
  const root = process.env.BROWSER_AI_YONBUILDER_ROOT;
  const cwd = process.env.BROWSER_AI_YONBUILDER_WORKSPACE;
  if (!root || !cwd) throw new Error('Set BROWSER_AI_YONBUILDER_ROOT and BROWSER_AI_YONBUILDER_WORKSPACE.');
  const program = path.resolve(root, 'skills', 'iuap-apcom-cli', 'scripts', entry + '.js');
  let result;
  try {
    result = await execute(process.execPath, [program, ...argv], { cwd, timeout: 90000, maxBuffer: 8 << 20, windowsHide: true });
  } catch (error) {
    throw new Error('YonBuilder command failed: ' + (error.code ?? 'unknown'));
  }
  try { return JSON.parse(result.stdout); } catch { return result.stdout.trim(); }
}

function fail(code, message, candidates) {
  throw Object.assign(new Error(message), { code, candidates });
}

function registerYonbuilder(register, service, invoke = cli) {
  async function session(a) {
    const { sessions = [], defaultSessionId } = await invoke('bip-cli', ['system', 'session', 'list', '--format', 'json']);
    const matches = sessions.filter(s => (!a.sessionId || s.sessionId === a.sessionId) &&
      (!a.baseUrl || endpoint(s.baseUrl) === endpoint(a.baseUrl)));
    if (!matches.length) fail('SESSION_NOT_FOUND', 'No session matches the selected environment.');
    if (matches.length === 1) return matches[0];
    if (!a.baseUrl && !a.sessionId) {
      const preferred = matches.find(s => s.sessionId === defaultSessionId || s.isDefault);
      if (preferred) return preferred;
    }
    fail('SESSION_AMBIGUOUS', 'Choose a sessionId.', matches.map(({ sessionId }) => ({ sessionId })));
  }

  async function query(selected, group, action, flags) {
    const argv = ['yonbuilder', group, action];
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined || value === false) continue;
      argv.push('--' + key);
      if (value !== true) argv.push(String(value));
    }
    return invoke('bip-cli', [...argv, '--format', 'json', '--session-id', selected.sessionId]);
  }

  function compactApp(item) {
    return { id: item.id, appCode: item.appCode, appName: item.appName || item.name || '',
      domainCode: item.domainCode || '', appDomain: item.appDomain || item.serviceDomainCode || '',
      appType: item.appType || '', appStatus: item.appStatus };
  }

  async function listApps(selected, flags) {
    const result = await query(selected, 'app', 'list', flags);
    const data = result.data ?? result;
    const apps = (data.apps ?? []).map(compactApp);
    return { apps, count: apps.length, pagination: data.pagination ?? (data.totalElements === undefined ? undefined : {
      page: data.pageIndex, size: data.pageSize, total: data.totalElements, totalPages: data.totalPages
    }) };
  }

  async function app(a, selected) {
    if (!a.appId && !a.appCode) fail('INVALID_ARGUMENT', 'Supply appId or appCode.');
    let item;
    try {
      const result = await query(selected, 'app', 'get', a.appId ? { id: a.appId } : { appcode: a.appCode });
      item = result.app?.data?.info ?? result.data?.info ?? result.app ?? result.data ?? result;
    } catch (error) {
      if (a.appId) throw error;
    }
    if (!a.appId && item?.appCode !== a.appCode) {
      item = (await listApps(selected, { full: true })).apps.find(candidate => candidate.appCode === a.appCode);
    }
    if (!item?.id) fail('APP_NOT_FOUND', 'Application lookup returned no identity.');
    return compactApp(item);
  }

  async function pages(a, selected) {
    if (!a.appCode || !a.bizobjCode) fail('INVALID_ARGUMENT', 'Supply appCode and bizobjCode.');
    const r = await query(selected, 'page', 'list', { appcode: a.appCode, busiobjcode: a.bizobjCode,
      full: a.full ?? true, flat: a.flat ?? true });
    const rows = (r.data?.pages ?? r.pages ?? []).flatMap(g =>
      Array.isArray(g.voucherPages) ? g.voucherPages.map(p => ({ groupName: g.groupName, ...p })) : [g]);
    const link = value => value ? new URL(value, endpoint(selected.baseUrl) + '/').href : '';
    return rows.map(p => ({ name: p.name, groupName: p.groupName, tplType: p.tplType || p.type || '', pageCode: p.pageCode || p.designerCode || p.id,
      designerCode: p.designerCode || p.pageCode || p.id, previewUrl: link(p.previewUrl), designerUrl: link(p.designerUrl || p.url) }));
  }

  async function inspect(a, url) {
    const directory = await mkdtemp(path.join(tmpdir(), 'yonbuilder-page-'));
    const id = randomUUID();
    try {
      const r = await service.ego.run({ runId: id, executionId: id, name: 'YonBuilder navigation ' + id,
        directory, spaceId: a.spaceId, pageLabel: a.pageLabel || 'p1', args: { url, close: a.keep === false },
        timeoutMs: 90000, code: `
if (input.url) await page.goto(input.url);
const info = { spaceId: task.spaceId, url: await page.url(), title: await page.title(), page: page.label,
  tabs: (await task.tabs()).map(({label, title, url, active}) => ({label, title, url, active})) };
if (input.close) await task.finish({keep: []});
return info;` });
      if (r.state !== 'succeeded') fail(r.error?.code || 'EGO_FAILED', r.error?.message || r.state);
      return url ? { success: true, ...r.result, executionId: id } : r.result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  register('yonbuilder_cli', 'Run a locally installed YonBuilder CLI with literal arguments. Discover commands with --help or --schema. Some CLI commands write live data. Use entry schema for on-demand SQL Server table, column, key and index metadata.',
    { entry: z.enum(['bip-cli', 'erm', 'schema']), argv: z.array(z.string()).min(1),
      targetTenantId: z.string().trim().min(1).optional().describe('Verify the bip-cli session tenant before executing the command.') },
    async ({ entry, argv, targetTenantId }) => {
      if (targetTenantId !== undefined) {
        if (entry !== 'bip-cli') fail('TENANT_CHECK_UNSUPPORTED', 'Tenant verification requires bip-cli.');
        const sessionArgs = [];
        for (const [index, arg] of argv.entries()) {
          if (arg !== '--session-id' && !arg.startsWith('--session-id=')) continue;
          const id = arg === '--session-id' ? argv[index + 1] : arg.slice('--session-id='.length);
          if (sessionArgs.length || !id || id.startsWith('-')) fail('INVALID_ARGUMENT', 'Supply one valid session ID.');
          sessionArgs.push('--session-id', id);
        }
        const identity = await invoke(entry, ['whoami', '--format', 'json', ...sessionArgs]);
        if (!identity?.tenantid) fail('TENANT_UNKNOWN', 'Unable to verify the current tenant.');
        if (identity.tenantid !== targetTenantId) {
          fail('TENANT_MISMATCH', `Expected tenant ${targetTenantId}, current tenant is ${identity.tenantid}.`);
        }
      }
      return entry === 'schema' ? readSchema(argv) : invoke(entry, argv);
    });
  const target = { ...environment, microservice: word, bill: word, template: word, field: word };
  const fields = a => ({ 'microservice-code': a.microservice, 'bill-no': a.bill, 'tpl-id': a.template, field: a.field });
  register('yonbuilder_field_get', 'Read all exact-name field matches on a template.', target, async a => {
    const r = await query(await session(a), 'ui', 'fields', fields(a));
    if (!Array.isArray(r.fields)) throw new Error('Missing field list in CLI response.');
    const exact = r.fields.filter(f => f.fieldName === a.field);
    return { ...r, count: exact.length, fields: exact };
  });
  register('yonbuilder_field_preview', 'Preview one field property in one container using --dry-run.',
    { ...target, group: word, property: word, value: word }, async a => query(await session(a), 'ui', 'set-prop',
      { ...fields(a), 'group-id': a.group, prop: a.property, value: a.value, 'dry-run': true }));
  const identity = { appId: optional, appCode: optional };
  register('yonbuilder_app_list', 'List or search applications in a selected session.',
    { ...environment, keyword: optional, page: z.number().int().positive().optional(), size: z.number().int().positive().max(100).optional(),
      full: z.boolean().optional() }, async a => listApps(await session(a), { name: a.keyword, page: a.page, size: a.size, full: a.full }));
  register('yonbuilder_app_get', 'Look up one application by ID or code.', { ...environment, ...identity }, async a => app(a, await session(a)));
  register('yonbuilder_bizobj_list', 'List business objects for the application.',
    { ...environment, appCode: word, appId: optional, domainCode: optional }, async a => {
      const selected = await session(a);
      const domain = a.domainCode || (await app(a, selected)).appDomain;
      if (!domain) fail('DOMAIN_NOT_FOUND', 'Supply the application domainCode.');
      const result = await query(selected, 'bizobj', 'list', { appcode: a.appCode, domaincode: domain });
      const bizobjs = result.data?.bizobjs ?? result.bizobjs ?? [];
      return { appCode: a.appCode, domainCode: domain, bizobjs, count: bizobjs.length };
    });
  register('yonbuilder_page_list', 'List business-object pages and resolved preview/designer URLs.',
    { ...environment, appCode: word, bizobjCode: word, full: z.boolean().optional(), flat: z.boolean().optional() }, async a => {
      const s = await session(a);
      const rows = await pages(a, s);
      return { sessionId: s.sessionId, baseUrl: s.baseUrl, count: rows.length, pages: rows };
    });
  register('yonbuilder_open', 'Open an application, service, unique page or URL in ego lite. Pass the returned spaceId to current_page.',
    { ...environment, ...identity, kind: z.enum(['app', 'service', 'preview', 'designer', 'url']), url: z.string().url().optional(),
      bizobjCode: optional, pageName: optional, pageCode: optional, designerCode: optional, serviceCode: optional, site: optional,
      spaceId: space.optional(), keep: z.boolean().optional() }, async a => {
      let url = a.url;
      if (a.kind !== 'url') {
        const s = await session(a);
        if (a.kind === 'service') url = new URL('/#/service/' + encodeURIComponent(a.serviceCode || 'ybbase'), s.baseUrl).href;
        else if (a.kind === 'app') {
          const item = await app(a, s);
          const params = new URLSearchParams({ locale: 'zh_CN', appCode: item.appCode });
          if (a.site) params.set('site', a.site);
          url = new URL('/iuap-yonbuilder-designer/ucf-wh/builder/appstore/index.html#/appstore/detail/' +
            encodeURIComponent(item.id) + '?' + params, s.baseUrl).href;
        } else {
          if (!(a.pageName || a.pageCode || a.designerCode)) fail('INVALID_ARGUMENT', 'Supply a page name or code.');
          const matches = (await pages(a, s)).filter(p => (!a.pageName || p.name === a.pageName) &&
            (!a.pageCode || p.pageCode === a.pageCode) && (!a.designerCode || p.designerCode === a.designerCode));
          if (!matches.length) fail('PAGE_NOT_FOUND', 'No matching page.');
          if (matches.length > 1) fail('PAGE_AMBIGUOUS', 'Retry with a unique code.', matches);
          url = a.kind === 'preview' ? matches[0].previewUrl : matches[0].designerUrl;
          if (a.kind === 'designer' && url && !/[?&]feDomainKey=/.test(url)) {
            const domain = (await app(a, s)).appDomain;
            if (domain) url += (url.includes('?') ? '&' : '?') + 'feDomainKey=' + encodeURIComponent(domain);
          }
        }
      }
      if (!url || !/^https?:\/\//i.test(url)) fail('INVALID_ARGUMENT', 'An HTTP(S) URL is required.');
      return { ...await inspect(a, url), requestedUrl: url, kind: a.kind };
    });
  register('yonbuilder_current_page', 'Read a page in an existing ego lite space.',
    { spaceId: space, pageLabel: optional }, a => inspect(a));
}

module.exports = { registerYonbuilder };
