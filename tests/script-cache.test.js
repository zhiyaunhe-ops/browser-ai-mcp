'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { ScriptCache } = require('../src/script-cache');
const { BrowserService } = require('../src/service');

async function fixture(t) {
  const proceduresDir = await mkdtemp(join(tmpdir(), 'script-cache-test-'));
  t.after(() => rm(proceduresDir, { recursive: true, force: true }));
  const dir = join(proceduresDir, 'catalog-menu-prompt');
  await mkdir(join(dir, 'scripts'), { recursive: true });
  const metadata = {
    id: 'catalog-menu-prompt',
    name: 'Catalog menu probe',
    description: 'Inspect a sample catalog menu',
    version: '1.0.0',
    productVersion: 'premium',
    goalTerms: ['catalog', 'menu'],
    node: 'fixture-node',
    nodes: ['fixture-node', 'fixture-node_list'],
    flow: 'catalog-menu',
    entry: 'scripts/probe.mjs'
  };
  async function writeMetadata() {
    await writeFile(join(dir, 'SKILL.md'), `---\n${JSON.stringify(metadata)}\n---\n\n# Catalog menu\n`, 'utf8');
  }
  await writeMetadata();
  await writeFile(join(dir, metadata.entry), `export async function probe({ page }) {
    return page.evaluate(() => ({ state: 'unknown' }));
  }\n`, 'utf8');
  async function writeMemo(text) { await writeFile(join(dir, 'MEMO.md'), text, 'utf8'); }
  return { proceduresDir, metadata, writeMetadata, writeMemo, cache: new ScriptCache({ proceduresDir }) };
}

function makeStore() {
  const data = new Map();
  const records = [];
  return {
    directory: join(tmpdir(), 'script-cache-service-fixture'),
    records,
    get(kind, id) { return data.get(`${kind}:${id}`); },
    put(kind, id, value) { data.set(`${kind}:${id}`, value); return value; },
    list(kind) {
      const prefix = `${kind}:`;
      return [...data.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    transaction(fn) { return fn(); },
    append(record) {
      const saved = { ...record, cursor: records.length + 1 };
      records.push(saved);
      return saved;
    },
    query() { return { records, hasMore: false }; },
    close() {}
  };
}

function makeService(cache) {
  const service = Object.create(BrowserService.prototype);
  let nextId = 0;
  let calls = 0;
  service.store = makeStore();
  service.memory = { pageRules: () => [], search: () => ({ domainRules: [], matches: [] }) };
  service.ego = {
    run: async () => {
      calls += 1;
      return { state: 'succeeded', executionStopped: true,
        result: { state: 'prompt', prompt: `提示 ${calls}` } };
    }
  };
  service.clock = () => 1;
  service.id = () => `test-${++nextId}`;
  service.waitMs = 100;
  service.ownerId = 'owner1';
  service.pending = new Map();
  service.closed = false;
  service.scriptCache = cache;
  service.scriptBriefings = new Map();
  return { service, calls: () => calls };
}

function beginRequest(overrides = {}) {
  return {
    requestId: 'begin-1', goal: 'check catalog menu',
    url: 'https://example.test/catalog', criteria: [],
    context: { node: 'fixture-node', productVersion: 'premium' }, ...overrides
  };
}

function runRequest(runId, requestId, overrides = {}) {
  return { runId, requestId, purpose: 'execute',
    context: { node: 'fixture-node', productVersion: 'premium' }, ...overrides };
}

function invocation(response) {
  const match = response.scriptCache.matches[0];
  assert.ok(match);
  assert.equal(match.invoke.tool, 'browser_run');
  assert.equal(match.invoke.script.id, match.id);
  assert.equal(match.invoke.script.version, match.version);
  assert.ok(match.invoke.script.briefingId);
  return match.invoke.script;
}

test('matches catalog menu and returns package metadata', async t => {
  const { cache, metadata } = await fixture(t);
  const matches = await cache.match({ goal: 'check catalog menu', url: 'https://example.test/',
    node: 'fixture-node', productVersion: 'premium' });
  assert.equal(matches.length, 1);
  for (const key of ['id', 'version', 'productVersion', 'node', 'nodes', 'flow', 'description', 'entry']) {
    assert.deepEqual(matches[0][key], metadata[key]);
  }
  assert.ok(matches[0].digest);
  const loaded = await cache.load(metadata.id);
  assert.equal(loaded.id, metadata.id);
  assert.equal(loaded.digest, matches[0].digest);
});

test('matched package briefing carries MEMO.md and its digest tracks memo revisions', async t => {
  const { cache, writeMemo } = await fixture(t);
  await writeMemo('Inspect the visible catalog prompt.');
  const args = { goal: 'check catalog menu', url: 'https://example.test/',
    node: 'fixture-node', productVersion: 'premium' };
  const first = (await cache.match(args))[0];
  assert.equal(first.memo, 'Inspect the visible catalog prompt.');

  await writeMemo('Inspect the updated catalog prompt.');
  const revised = (await cache.match(args))[0];
  assert.equal(revised.memo, 'Inspect the updated catalog prompt.');
  assert.notEqual(revised.digest, first.digest, 'a MEMO.md change must revise the package digest');
});

test('compiled probe executes and a different version is rejected', async t => {
  const { cache, metadata } = await fixture(t);
  const code = await cache.code(metadata.id, metadata.version);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('task', 'page', 'input', code);
  const result = await execute({}, { evaluate: async fn => fn() }, {});
  assert.deepEqual(result, { state: 'unknown' });
  await assert.rejects(async () => cache.code(metadata.id, '2.0.0'), error => error.code === 'SCRIPT_VERSION_MISMATCH');
});

test('begin provides script guidance and separate requests return fresh results', async t => {
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest());
  const script = invocation(begun);
  assert.equal(begun.guidance[0].kind, 'script');
  const first = await service.browserRun(runRequest(begun.runId, 'run-1', { script }));
  const second = await service.browserRun(runRequest(begun.runId, 'run-2', { script }));
  assert.equal(calls(), 2);
  assert.equal(first.result.prompt, '提示 1');
  assert.equal(second.result.prompt, '提示 2');
  assert.equal(first.usedScript.id, script.id);
  assert.equal(first.usedScript.version, script.version);
  assert.equal(first.usedScript.briefingId, script.briefingId);
  assert.ok(first.usedScript.digest);
  assert.equal(second.usedScript.id, script.id);
  const repeated = await service.browserRun(runRequest(begun.runId, 'run-2', { script }));
  assert.equal(calls(), 2);
  assert.equal(repeated.result.prompt, '提示 2');
});

test('missing briefing blocks execution, including memo false', async t => {
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest());
  const result = await service.browserRun(runRequest(begun.runId, 'run-1', { code: 'return { ok: true };', memo: false }));
  assert.equal(result.state, 'script_briefing_required');
  assert.equal(result.executionStarted, false);
  assert.ok(result.scriptCache.matches.length);
  assert.equal(calls(), 0);
});

