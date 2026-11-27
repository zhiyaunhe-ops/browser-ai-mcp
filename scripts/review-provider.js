'use strict';

const { readFileSync } = require('node:fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = require('../src/mcp');
const { createService } = require('../src/service');

const actions = new Set([
  'eval_pending', 'eval_packet', 'evidence_query', 'eval_submit', 'run_summary', 'eval_session_context',
  'review_improve', 'review_apply', 'review_improvements', 'review_history', 'review_observe',
]);

async function call({ action, arguments: args }) {
  if (!actions.has(action)) throw new Error(`Unknown review provider action: ${action}`);
  const service = createService();
  const server = createMcpServer(service, 'review');
  const client = new Client({ name: 'yonclaw-toolkit', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: action, arguments: args });
    const data = result.structuredContent?.data;
    if (result.isError) {
      return { ok: false, error: data ?? { code: 'BROWSER_REVIEW_INVALID_REQUEST', message: result.content[0]?.text } };
    }
    return { ok: true, data };
  } finally {
    await client.close();
    service.close();
  }
}

async function main() {
  const result = await call(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
