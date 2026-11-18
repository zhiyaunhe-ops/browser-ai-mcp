#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { startFixtureSite } = require('../tests/fixtures/mcp-local-site');

async function call(client, name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) {
    const error = response.structuredContent?.data || response.content?.[0]?.text;
    throw new Error(`${name} failed: ${JSON.stringify(error)}`);
  }
  return response.structuredContent.data;
}

async function execution(client, runId, executionId) {
  let lastRow = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await call(client, 'run_get', { runId, executionId });
    const row = state.executions.find(item => item.executionId === executionId);
    lastRow = row || lastRow;
    if (row && !['queued', 'running'].includes(row.state)) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${executionId}: ${JSON.stringify(lastRow)}`);
}

async function settledRun(client, runId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await call(client, 'run_get', { runId });
    if (state.state !== 'finishing' && !['pending', 'running'].includes(state.cleanup?.state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId} cleanup`);
}

async function main() {
  const fixture = await startFixtureSite();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ai-mcp-e2e-'));
  const client = new Client({ name: 'browser-ai-mcp-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'src', 'mcp.js'), '--data-dir', dataDir],
    env: process.env.BROWSER_AI_EGO_BIN ? { BROWSER_AI_EGO_BIN: process.env.BROWSER_AI_EGO_BIN } : undefined,
    cwd: path.join(__dirname, '..'),
    stderr: 'inherit',
  });
  let run;
  let finishAttempted = false;
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    run = await call(client, 'run_begin', {
      requestId: 'e2e-begin-1', goal: 'Create customer C-1001 and verify it is durable', url: fixture.url,
      criteria: [{ id: 'customer-created', path: 'customer.code', equals: 'C-1001' }],
    });
    assert.equal(run.spaceId, null, 'run_begin creates no browser Space before an execution');

    const initial = await call(client, 'browser_run', {
      runId: run.runId, requestId: 'e2e-observe-1', purpose: 'observe',
      code: 'await page.goto(input.url); return { title: await page.title(), snapshot: await page.snapshot() };',
      args: { url: fixture.url }, timeoutMs: 60_000,
    });
    const initialExecution = await execution(client, run.runId, initial.executionId);
    assert.equal(initialExecution.state, 'succeeded');
    assert.ok(initialExecution.spaceId, 'ego returned a durable TaskSpace id');
    assert.equal(initialExecution.observationId != null, true);

    const nodeLinks = await call(client, 'browser_run', {
      runId: run.runId, requestId: 'e2e-node-links-1', purpose: 'execute',
      code: `const nodeUrl = input.url.replace('/customers', '/node-links');
await page.goto(nodeUrl);
const discovery = await page.ys.entries();
const missing = await page.ys.find('definitely absent target');
const frameClicks = () => page.evaluate(() => document.querySelector('#grid-frame')?.contentDocument?.querySelector('#clicks')?.textContent);
const initialClicks = await frameClicks();
if (!discovery.complete) throw new Error('entry discovery incomplete: ' + JSON.stringify(discovery));
if (!discovery.entries.some(item => item.kind === 'mapping' && item.name.includes('对照表'))) throw new Error('mapping button was not listed');
if (!discovery.entries.some(item => item.kind === 'link' && item.name === 'View' && item.rowText.includes('Product A'))) throw new Error('href-less anchor was not listed');
if (!discovery.entries.some(item => item.kind === 'link' && item.name === 'Open mapping' && item.rowText.includes('Product B'))) throw new Error('delegated inline span was not listed');
if (discovery.entries.some(item => item.name === 'Active')) throw new Error('green status text was misclassified as a link');
if (!missing.entryPoints?.some(item => item.kind === 'mapping') || missing.searchScope !== 'current-view') throw new Error('missing-target discovery omitted current-view entry points');
if (initialClicks !== '0') throw new Error('discovery clicked something automatically');
const hoverEntries = await page.ys.entries({ rowText: 'Product B', framePath: '0/0', reveal: true });
if (!hoverEntries.complete || !hoverEntries.entries.some(item => item.name === '对照表' && item.rowText.includes('Product B'))) throw new Error('hover toolbar was not found in the exact row: ' + JSON.stringify(hoverEntries));
if (await frameClicks() !== '0') throw new Error('hover reveal clicked a row action');
const hoverClick = await page.ys.click('对照表', { rowText: 'Product B', framePath: '0/0' });
if (!hoverClick.clicked) throw new Error('explicit row-scoped mapping click failed: ' + JSON.stringify(hoverClick));
const childAfterHover = await page.evaluate(() => document.querySelector('#grid-frame')?.contentDocument?.querySelector('h1')?.textContent);
if (childAfterHover !== 'Child: Product B') throw new Error('hover action opened the wrong row: ' + childAfterHover);
await page.goto(nodeUrl);
const scoped = await page.ys.click('View', { rowText: 'Product B' });
if (!scoped.clicked) throw new Error('row-scoped duplicate click failed: ' + JSON.stringify(scoped));
const childAfterAnchor = await page.evaluate(() => ({ heading: document.querySelector('#grid-frame')?.contentDocument?.querySelector('h1')?.textContent, entries: document.querySelector('#grid-frame')?.contentDocument?.querySelector('#view')?.textContent }));
if (childAfterAnchor.heading !== 'Child: Product B') throw new Error('wrong duplicate row opened: ' + JSON.stringify(childAfterAnchor));
await page.goto(nodeUrl);
const inline = await page.ys.click('Open mapping', { rowText: 'Product A' });
if (!inline.clicked) throw new Error('delegated inline span click failed: ' + JSON.stringify(inline));
const childAfterSpan = await page.evaluate(() => document.querySelector('#grid-frame')?.contentDocument?.querySelector('h1')?.textContent);
const childEntries = await page.ys.entries();
const childDetails = await page.ys.click('Child details');
if (!childDetails.clicked) throw new Error('explicit child-detail link was not actionable: ' + JSON.stringify(childDetails));
const childDetailsTitle = await page.evaluate(() => document.querySelector('#grid-frame')?.contentDocument?.querySelector('h1')?.textContent);
const childDetailsRead = await page.ys.entries();
await page.goto(input.url.replace('/customers', '/loading-view'));
const busy = await page.ys.find('never present while loading', { scope: '#loading-view' });
if (busy.reason !== 'loading' || busy.complete !== false) throw new Error('busy view was reported as absence: ' + JSON.stringify(busy));
await page.evaluate(() => { document.querySelector('#loading-view').removeAttribute('aria-busy'); document.querySelector('.loading-mask').remove(); });
const absent = await page.ys.find('never present while loading', { scope: '#loading-view' });
if (absent.reason !== 'no-match' || absent.complete !== true) throw new Error('settled empty view did not return a complete no-match: ' + JSON.stringify(absent));
return { discovery: discovery.entries, missing: { searchScope: missing.searchScope, entryPoints: missing.entryPoints },
  initialClicks, hoverEntries: hoverEntries.entries, hoverRowCells: hoverClick.best.rowCells, childAfterHover,
  scopedRowCells: scoped.best.rowCells, childAfterAnchor, inlineRowCells: inline.best.rowCells,
  childAfterSpan, childEntries: childEntries.entries, childDetailsTitle, childDetailsReadComplete: childDetailsRead.complete,
  busyReason: busy.reason, busyComplete: busy.complete,
  settledReason: absent.reason, settledComplete: absent.complete };`,
      args: { url: fixture.url }, timeoutMs: 60_000,
    });
    const nodeLinksExecution = await execution(client, run.runId, nodeLinks.executionId);
    assert.equal(nodeLinksExecution.state, 'succeeded', JSON.stringify(nodeLinksExecution));
    assert.equal(nodeLinksExecution.result.initialClicks, '0', 'discovery must not click automatically');
    assert.ok(nodeLinksExecution.result.hoverEntries.some(item => item.kind === 'mapping' && item.name === '对照表'));
    assert.ok(nodeLinksExecution.result.hoverRowCells.includes('Product B'));
    assert.equal(nodeLinksExecution.result.childAfterHover, 'Child: Product B');
    assert.ok(nodeLinksExecution.result.scopedRowCells.includes('Product B'));
    assert.equal(nodeLinksExecution.result.childAfterAnchor.heading, 'Child: Product B');
    assert.ok(nodeLinksExecution.result.inlineRowCells.includes('Product A'));
    assert.equal(nodeLinksExecution.result.childAfterSpan, 'Child: Product A');
    assert.ok(nodeLinksExecution.result.childEntries.some(item => item.kind === 'link' && item.name === 'Child details'),
      'rereading the child view should find its new entry point');
    assert.equal(nodeLinksExecution.result.childDetailsTitle, 'Details: Product record');
    assert.equal(nodeLinksExecution.result.childDetailsReadComplete, true);
    assert.equal(nodeLinksExecution.result.busyReason, 'loading');
    assert.equal(nodeLinksExecution.result.busyComplete, false);
    assert.equal(nodeLinksExecution.result.settledReason, 'no-match');
    assert.equal(nodeLinksExecution.result.settledComplete, true);

    const transfer = await call(client, 'browser_run', {
      runId: run.runId, requestId: 'e2e-transfer-1', purpose: 'execute',
      code: `const transferUrl = input.url.replace('/customers', '/transfer');
await page.goto(transferUrl);
const before = await page.ys.transferState({ scope: '#chooser' });
if (!before.complete) throw new Error('transfer state incomplete: ' + JSON.stringify(before));
const operation = await page.ys.transferRight(['Inventory', 'Inventory Control', 'Already in target'], { scope: '#chooser' });
const after = await page.ys.transferState({ scope: '#chooser' });
const firstMoveCount = await page.evaluate(() => document.querySelector('#move-count')?.textContent);
if (!operation.ok || !operation.verified) throw new Error('single transfer did not verify: ' + JSON.stringify(operation));
if (JSON.stringify(operation.moved) !== JSON.stringify(['Inventory', 'Inventory Control'])) throw new Error('unexpected moved items: ' + JSON.stringify(operation));
if (!operation.alreadyRight?.includes('Already in target')) throw new Error('existing target item was not recognized: ' + JSON.stringify(operation));
if (firstMoveCount !== '1') throw new Error('expected exactly one move-right action, got ' + firstMoveCount);
if (!after.right.items.some(item => item.name === 'Already in target') || !after.right.items.some(item => item.name === 'Inventory') || !after.right.items.some(item => item.name === 'Inventory Control')) throw new Error('exact target readback missing: ' + JSON.stringify(after.right));
if (after.right.items.length !== before.right.items.length + 2) throw new Error('unexpected destination growth: ' + JSON.stringify({ before: before.right.items, after: after.right.items }));
if (!after.left.items.some(item => item.name === 'Duplicate') || !after.left.items.some(item => item.name === 'Locked option' && item.disabled)) throw new Error('unrequested or disabled items were not preserved');
const ambiguous = await page.ys.transferRight(['Duplicate'], { scope: '#chooser' });
const disabled = await page.ys.transferRight(['Locked option'], { scope: '#chooser' });
const afterGuards = await page.ys.transferState({ scope: '#chooser' });
const afterGuardMoveCount = await page.evaluate(() => document.querySelector('#move-count')?.textContent);
if (ambiguous.ok || disabled.ok) throw new Error('ambiguous or disabled option was accepted');
if (afterGuardMoveCount !== '1' || afterGuards.right.items.length !== after.right.items.length) throw new Error('a refusal caused an extra movement');
await page.goto(transferUrl + '?prechecked=1');
const precheckedBefore = await page.ys.transferState({ scope: '#chooser' });
const prechecked = await page.ys.transferRight(['Inventory'], { scope: '#chooser' });
const precheckedAfter = await page.ys.transferState({ scope: '#chooser' });
const precheckedMoveCount = await page.evaluate(() => document.querySelector('#move-count')?.textContent);
const moveAllControls = await page.evaluate(() => [...document.querySelectorAll('button')].filter(button => /all/i.test((button.getAttribute('aria-label') || '') + ' ' + button.textContent)).length);
if (!precheckedBefore.left.items.some(item => item.name === 'Extra preselection' && item.checked)) throw new Error('preselected guard fixture was not selected');
if (prechecked.ok || precheckedMoveCount !== '0' || precheckedAfter.right.items.length !== 1) throw new Error('extra preselection was not refused without moving items');
return { moved: operation.moved, alreadyRight: operation.alreadyRight, verified: operation.verified,
  businessSaved: operation.businessSaved, firstMoveCount, targetNames: after.right.items.map(item => item.name), ambiguousOk: ambiguous.ok,
  disabledOk: disabled.ok, guardedMoveCount: afterGuardMoveCount, precheckedOk: prechecked.ok,
  precheckedMoveCount, precheckedRight: precheckedAfter.right.items.map(item => item.name), moveAllControls };`,
      args: { url: fixture.url }, timeoutMs: 60_000,
    });
    const transferExecution = await execution(client, run.runId, transfer.executionId);
    assert.equal(transferExecution.state, 'succeeded', JSON.stringify(transferExecution));
    assert.deepEqual(transferExecution.result.moved, ['Inventory', 'Inventory Control']);
    assert.deepEqual(transferExecution.result.alreadyRight, ['Already in target']);
    assert.equal(transferExecution.result.verified, true);
    assert.equal(transferExecution.result.businessSaved, false);
    assert.equal(transferExecution.result.firstMoveCount, '1');
    assert.equal(transferExecution.result.guardedMoveCount, '1');
    assert.equal(transferExecution.result.ambiguousOk, false);
    assert.equal(transferExecution.result.disabledOk, false);
    assert.equal(transferExecution.result.precheckedOk, false);
    assert.equal(transferExecution.result.precheckedMoveCount, '0');
    assert.equal(transferExecution.result.moveAllControls, 0);

    const yonyouTransfer = await call(client, 'browser_run', {
      runId: run.runId, requestId: 'e2e-yonyou-transfer-1', purpose: 'execute',
      code: `const yonyouUrl = input.url.replace('/customers', '/yonyou-transfer');
await page.goto(yonyouUrl);
const before = await page.ys.transferState({ scope: '#template-export' });
if (!before.complete) throw new Error('expanded template tree was incomplete: ' + JSON.stringify(before));
if (before.left.items.some(item => item.name === '基础档案对照_node') || before.right.items.some(item => item.name === '基础档案对照_node')) throw new Error('duplicate folder roots were counted as movable leaves');
if (!before.left.items.some(item => item.name === '部门级别') || !before.left.items.some(item => item.name === '收支项目')) throw new Error('template leaves were not read');
const operation = await page.ys.transferRight(['部门级别', '收支项目'], { scope: '#template-export' });
const after = await page.ys.transferState({ scope: '#template-export' });
const selectedMoves = await page.evaluate(() => document.querySelector('#selected-moves')?.textContent);
const allMoves = await page.evaluate(() => document.querySelector('#all-moves')?.textContent);
if (!operation.ok || !operation.verified || JSON.stringify(operation.moved) !== JSON.stringify(['部门级别', '收支项目'])) throw new Error('Yonyou selected transfer failed: ' + JSON.stringify(operation));
if (operation.businessSaved !== false || selectedMoves !== '1' || allMoves !== '0') throw new Error('wrong Yonyou transfer control was used: ' + JSON.stringify({ operation, selectedMoves, allMoves }));
if (after.right.items.length !== 2 || !after.right.items.some(item => item.name === '部门级别') || !after.right.items.some(item => item.name === '收支项目')) throw new Error('Yonyou right-side readback was not exact: ' + JSON.stringify(after.right));
if (after.left.items.length !== 0) throw new Error('Yonyou source still contains moved leaves: ' + JSON.stringify(after.left));
await page.goto(yonyouUrl + '?collapsed=1');
const collapsed = await page.ys.transferState({ scope: '#template-export' });
if (collapsed.complete || collapsed.reason !== 'collapsed-tree' || !collapsed.right.expandHints?.some(hint => hint.canExpand)) throw new Error('collapsed right tree was reported empty or not expandable: ' + JSON.stringify(collapsed));
const expandedMove = await page.ys.transferRight(['部门级别'], { scope: '#template-export' });
if (!expandedMove.ok || !expandedMove.verified || JSON.stringify(expandedMove.moved) !== JSON.stringify(['部门级别'])) throw new Error('collapsed-root transfer did not expand and verify: ' + JSON.stringify(expandedMove));
if (!expandedMove.expandedRoots?.some(item => item.side === 'right')) throw new Error('transfer did not record expansion of the unique right root');
const expandedState = await page.ys.transferState({ scope: '#template-export' });
if (!expandedState.complete) throw new Error('expanded right tree could not be independently reread: ' + JSON.stringify(expandedState));
const expandedRight = expandedState.right.items;
const expandedNames = expandedRight.map(item => item.name).sort();
if (JSON.stringify(expandedNames) !== JSON.stringify(['Existing mapping A', 'Existing mapping B', 'Existing mapping C', '部门级别'].sort())) throw new Error('collapsed right-side readback lost existing entries: ' + JSON.stringify(expandedNames));
const collapsedCounts = await page.evaluate(() => ({ selected: document.querySelector('#selected-moves')?.textContent, all: document.querySelector('#all-moves')?.textContent }));
if (collapsedCounts.selected !== '1' || collapsedCounts.all !== '0') throw new Error('collapsed transfer used a bulk or repeated action: ' + JSON.stringify(collapsedCounts));
return { moved: operation.moved, selectedMoves, allMoves, targetNames: after.right.items.map(item => item.name),
  collapsedReason: collapsed.reason, expandHints: collapsed.right.expandHints, expandedRoots: expandedMove.expandedRoots,
  expandedMoved: expandedMove.moved, expandedRight: expandedNames, collapsedCounts };`,
      args: { url: fixture.url }, timeoutMs: 60_000,
    });
    const yonyouTransferExecution = await execution(client, run.runId, yonyouTransfer.executionId);
    assert.equal(yonyouTransferExecution.state, 'succeeded', JSON.stringify(yonyouTransferExecution));
    assert.deepEqual(yonyouTransferExecution.result.moved, ['部门级别', '收支项目']);
    assert.equal(yonyouTransferExecution.result.selectedMoves, '1');
    assert.equal(yonyouTransferExecution.result.allMoves, '0');
    assert.equal(yonyouTransferExecution.result.collapsedReason, 'collapsed-tree');
    assert.ok(yonyouTransferExecution.result.expandedRoots.some(item => item.side === 'right'));
    assert.deepEqual(yonyouTransferExecution.result.expandedMoved, ['部门级别']);
    assert.deepEqual(yonyouTransferExecution.result.expandedRight,
      ['Existing mapping A', 'Existing mapping B', 'Existing mapping C', '部门级别']);
    assert.deepEqual(yonyouTransferExecution.result.collapsedCounts, { selected: '1', all: '0' });

    const write = await call(client, 'browser_run', {
      runId: run.runId, requestId: 'e2e-execute-1', purpose: 'execute',
      code: `await page.goto(input.url);
await page.fill('input[name="code"]', input.code);
await page.fill('input[name="name"]', input.name);
await page.click('button[type="submit"]', { label: 'save customer record' });
await page.waitForSelector('#status[data-saved="true"]');
return await page.evaluate(() => ({ text: document.querySelector('#status')?.textContent, saved: document.querySelector('#status')?.dataset.saved }));`,
      args: { url: fixture.url, code: 'C-1001', name: 'MCP Fixture Customer' }, timeoutMs: 60_000,
    });
    const writeExecution = await execution(client, run.runId, write.executionId);
    assert.equal(writeExecution.state, 'succeeded', JSON.stringify(writeExecution));
    assert.equal(writeExecution.spaceId, initialExecution.spaceId, 'all rounds reused the same ego Space');
    assert.equal(writeExecution.result.saved, 'true');

    const finalObservation = await call(client, 'browser_run', {
      runId: run.runId, requestId: 'e2e-observe-final-1', purpose: 'observe',
      code: `const customer = await page.evaluate(async code => {
  const response = await fetch('/api/customers/' + encodeURIComponent(code));
  return response.ok ? await response.json() : { error: response.status };
}, input.code);
return { customer: customer.customer };`,
      args: { code: 'C-1001' }, timeoutMs: 60_000,
    });
    const verificationExecution = await execution(client, run.runId, finalObservation.executionId);
    assert.equal(verificationExecution.state, 'succeeded');
    assert.deepEqual(verificationExecution.result.customer, { code: 'C-1001', name: 'MCP Fixture Customer' });
    assert.notEqual(verificationExecution.observationId, initialExecution.observationId);

    const evidence = await call(client, 'evidence_query', { runId: run.runId, view: 'records', limit: 100 });
    assert.ok(evidence.records.some(record => record.kind === 'observation' && record.payload.observationId === verificationExecution.observationId));
    assert.ok(evidence.gaps.some(gap => gap.kind === 'human-actions-not-captured'));
    assert.ok(evidence.gaps.some(gap => gap.kind === 'network-not-captured'));

    const draft = await call(client, 'recipe_draft', {
      runId: run.runId, requestId: 'e2e-draft-1', name: 'Create customer',
      proposedRecipe: { preconditions: ['Customer form is open'], steps: ['Enter customer code and name', 'Save'],
        verify: ['GET customer by code and compare persisted fields'] },
    });
    assert.equal(draft.state, 'draft');

    finishAttempted = true;
    await call(client, 'run_finish', {
      runId: run.runId, requestId: 'e2e-finish-1', outcome: 'succeeded', decision: 'learned',
      note: 'The separate post-save read returned the durable customer record.',
      verification: [{ criterionId: 'customer-created', observationId: verificationExecution.observationId }],
      updates: [{ baseRevision: 0, entry: { key: 'customer-create', name: 'Create customer',
        summary: 'Create a customer record and verify it by reading it back.', scope: 'page', url: fixture.url,
        verification: 'verified', recipe: { verify: ['customer.code equals the saved code'] } } }],
    });
    const finished = await settledRun(client, run.runId);
    assert.equal(finished.state, 'completed');
    assert.equal(finished.cleanup.state, 'succeeded');
    assert.equal(finished.feedback.changedMemoryIds.length, 1);
    const memorySummary = await call(client, 'memory_search', { url: fixture.url, goal: 'create customer' });
    assert.equal(memorySummary.matches.length, 1);
    const memory = await call(client, 'memory_get', { memoryId: memorySummary.matches[0].id });
    assert.equal(memory.verification, 'verified');
    assert.deepEqual(memory.evidence, [verificationExecution.observationId]);

    process.stdout.write(JSON.stringify({
      result: 'PASS', runId: run.runId, spaceId: initialExecution.spaceId,
      executions: [initialExecution.executionId, nodeLinksExecution.executionId, transferExecution.executionId, yonyouTransferExecution.executionId,
        writeExecution.executionId, verificationExecution.executionId],
      verificationObservationId: verificationExecution.observationId,
      memoryId: memory.id, cleanup: finished.cleanup.state,
    }) + '\n');
  } catch (error) {
    if (run && !finishAttempted) {
      finishAttempted = true;
      try {
        await call(client, 'run_finish', { runId: run.runId, requestId: 'e2e-abort-finish-1', outcome: 'failed',
          decision: 'no-change', note: `E2E aborted: ${error.message}` });
      } catch (cleanupError) {
        process.stderr.write(`Could not finish test Space through MCP: ${cleanupError.message}\n`);
      }
    }
    throw error;
  } finally {
    await client.close().catch(() => {});
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