test('node changes require a new briefing before execution', async t => {
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest());
  const script = invocation(begun);
  const result = await service.browserRun(runRequest(begun.runId, 'run-1', {
    script, context: { node: 'fixture-node_list', productVersion: 'premium' }
  }));
  assert.equal(result.state, 'script_briefing_required');
  assert.equal(result.executionStarted, false);
  assert.equal(calls(), 0);
  assert.notEqual(invocation(result).briefingId, script.briefingId);
});

test('a changed script version requires a new briefing', async t => {
  const { cache, metadata, writeMetadata, proceduresDir } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest());
  const oldScript = invocation(begun);
  metadata.version = '2.0.0';
  await writeMetadata();
  service.scriptCache = new ScriptCache({ proceduresDir });
  const result = await service.browserRun(runRequest(begun.runId, 'run-1', { script: oldScript }));
  assert.equal(result.state, 'script_briefing_required');
  assert.equal(result.executionStarted, false);
  assert.equal(calls(), 0);
  assert.equal(invocation(result).version, '2.0.0');
});

test('service recovery invalidates the previous briefing', async t => {
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest());
  const oldScript = invocation(begun);
  service.scriptBriefings.clear();
  service.ownerId = 'owner2';
  const result = await service.browserRun(runRequest(begun.runId, 'run-1', { script: oldScript }));
  assert.equal(result.state, 'script_briefing_required');
  assert.equal(result.executionStarted, false);
  assert.equal(calls(), 0);
  assert.notEqual(invocation(result).briefingId, oldScript.briefingId);
});

