'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/storage');
const { Memory } = require('../src/memory');

function directory(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('legacy memory, active runs, recordings and workflows import once with provenance and resolvable references', () => {
  const legacy = directory('browser-ai-legacy-');
  const target = directory('browser-ai-import-');
  fs.writeFileSync(path.join(legacy, 'domain-memory.json'), JSON.stringify({ version: 1,
    entries: [{ id: 'memory-1', domain: 'example.test', scope: 'page', key: 'create', revision: 3,
      name: 'Create item', summary: 'Create and verify item', verification: 'verified', evidence: ['run:old-run/command:old-command'] }],
    runs: [{ memoryRunId: 'old-run', hostname: 'example.test', status: 'needs-verification',
      commands: [{ commandId: 'old-command', method: 'POST', path: '/cmd', status: 'outcomeUnknown', operation: { name: 'click' } }] }],
  }), 'utf8');
  fs.writeFileSync(path.join(legacy, 'recording.jsonl'), [
    JSON.stringify({ event: { seq: 7, sessionId: 'old-session', memoryRunId: 'old-run', commandId: 'old-command', kind: 'click' } }),
    JSON.stringify({ meta: { cursor: 7, sessions: [['old-session', 7]] } }),
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(legacy, 'workflows.json'), JSON.stringify([{ id: 'old-workflow', name: 'Old workflow', steps: [] }]), 'utf8');

  const store = new Store(target);
  try {
    const first = store.importLegacy(legacy);
    assert.equal(first.imported, true);
    assert.deepEqual(first.counts, { memories: 1, legacyRuns: 1, legacyExecutions: 1, records: 2, drafts: 1 });
    const memory = store.get('memory', 'memory-1');
    assert.equal(memory.revision, 3);
    assert.equal(memory.verification, 'verified', 'historic labels remain data, not new ego verification');
    assert.equal(memory.legacyProvenance.source, 'legacy-recorder');
    assert.ok(memory.evidenceAvailability);
    const legacyRun = store.get('legacyRun', 'old-run');
    assert.equal(legacyRun.status, 'needs_verification');
    const legacyExecution = store.get('legacyExecution', 'old-command');
    assert.equal(legacyExecution.status, 'outcomeUnknown');
    assert.equal(store.get('legacyReference', 'run:old-run/command:old-command').executionId, 'old-command');
    const journal = store.query({ runId: 'old-run', limit: 10 }).records;
    assert.equal(journal.length, 1, 'the event remains attached to its legacy run; global metadata has no run id');
    const legacyEvent = journal.find(row => row.legacyContext?.sessionId === 'old-session');
    assert.equal(legacyEvent.legacyContext.sessionId, 'old-session');
    assert.ok(legacyEvent.gaps.some(gap => gap.kind === 'historical-capture'));
    assert.equal(store.get('draft', 'old-workflow').state, 'draft');
    const repeated = store.importLegacy(legacy);
    assert.equal(repeated.alreadyImported, true);
    assert.deepEqual(repeated.counts, first.counts);
    assert.equal(store.list('memory').length, 1);
    assert.equal(store.query({ limit: 10 }).records.length, 2);

    const search = new Memory(store).search({ url: 'https://example.test/items', goal: 'create item' });
    assert.equal(search.matches[0].id, 'memory-1');
    assert.equal(new Memory(store).get('memory-1').revision, 3);
  } finally { store.close(); }
});

test('malformed legacy identity and empty source are reported without partial import', () => {
  const empty = directory('browser-ai-empty-');
  const target = directory('browser-ai-empty-target-');
  const store = new Store(target);
  try {
    assert.equal(store.importLegacy(empty).reason, 'NO_LEGACY_FILES');
    const malformed = directory('browser-ai-malformed-');
    fs.writeFileSync(path.join(malformed, 'domain-memory.json'), JSON.stringify({ version: 1,
      entries: [], runs: [{ memoryRunId: 'duplicate', commands: [{ commandId: 'same' }, { commandId: 'same' }] }] }), 'utf8');
    assert.throws(() => store.importLegacy(malformed), error => error.code === 'INVALID_LEGACY_EVIDENCE');
    assert.equal(store.list('memory').length, 0);
    assert.equal(store.list('legacyRun').length, 0);
  } finally { store.close(); }
});

