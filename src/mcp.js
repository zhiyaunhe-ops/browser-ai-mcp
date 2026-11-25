#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createService } = require('./service');
const { registerEvaluationTools, reviewMemorySchema, sessionSource } = require('./evaluation');
const { updateTemplateField } = require('./asp-template');
const { verifyTemplateBatch } = require('./asp-template-batch');
const { workbenchScript, billQueryScript } = require('./asp-scripts');
const packageInfo = require('../package.json');

const text = z.string().min(1);
const domainTag = text.optional().describe('Product edition for reusable knowledge. Use the same exact domain_tag across environments.');
const idempotent = { runId: text, requestId: text };
const pagination = { cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() };
const criterion = z.object({ id: text, path: z.string(), equals: z.unknown() });
const formula = z.union([text, z.object({ expression: text, display: z.string().optional() }).strict(), z.null()]);
const workbenchRound = { ...idempotent, pageLabel: text.optional(), domain_tag: domainTag };
const batchTarget = z.object({
  templateId: text, templateName: text.optional(),
  designerUrl: z.string().url().describe('从目标模板工作台或保存步骤取得的 PC 设计器地址。'),
  field: text, fieldScope: z.enum(['header', 'detail']).optional(), detailEntity: text.optional(),
  fieldId: text.optional(), fieldNid: text.optional(),
  expected: z.record(z.unknown()).refine(value => Object.keys(value).length > 0,
    'Provide at least one expected property.').describe('按实际属性编码填写期望值，例如 {"bShowIt":false}。')
}).strict();

function readWorkbench(service, businessTool, method, { runId, requestId, pageLabel, domain_tag, ...input }, script = workbenchScript) {
  const code = 'const workflow = await import(' + JSON.stringify(script) + '); return await workflow.' + method + '(task, page, input);';
  return service.browserRun({ runId, requestId, pageLabel, domain_tag, businessTool, args: input, purpose: 'observe', timeoutMs: 120000, code });
}