test('resume rematches before execution and accepts the new briefing', async t => {
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest());
  const oldScript = invocation(begun);
  const required = await service.browserRun(runRequest(begun.runId, 'run-1', { script: oldScript, resumeAfterUserAction: true }));
  assert.equal(required.state, 'script_briefing_required');
  assert.equal(required.executionStarted, false);
  assert.equal(calls(), 0);
  const newScript = invocation(required);
  assert.notEqual(newScript.briefingId, oldScript.briefingId);
  const result = await service.browserRun(runRequest(begun.runId, 'run-2', { script: newScript }));
  assert.equal(calls(), 1);
  assert.equal(result.result.prompt, '提示 1');
});

test('ordinary code remains available when no script matches', async t => {
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const begun = await service.begin(beginRequest({ goal: '检查客户列表', context: { node: 'customer-list', productVersion: 'premium' } }));
  assert.deepEqual(begun.scriptCache.matches, []);
  const result = await service.browserRun(runRequest(begun.runId, 'run-1', {
    code: 'return { ok: true };', context: { node: 'customer-list', productVersion: 'premium' }
  }));
  assert.notEqual(result.state, 'script_briefing_required');
  assert.equal(calls(), 1);
});

test('records script cache match, injection, use and result evidence', async t => {
  const { cache } = await fixture(t);
  const { service } = makeService(cache);
  const begun = await service.begin(beginRequest());
  await service.browserRun(runRequest(begun.runId, 'run-1', { script: invocation(begun) }));
  const phases = service.store.records.map(record => record.payload)
    .filter(payload => payload?.type === 'script-cache').map(payload => payload.phase);
  for (const phase of ['match', 'inject', 'use', 'result']) assert.ok(phases.includes(phase), `missing script-cache phase: ${phase}`);
});

async function loadProbe() {
  return (await import(pathToFileURL(resolve(__dirname,
    '../procedures/nccloud-supplier-group-import-prompt/scripts/probe.mjs')).href)).probe;
}
test('MCP exposes briefing and executes cached scripts without code', async t => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = require('zod');
  const { createMcpServer } = require('../src/mcp');
  const { cache } = await fixture(t);
  const { service, calls } = makeService(cache);
  const registered = new Map();
  const originalRegisterTool = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function (name, config, handler) {
    registered.set(name, { config, handler });
    return {};
  };
  try { createMcpServer(service); }
  finally { McpServer.prototype.registerTool = originalRegisterTool; }
  const beginTool = registered.get('run_begin');
  const browserTool = registered.get('browser_run');
  assert.ok(beginTool);
  assert.ok(browserTool);
  assert.match(browserTool.config.description, /缓存|脚本/);
  assert.match(browserTool.config.description, /说明|简报/);
  async function invoke(tool, args) {
    const parsed = z.object(tool.config.inputSchema).parse(args);
    const response = await tool.handler(parsed);
    const text = response.content.find(item => item.type === 'text').text;
    return JSON.parse(text).data;
  }
  const begun = await invoke(beginTool, beginRequest());
  assert.equal(Object.keys(begun)[0], 'scriptCache');
  assert.equal(begun.guidance[0].kind, 'script');
  const initialScript = invocation(begun);
  const required = await invoke(browserTool, runRequest(begun.runId, 'mcp-missing', {
    script: { id: initialScript.id, version: initialScript.version }
  }));
  assert.equal(required.state, 'script_briefing_required');
  assert.equal(required.executionStarted, false);
  assert.equal(calls(), 0);
  const script = invocation(required);
  const first = await invoke(browserTool, runRequest(begun.runId, 'mcp-1', { script }));
  const second = await invoke(browserTool, runRequest(begun.runId, 'mcp-2', { script }));
  assert.equal(first.result.prompt, '提示 1');
  assert.equal(second.result.prompt, '提示 2');
  assert.equal(first.usedScript.version, script.version);
  assert.equal(second.usedScript.version, script.version);
  assert.equal(calls(), 2);
  const noMatch = await invoke(beginTool, beginRequest({ requestId: 'mcp-begin-no-match',
    goal: '检查客户列表', context: { node: 'customer-list', productVersion: 'premium' } }));
  const ordinary = await invoke(browserTool, runRequest(noMatch.runId, 'mcp-code', {
    code: 'return { ok: true };', context: { node: 'customer-list', productVersion: 'premium' }
  }));
  assert.notEqual(ordinary.state, 'script_briefing_required');
  assert.equal(calls(), 3);
});
