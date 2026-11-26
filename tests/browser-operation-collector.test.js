const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('collects paired results from both transcript sources and deduplicates copied calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-collector-'));
  const previousLedger = process.env.BROWSER_DSH_LEDGER;
  const previousRecorder = process.env.BROWSER_AI_RECORDER_DB;
  try {
    process.env.BROWSER_DSH_LEDGER = path.join(root, 'missing-ledger');
    process.env.BROWSER_AI_RECORDER_DB = path.join(root, 'missing-recorder');
    const dsh = path.join(root, 'dsh');
    const codex = path.join(root, 'codex');
    fs.mkdirSync(dsh);
    fs.mkdirSync(codex);
    const t = '2026-11-24T04:00:00Z';
    const dshRows = [
      { type: 'session', id: 'dsh-1' },
      { type: 'tool/call', time: t, data: { name: 'mcp__browser-ai__browser_run', callId: 'd1', arguments: '{}' } },
      { type: 'tool/result', time: t, data: { message: { toolCallId: 'd1', isError: true } } },
    ];
    const codexRows = [
      { type: 'session_meta', payload: { id: 'codex-1' } },
      { type: 'response_item', timestamp: t, payload: { type: 'function_call', name: 'mcp__browser-ai__browser_run', call_id: 'c1', arguments: '{}' } },
      { type: 'response_item', timestamp: t, payload: { type: 'function_call_output', call_id: 'c1', output: '{"state":"succeeded"}' } },
    ];
    const write = (file, rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    write(path.join(dsh, 'a.jsonl'), dshRows);
    write(path.join(dsh, 'copy.jsonl'), dshRows);
    write(path.join(codex, 'a.jsonl'), codexRows);
    const { collectBrowserOperations } = await import('../scripts/browser-operation-collector.mjs');
    const result = await collectBrowserOperations({ day: '2026-11-24', now: Date.parse('2026-11-25T00:00:00Z'), roots: { dsh: [dsh], oracle_codex: [codex] } });
    assert.equal(result.totals.total, 2);
    assert.equal(result.sources.dsh.coverage.duplicateCalls, 1);
    assert.deepEqual(result.rows.map(row => [row.source, row.status]), [['dsh', 'fail'], ['oracle_codex', 'ok']]);
    assert.ok(result.rows.every(row => row.evidence.result));
  } finally {
    if (previousLedger === undefined) delete process.env.BROWSER_DSH_LEDGER; else process.env.BROWSER_DSH_LEDGER = previousLedger;
    if (previousRecorder === undefined) delete process.env.BROWSER_AI_RECORDER_DB; else process.env.BROWSER_AI_RECORDER_DB = previousRecorder;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
