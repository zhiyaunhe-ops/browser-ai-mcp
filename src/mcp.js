#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createService } = require('./service');
const { updateTemplateField } = require('./asp-template');
const packageInfo = require('../package.json');

const text = z.string().min(1);
const idempotent = { runId: text, requestId: text };
const pagination = { cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() };
const criterion = z.object({ id: text, path: z.string(), equals: z.unknown() });
const output = { data: z.unknown() };
const formula = z.union([text, z.object({ expression: text, display: z.string().optional() }).strict(), z.null()]);

function createMcpServer(service = createService()) {
  const server = new McpServer({ name: 'browser-ai', version: packageInfo.version }, {
    instructions: 'ASP UAT 的 PC 单据 UI 模板字段（表头或明细列）使用 asp_ui_template_update_field。按单据名、模板和字段定位，changes={} 读取可用属性。For other browser workflows recall a procedure with run_begin, use browser_run for official ego code, poll run_get, then independently observe business results before run_finish. Browser code receives task, page and input. Use ego-browser documented methods; run_finish owns Space cleanup. Never resend an unresolved write with a new requestId.'
  });
  const register = (name, description, inputSchema, method) => server.registerTool(name, {
    description, inputSchema, outputSchema: output
  }, async args => {
    try {
      const data = await method(args);
      const structuredContent = { data };
      return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
    } catch (error) {
      const data = { code: error.code || 'INTERNAL_ERROR', message: error.message,
        ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
        ...(error.executionStarted === undefined ? {} : { executionStarted: error.executionStarted }),
        ...(Array.isArray(error.issues) ? { issues: error.issues } : {}) };
      return { isError: true, structuredContent: { data }, content: [{ type: 'text', text: JSON.stringify({ data }) }] };
    }
  });
  register('asp_ui_template_update_field', '配置 ASP UAT 的 PC 单据 UI 模板表头字段或明细列。给出单据、模板名或 ID、字段名或编码；同名项返回候选。默认使用通用报销单表头。用 changes={} 查看实际属性及选项，用 changes.properties 传精确属性名或编码，公式用 changes.formula。设计器提交原生保存 POST，工具重新打开模板核对。重试沿用 requestId。', {
    requestId: text, templateId: text.optional(), templateName: text.optional(), transactionType: text.optional(),
    documentName: text.optional().describe('工作台 UI 模板树中的单据名称。默认通用报销单。'),
    documentPath: z.array(text).nonempty().optional().describe('从业务域到单据名称的完整目录路径，用于区分同名单据。'),
    pageType: text.optional().describe('工作台选定单据下的 PC 页面类型名称。省略时使用该单据的默认页面。'),
    designerUrl: z.string().url().optional(), field: text,
    fieldScope: z.enum(['header', 'detail']).optional().describe('header 表头，detail 明细列。默认表头。'),
    detailEntity: text.optional().describe('候选明细表的实体编码，提供后按明细定位。'),
    fieldId: text.optional().describe('候选中的持久字段 ID，优先用于区分同一实体内的同名字段。'),
    fieldNid: text.optional().describe('设计器节点 ID。缺少持久字段 ID 时，可用稳定的节点 ID 区分同名字段。'),
    changes: z.object({
      required: z.boolean().optional(), visible: z.boolean().optional(), editable: z.boolean().optional(),
      caption: text.optional(), formula: formula.optional().describe('计算公式表达式或带 display 的对象。null 清空公式。'),
      properties: z.record(z.unknown()).optional().describe('键为该字段的属性编码或面板上的精确名称，值按设计器元数据填写。下拉选项使用其 value。')
    }).strict()
  }, args => updateTemplateField(service, args));
  register('run_begin', 'Create a durable workflow task and recall applicable procedures. Does not navigate.', {
    requestId: text, goal: text, url: z.string().url(), criteria: z.array(criterion).max(30), recipeIds: z.array(text).optional()
  }, args => service.begin(args));
  register('browser_run', 'Execute ego code with task, page and input. Return JSON and poll run_get. Check pageMemos on the settled execution for reminders matching the observed route and dialog before the next action. On a missing Yonyou node, try observed row, hover, More and edit-mode entrances from ys.entries() and modeActions. Re-read after each attempt. Use ys.transferState/transferRight for two-pane pickers. Includes memo, scoped readers and observationTrace by default. DOM globals belong in page.evaluate(). Business completion requires a later independent observe round and run_finish.', {
    ...idempotent, purpose: z.enum(['execute', 'observe']), code: text,
    args: z.unknown().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    pageLabel: text.optional(), resumeAfterUserAction: z.boolean().optional(), memo: z.boolean().optional(),
    resolutions: z.array(z.object({ executionId: text, observationId: text, note: text })).optional()
  }, args => service.browserRun(args));
  register('run_get', 'Read durable run and execution state without replaying commands. Also reconciles completed result files.', {
    runId: text, executionId: text.optional(), ...pagination
  }, args => service.get(args));
  register('run_finish', 'Verify declared criteria against a later observation, atomically submit memory feedback, and finish the ego Space once. Save a reusable page reminder in updates[].entry with scope "page", key, name, actionable summary and match (path or pathPrefix, optional hashPrefix and exact dialogTitle). Use baseRevision 0 for a new entry.', {
    ...idempotent, outcome: z.enum(['succeeded', 'failed', 'unknown', 'cancelled']),
    verification: z.array(z.object({ criterionId: text, observationId: text })).default([]),
    decision: z.enum(['confirmed', 'corrected', 'learned', 'no-change']),
    usedMemoryIds: z.array(text).default([]), updates: z.array(z.record(z.unknown())).max(10).default([]),
    note: text, keepPages: z.array(text).optional(), retryCleanup: z.boolean().optional()
  }, args => service.finish(args));
  register('memory_search', 'Recall compact workflow experience for the observed URL and goal.', {
    url: z.string().url(), goal: z.string(), limit: z.number().int().min(1).max(10).optional()
  }, args => service.searchMemory(args));
  register('memory_get', 'Read the complete procedure, revision and provenance for one memory.', {
    memoryId: text
  }, args => service.getMemory(args));
  register('evidence_query', 'Read paginated execution/observation evidence or project explicit network/DOM records. Always reports capture gaps.', {
    runId: text, view: z.enum(['records', 'trace', 'api']).default('records'), ...pagination, executionId: text.optional()
  }, args => service.queryEvidence(args));
  register('recipe_draft', 'Build an unverified workflow recipe from task evidence and optional caller-authored procedure. No internal model call.', {
    ...idempotent, name: text, proposedRecipe: z.record(z.unknown()).optional()
  }, args => service.draftRecipe(args));
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) options.dataDir = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`Usage: node src/mcp.js [--data-dir ABSOLUTE_DIRECTORY]\nRequires Node ${packageInfo.engines.node}. Browser execution requires ego-browser. Transport: MCP stdio.\n`);
      return;
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const service = createService(options);
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  server.onclose = () => service.close();
  await server.connect(transport);
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { createMcpServer, main };