function createMcpServer(service = createService()) {
  const server = new McpServer({ name: 'browser-ai', version: packageInfo.version }, {
    instructions: '执行模型负责操作、记录和独立回读，run_finish 自动交接。评估模型在本机用 eval_pending、eval_packet 和 eval_session_context 对照原始会话，然后 eval_submit；用 review_history 和 review_observe 追踪改动效果。用友的 domain_tag 按产品版本填写，ASP 费控的标签是「超级版和旗舰版」。开始同类任务时查看 recalledMemory.reviewLessons，沿用适用的验收步骤并留意上次的验证范围。每次浏览器业务操作必须记录实际请求，检查 networkCapture。用 evidence_query 查看方法、路径、参数结构和响应状态；没有观测到请求时记录缺口。复用已核实的业务请求，保留页面点击路径。只读请求失败时走页面并核对结果；写入结果不明时先独立回读，禁止两路重复提交。ASP UAT 打开节点用 asp_workbench_open_node，条件查询模板用 asp_workbench_query_templates，按单号查通用申请单用 asp_workbench_query_general_applications，PC 模板字段用 asp_ui_template_update_field，changes={} 读取属性。批量保存后用 asp_ui_template_verify_batch 在原 run 逐字段回读，再交接整批结果。其他流程用 run_begin 召回经验、browser_run 执行 ego 脚本、run_get 查结果、run_finish 核验并清理。'
  });
  const register = (name, description, inputSchema, method, resultSchema) => server.registerTool(name, {
    description, inputSchema, outputSchema: { data: resultSchema
      ? z.union([resultSchema, z.object({ code: text, message: z.string() }).passthrough()]) : z.unknown() }
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
  registerEvaluationTools(register, service);
  register('asp_workbench_open_node', '在当前 ASP UAT 任务中按精确服务名打开工作台节点。从目录取得编码后请求服务详情并调用工作台原生导航，失败后走工作台搜索及点选。结果通过 run_get 读取，可在同一任务继续操作。', {
    ...workbenchRound, nodeName: text.describe('工作台中的精确服务名称，例如 UI模板。'),
    nodeCode: text.optional().describe('同名目录节点可用候选中的服务编码区分。')
  }, args => readWorkbench(service, 'asp_workbench_open_node', 'openNode', args));
  register('asp_workbench_query_templates', '在当前 ASP UAT 任务中按单据、PC 页面类型查询企业级 UI 模板，可按模板 ID、模板名或交易类型筛选。优先用已核实的只读请求取数，失败后走模板列表。通过 run_get 读取结果及使用的路径。', {
    ...workbenchRound, documentName: text.optional(), documentPath: z.array(text).nonempty().optional(),
    pageType: text.optional(), templateId: text.optional(), templateName: text.optional(), transactionType: text.optional(),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回多少条模板定位信息，默认 10 条。')
  }, args => readWorkbench(service, 'asp_workbench_query_templates', 'queryTemplates', args));
  register('asp_workbench_query_general_applications', '在 ASP UAT 通用申请单列表按单号精确查找。优先复用当前页面已核实的列表请求。首次需要识别查询方案或读取失败时使用工作台查询控件，核对结果中的实际单号。通过 run_get 查看使用路径及结果完整性。', {
    ...workbenchRound, billCode: text.describe('通用申请单的完整单据编号。')
  }, args => readWorkbench(service, 'asp_workbench_query_general_applications', 'queryGeneralApplications', args, billQueryScript));
  register('asp_ui_template_update_field', '配置 ASP UAT 的 PC 单据 UI 模板表头字段或明细列。默认通用报销单表头。未命中时检查 candidates 的 fieldScope、detailEntity 和 fieldId，再精确指定字段；没有匹配时可查 searchedEntities。用 changes={} 读取属性，changes.properties 传属性名或编码，changes.formula 设置公式。设计器原生保存后独立回读。同一操作重试沿用 requestId，更改目标用新 requestId。', {
    requestId: text, domain_tag: domainTag, templateId: text.optional(), templateName: text.optional(), transactionType: text.optional(),
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
  register('asp_ui_template_verify_batch', '在原运行最后一次批量保存后逐字段重新打开模板，记录期望、实际和 observationId。用 run_begin 的 criteria 预登记 path=verifiedTargets、equals=完整 targets，验收时原样传回清单。已有运行也可核对当次提供的清单，布尔条件为 allSelectedFieldsMatch。全部匹配后将 verification 交给 run_finish。同一请求重试沿用 requestId，新增写入后重新发起验收。', {
    ...idempotent, targets: z.array(batchTarget).nonempty()
  }, args => verifyTemplateBatch(service, args));
  register('run_begin', 'Create a durable task and recall procedures. Inspect recalledMemory.reviewLessons for independent reviews of similar runs. Register optional reviewMemory before execution to preserve the prediction and metric and group attempts by problem_id.', {
    requestId: text, goal: text, url: z.string().url(), criteria: z.array(criterion).max(30), recipeIds: z.array(text).optional(),
    domain_tag: domainTag, reviewMemory: reviewMemorySchema.optional(), sessionSource: sessionSource.optional().describe("Original local JSONL log, session ID and optional first relevant line for the reviewer.")
  }, args => service.begin(args));
  register('browser_run', 'Execute ego code with task, page and input. Every business operation must record observed requests. Check networkCapture in run_get and inspect evidence_query for method, path, parameter shape, status or capture gaps. Prefer a verified request; on a failed read use the observed UI route. Independently read back an uncertain write before any retry. Check pageMemos for the current route/dialog. For missing Yonyou nodes inspect ys.entries() and modeActions; for two-pane pickers use ys.transferState/transferRight. DOM globals belong in page.evaluate(). Finish with an independent observe round and run_finish.', {
    ...idempotent, purpose: z.enum(['execute', 'observe']), code: text,
    args: z.unknown().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    pageLabel: text.optional(), resumeAfterUserAction: z.boolean().optional(), memo: z.boolean().optional(),
    resolutions: z.array(z.object({ executionId: text, observationId: text, note: text })).optional()
  }, args => service.browserRun(args));
  register('run_get', 'Read durable run and execution state without replaying commands. Also reconciles completed result files.', {
    runId: text, executionId: text.optional(), ...pagination
  }, args => service.get(args));
  register('run_finish', 'Hand off the execution outcome and its observations for independent evaluation on this MCP server (eval_pending). Success requires a post-action readback. Omit decision and note for a routine handoff. Finish the ego Space once. Save a reusable page reminder in updates[].entry with scope "page", key, name, actionable summary and match (path or pathPrefix, optional hashPrefix and exact dialogTitle). Use baseRevision 0 for a new entry.', {
    ...idempotent, outcome: z.enum(['succeeded', 'failed', 'unknown', 'cancelled']),
    verification: z.array(z.object({ criterionId: text, observationId: text })).default([]),
    decision: z.enum(['confirmed', 'corrected', 'learned', 'no-change']).optional(),
    usedMemoryIds: z.array(text).default([]), updates: z.array(z.record(z.unknown())).max(10).default([]),
    note: text.optional(), keepPages: z.array(text).optional(), retryCleanup: z.boolean().optional()
  }, args => service.finish(args));
  register('memory_search', 'Recall procedures and reviewLessons relevant to the goal. Set domain_tag to share applicable procedures and lessons across environments of the same product edition. Use an empty goal to browse that edition’s lessons. Use sourceRunId in evidence_query for the original Browser records.', {
    url: z.string().url(), goal: z.string(), domain_tag: domainTag, limit: z.number().int().min(1).max(10).optional()
  }, args => service.searchMemory(args));
  register('memory_get', 'Read the complete procedure, revision and provenance for one memory.', {
    memoryId: text
  }, args => service.getMemory(args));
  register('evidence_query', 'Read recorded requests and capture gaps by run or execution. Use view=api for observed methods, paths, query keys, request shapes and statuses. Follow nextCursor while hasMore. An observed endpoint still needs business verification before reuse.', {
    runId: text, view: z.enum(['records', 'trace', 'api']).default('records'), ...pagination, executionId: text.optional()
  }, args => service.queryEvidence(args));
  register('recipe_draft', 'Draft a reusable workflow with automatic request evidence and links to originating executions. Document the verified request inputs, observed click fallback and how to read back the business result in proposedRecipe.', {
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
