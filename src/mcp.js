#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { createService } = require('./service');
const packageInfo = require('../package.json');

const text = z.string().min(1);
const idempotent = { runId: text, requestId: text };
const pagination = { cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(500).optional() };
const criterion = z.object({ id: text, path: z.string(), equals: z.unknown() });
const output = { data: z.unknown() };

function createMcpServer(service = createService()) {
  const server = new McpServer({ name: 'browser-ai', version: packageInfo.version }, {
    instructions: 'Recall a procedure with run_begin, use browser_run for official ego code, poll run_get, then independently observe business results before run_finish. Browser code receives task, page and input. Use ego-browser documented methods; run_finish owns Space cleanup. Never resend an unresolved write with a new requestId.'
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
  register('run_begin', 'Create a durable workflow task and recall applicable procedures. Does not navigate.', {
    requestId: text, goal: text, url: z.string().url(), criteria: z.array(criterion).max(30), recipeIds: z.array(text).optional()
  }, args => service.begin(args));
  register('browser_run', 'Execute ego code with task, page and input. Return JSON and poll run_get. On a missing Yonyou node, try observed row, hover, More and edit-mode entrances from ys.entries() and modeActions. Re-read after each attempt. Use ys.transferState/transferRight for two-pane pickers. Includes memo, scoped readers and observationTrace by default. DOM globals belong in page.evaluate(). Business completion requires a later independent observe round and run_finish.', {
    ...idempotent, purpose: z.enum(['execute', 'observe']), code: text,
    args: z.unknown().optional(), timeoutMs: z.number().int().min(1000).max(120000).optional(),
    pageLabel: text.optional(), resumeAfterUserAction: z.boolean().optional(), memo: z.boolean().optional(),
    resolutions: z.array(z.object({ executionId: text, observationId: text, note: text })).optional()
  }, args => service.browserRun(args));
  register('run_get', 'Read durable run and execution state without replaying commands. Also reconciles completed result files.', {
    runId: text, executionId: text.optional(), ...pagination
  }, args => service.get(args));
  register('run_finish', 'Verify declared criteria against a later observation, atomically submit memory feedback, and finish the ego Space once.', {
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
