#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { partialHandoff } = require('./partial-handoff');
const { createService } = require('./service');
const { registerEvaluationTools, reviewMemorySchema, sessionSource } = require('./review');
const { link: improvementLink } = require('./review/improvements');
const { updateTemplateField } = require('./asp-template');
const { verifyTemplateBatch } = require('./asp-template-batch');
const { workbenchScript, billQueryScript } = require('./asp-scripts');
const { interactionRule } = require('./interaction-rule');
const packageInfo = require('../package.json');

const text = z.string().min(1);
const domainTag = text.optional().describe('Product edition for reusable knowledge. Use the same exact domain_tag across environments.');
const idempotent = { runId: text, requestId: text };
const pagination = { cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() };
const browserContext = z.object({ url: z.string().url().optional(), node: z.string().optional(), productVersion: z.string().optional() });
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

function createMcpServer(service = createService(), toolset = 'execution') {
  const instructions = {
    all: 'Browser AI provides YonBuilder queries, ASP workbench operations, durable browser runs and evidence review.',
    execution: 'Execute browser runs and query recorded evidence.',
    review: 'Review browser run evidence, submit assessments and track improvements.'
  };
  if (!Object.hasOwn(instructions, toolset)) throw new Error('Expected --tools all, execution or review.');
  const name = toolset === 'review' ? 'browser-ai-review' : 'browser-ai';
  const server = new McpServer({ name, version: packageInfo.version }, {
    instructions: instructions[toolset] + ' Tool results are returned in structuredContent.data.'
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
        ...(error.cli ? { cli: error.cli } : {}),
        ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
        ...(error.runId === undefined ? {} : { runId: error.runId }),
        ...(error.blockingExecutions === undefined ? {} : { blockingExecutions: error.blockingExecutions }),
        ...(error.readbacks === undefined ? {} : { readbacks: error.readbacks }),
        ...(error.executionStarted === undefined ? {} : { executionStarted: error.executionStarted }),
        ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {}),
        ...(Array.isArray(error.issues) ? { issues: error.issues } : {}) };
      return { isError: true, structuredContent: { data }, content: [{ type: 'text', text: JSON.stringify({ data }) }] };
    }
  });
  register('evidence_query', 'Read paginated run or execution records. view=api returns observed request methods, paths, parameter shapes, statuses and capture gaps.', {
    runId: text, view: z.enum(['records', 'trace', 'api']).default('records'), ...pagination, executionId: text.optional()
  }, args => service.queryEvidence(args));
  if (toolset !== 'execution') registerEvaluationTools(register, service);
  if (toolset === 'review') return server;
  require('./yonbuilder').registerYonbuilder(register, service);

  register('asp_workbench_open_node', '按工作台服务名打开 ASP UAT 节点；同名节点可指定 nodeCode。返回执行 ID，通过 run_get 读取结果。', {
    ...workbenchRound, nodeName: text.describe('工作台中的精确服务名称，例如 UI模板。'),
    nodeCode: text.optional().describe('同名目录节点可用候选中的服务编码区分。')
  }, args => readWorkbench(service, 'asp_workbench_open_node', 'openNode', args));
  register('asp_workbench_query_templates', '按单据和 PC 页面类型查询企业级模板。支持模板 ID、名称和交易类型筛选，通过 run_get 读取候选。', {
    ...workbenchRound, documentName: text.optional(), documentPath: z.array(text).nonempty().optional(),
    pageType: text.optional(), templateId: text.optional(), templateName: text.optional(), transactionType: text.optional(),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回多少条模板定位信息，默认 10 条。')
  }, args => readWorkbench(service, 'asp_workbench_query_templates', 'queryTemplates', args));
  register('asp_workbench_query_general_applications', '按完整单号查询 ASP UAT 通用申请单。通过 run_get 读取匹配结果和查询完整性。', {
    ...workbenchRound, billCode: text.describe('通用申请单的完整单据编号。')
  }, args => readWorkbench(service, 'asp_workbench_query_general_applications', 'queryGeneralApplications', args, billQueryScript));
  register('asp_ui_template_update_field', '读写 ASP UAT 的 PC 模板字段。changes={} 读取，changes.properties 设置属性，changes.formula 设置公式。返回候选或保存后的回读结果。', {
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
  register('asp_ui_template_verify_batch', '在原 run 中按 targets 逐字段回读已保存的模板，返回期望值、实际值和验收观察引用。支持 verifiedTargets 和 allSelectedFieldsMatch 条件。', {
    ...idempotent, targets: z.array(batchTarget).nonempty()
  }, args => verifyTemplateBatch(service, args));
  register('run_begin', 'Create a run with a goal, URL and observable criteria. Returns runId, matching procedures and script briefings.', {
    requestId: text, goal: text, url: z.string().url(), context: browserContext.optional(), criteria: z.array(criterion).max(30), recipeIds: z.array(text).optional(),
    domain_tag: domainTag, improvement: improvementLink.optional(), reviewMemory: reviewMemorySchema.optional(), sessionSource: sessionSource.optional().describe("Original local JSONL log, session ID and optional first relevant line for the reviewer.")
  }, args => service.begin(args));
  register('yonbuilder_interaction_rule', 'Read a rule, capture one successful unchanged save in page memory, rename with readback, or release the capture. Use the same designer document for all rounds.', {
    ...idempotent, pageLabel: text.optional(), operation: z.enum(['read', 'capture', 'rename', 'release']),
    templateId: text, billNo: text, ownDomain: text, ruleCode: text,
    expectedName: text.optional().describe('Current rule name, required for capture and rename.'),
    name: text.optional().describe('New rule name, required for rename.')
  }, ({ runId, requestId, pageLabel, ...input }) => {
    if (['capture', 'rename'].includes(input.operation) && !input.expectedName) {
      throw Object.assign(new Error('expectedName is required for capture and rename.'), { code: 'INVALID_ARGUMENT' });
    }
    if (input.operation === 'rename' && !input.name?.trim()) {
      throw Object.assign(new Error('name is required for rename.'), { code: 'INVALID_ARGUMENT' });
    }
    return service.browserRun({
      runId, requestId, pageLabel, purpose: input.operation === 'read' ? 'observe' : 'execute', args: input,
      code: `return await page.evaluate(${interactionRule.toString()}, input);`
    });
  });
  register('browser_run', '在已有 run 中执行一个 ego 轮次。传 code（可用 task、page、input）或缓存脚本简报中的 invoke.script。args 作为 input。用返回的 executionId 查询状态、结果和网络记录。', {
    ...idempotent, purpose: z.enum(['execute', 'observe']), code: text.optional(),
    script: z.object({ id: text, version: text, briefingId: text.optional() }).optional(),
    scriptBriefingId: text.optional(), fallbackReason: text.optional(), context: browserContext.optional(),
    args: z.unknown().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    pageLabel: text.optional(), resumeAfterUserAction: z.boolean().optional(), memo: z.boolean().optional(),
    resolutions: z.array(z.object({ executionId: text, observationId: text, note: text })).optional()
  }, args => service.browserRun(args));
  register('run_get', 'Read durable run and execution state without replaying commands. Query the executionId returned by the round or in blockingExecutions. Also reconciles completed result files.', {
    runId: text, executionId: text.optional(), ...pagination
  }, args => service.get(args));
  register('run_finish', 'Close a run with its outcome and criterion-to-observation references. Success requires matching independent readbacks after the last write. For unknown, partialHandoff records the primary reason, remaining work and observed steps.', {
    ...idempotent, outcome: z.enum(['succeeded', 'failed', 'unknown', 'cancelled']),
    partialHandoff: partialHandoff.optional(),
    verification: z.array(z.object({ criterionId: text, observationId: text })).default([]),
    decision: z.enum(['confirmed', 'corrected', 'learned', 'no-change']).optional(),
    usedMemoryIds: z.array(text).default([]), updates: z.array(z.record(z.unknown())).max(10).default([]),
    note: text.optional(), keepPages: z.array(text).optional(), retryCleanup: z.boolean().optional()
  }, args => service.finish(args));
  register('memory_search', 'Find procedures and review lessons by URL, goal and product edition. An empty goal browses the edition.', {
    url: z.string().url(), goal: z.string(), context: browserContext.optional(), domain_tag: domainTag, limit: z.number().int().min(1).max(10).optional()
  }, args => service.searchMemory(args));
  register('memory_get', 'Read the complete procedure, revision and provenance for one memory.', {
    memoryId: text
  }, args => service.getMemory(args));
  register('recipe_draft', 'Draft a reusable procedure from a run, with captured request evidence and source execution IDs.', {
    ...idempotent, name: text, proposedRecipe: z.record(z.unknown()).optional()
  }, args => service.draftRecipe(args));
  return server;
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  let toolset = 'execution';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) options.dataDir = args[++i];
    else if (args[i] === '--tools' && args[i + 1]) toolset = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`Usage: node src/mcp.js [--data-dir ABSOLUTE_DIRECTORY] [--tools all|execution|review]\nRequires Node ${packageInfo.engines.node}. Browser execution requires ego-browser. Transport: MCP stdio.\n`);
      return;
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const service = createService(options);
  const server = createMcpServer(service, toolset);
  const transport = new StdioServerTransport();
  server.onclose = () => service.close();
  await server.connect(transport);
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { createMcpServer, main };
