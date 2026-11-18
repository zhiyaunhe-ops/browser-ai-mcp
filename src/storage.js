'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) :
  plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw fail('INVALID_STORAGE_INPUT', `${field} must be a nonempty string`);
  return value;
}

function jsonObject(value, field) {
  if (!plain(value)) throw fail('INVALID_STORAGE_INPUT', `${field} must be an object`);
  try {
    const output = clone(value);
    if (!plain(output)) throw new Error('serialized value is not an object');
    return output;
  } catch (error) { throw fail('INVALID_STORAGE_INPUT', `${field} must be JSON serializable: ${error.message}`); }
}

function legacyId(fingerprint, suffix) {
  const value = crypto.createHash('sha256').update(`${fingerprint}:${suffix}`).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function legacyFailure(file, message, line) {
  return fail('INVALID_LEGACY_EVIDENCE', `${file}${line ? `:${line}` : ''}: ${message}`, { file, ...(line ? { line } : {}) });
}

function parseLegacy(files) {
  let saved = { entries: [], runs: [] };
  if (files.has('domain-memory.json')) {
    try { saved = JSON.parse(files.get('domain-memory.json').toString('utf8')); }
    catch (error) { throw legacyFailure('domain-memory.json', `invalid JSON: ${error.message}`); }
    if (!plain(saved) || saved.version !== 1 || !Array.isArray(saved.entries) ||
        saved.runs !== undefined && !Array.isArray(saved.runs)) throw legacyFailure('domain-memory.json', 'expected version 1 entries and optional runs arrays');
    saved.runs ||= [];
    const identities = new Set();
    for (const entry of saved.entries) {
      if (!plain(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.domain !== 'string' ||
          !['domain', 'page'].includes(entry.scope) || typeof entry.key !== 'string' || !entry.key ||
          !Number.isSafeInteger(entry.revision ?? 0) || (entry.revision ?? 0) < 0 ||
          entry.evidence !== undefined && !Array.isArray(entry.evidence)) throw legacyFailure('domain-memory.json', 'invalid memory identity, revision, or evidence');
      if (identities.has(entry.id)) throw legacyFailure('domain-memory.json', `duplicate memory id ${entry.id}`);
      identities.add(entry.id);
    }
    identities.clear();
    for (const run of saved.runs) {
      if (!plain(run) || typeof run.memoryRunId !== 'string' || !run.memoryRunId || !Array.isArray(run.commands)) throw legacyFailure('domain-memory.json', 'invalid legacy run');
      if (identities.has(run.memoryRunId)) throw legacyFailure('domain-memory.json', `duplicate run id ${run.memoryRunId}`);
      identities.add(run.memoryRunId);
      const commands = new Set();
      for (const command of run.commands) {
        if (!plain(command) || typeof command.commandId !== 'string' || !command.commandId || commands.has(command.commandId)) throw legacyFailure('domain-memory.json', `invalid or duplicate command in ${run.memoryRunId}`);
        commands.add(command.commandId);
      }
    }
  }
  const journal = [];
  if (files.has('recording.jsonl')) {
    const lines = files.get('recording.jsonl').toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let record;
      try { record = JSON.parse(lines[index]); }
      catch (error) { throw legacyFailure('recording.jsonl', `invalid JSON: ${error.message}`, index + 1); }
      const types = plain(record) ? ['event', 'meta', 'clear'].filter(key => Object.hasOwn(record, key)) : [];
      if (types.length !== 1 || !plain(record[types[0]])) throw legacyFailure('recording.jsonl', 'expected one event, meta, or clear object', index + 1);
      if (types[0] === 'event' && (!Number.isSafeInteger(record.event.seq) || record.event.seq < 1 ||
          ['sessionId', 'commandId', 'memoryRunId'].some(key => record.event[key] !== undefined && (typeof record.event[key] !== 'string' || !record.event[key])))) throw legacyFailure('recording.jsonl', 'event requires positive seq and nonempty string identities when present', index + 1);
      if (types[0] === 'clear' && (typeof record.clear.sessionId !== 'string' || !Number.isSafeInteger(record.clear.through) || record.clear.through < 0)) throw legacyFailure('recording.jsonl', 'clear requires sessionId and nonnegative through sequence', index + 1);
      if (types[0] === 'meta' && (record.meta.sessions !== undefined && (!Array.isArray(record.meta.sessions) || record.meta.sessions.some(pair =>
        !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !Number.isSafeInteger(pair[1]) || pair[1] < 0)) ||
        record.meta.cursor !== undefined && (!Number.isSafeInteger(record.meta.cursor) || record.meta.cursor < 0))) throw legacyFailure('recording.jsonl', 'invalid journal watermark metadata', index + 1);
      journal.push({ line: index + 1, type: types[0], record });
    }
  }
  const workflows = [];
  for (const name of ['workflow.json', 'workflows.json']) {
    if (!files.has(name)) continue;
    let value;
    try { value = JSON.parse(files.get(name).toString('utf8')); }
    catch (error) { throw legacyFailure(name, `invalid JSON: ${error.message}`); }
    const rows = name === 'workflow.json' ? [value] : Array.isArray(value) ? value : value?.workflows;
    if (!Array.isArray(rows) || rows.some(row => !plain(row))) throw legacyFailure(name, 'expected workflow objects');
    rows.forEach((workflow, index) => workflows.push({ file: name, index, workflow }));
  }
  return { saved, journal, workflows };
}

class Store {
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw fail('INVALID_STORAGE_INPUT', 'dataDir is required');
    this.directory = path.resolve(dataDir);
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, 'browser-ai.sqlite'));
    this.depth = 0;
    this.savepoint = 0;
    this.db.exec(`PRAGMA busy_timeout = 10000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS evidence (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        recordId TEXT NOT NULL UNIQUE, runId TEXT, executionId TEXT,
        kind TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_run_cursor ON evidence (runId, cursor);
      CREATE INDEX IF NOT EXISTS evidence_execution_cursor ON evidence (executionId, cursor);
      CREATE INDEX IF NOT EXISTS evidence_kind_cursor ON evidence (kind, cursor);`);
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw fail('INVALID_STORAGE_INPUT', 'transaction requires a function');
    const outer = this.depth === 0;
    const savepoint = `nested_${++this.savepoint}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw fail('ASYNC_TRANSACTION', 'Store transactions must be synchronous');
      this.db.exec(outer ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`); }
      catch (_) { /* Preserve the original transaction error. */ }
      if (!outer) { try { this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch (_) {} }
      throw error;
    } finally { this.depth--; }
  }

  get(kind, id) {
    identifier(kind, 'kind'); identifier(id, 'id');
    const row = this.db.prepare('SELECT json FROM entities WHERE kind = ? AND id = ?').get(kind, id);
    return row ? JSON.parse(row.json) : null;
  }

  put(kind, id, object) {
    identifier(kind, 'kind'); identifier(id, 'id');
    const value = jsonObject(object, 'entity');
    this.db.prepare('INSERT INTO entities (kind, id, json) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET json = excluded.json')
      .run(kind, id, JSON.stringify(value));
    return value;
  }

  list(kind) {
    identifier(kind, 'kind');
    return this.db.prepare('SELECT json FROM entities WHERE kind = ? ORDER BY id').all(kind).map(row => JSON.parse(row.json));
  }

  append(record) {
    const value = jsonObject(record, 'record');
    delete value.cursor;
    value.recordId = identifier(value.recordId === undefined ? crypto.randomUUID() : value.recordId, 'recordId');
    identifier(value.kind, 'kind');
    for (const key of ['runId', 'executionId']) if (value[key] !== undefined && value[key] !== null) identifier(value[key], key);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT cursor, json FROM evidence WHERE recordId = ?').get(value.recordId);
      if (previous) {
        if (canonical(JSON.parse(previous.json)) !== canonical(value)) throw fail('EVIDENCE_CONFLICT', 'recordId conflicts with existing evidence', { recordId: value.recordId });
        return { ...JSON.parse(previous.json), cursor: Number(previous.cursor) };
      }
      const result = this.db.prepare('INSERT INTO evidence (recordId, runId, executionId, kind, json) VALUES (?, ?, ?, ?, ?)')
        .run(value.recordId, value.runId ?? null, value.executionId ?? null, value.kind, JSON.stringify(value));
      return { ...value, cursor: Number(result.lastInsertRowid) };
    });
  }

  query({ runId, after = 0, limit = 50, kind, executionId } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('INVALID_STORAGE_INPUT', 'after must be nonnegative and limit must be 1..1000');
    const filters = ['cursor > ?'];
    const values = [after];
    for (const [column, value] of [['runId', runId], ['kind', kind], ['executionId', executionId]]) {
      if (value === undefined || value === null) continue;
      filters.push(`${column} = ?`); values.push(identifier(value, column));
    }
    const rows = this.db.prepare(`SELECT cursor, json FROM evidence WHERE ${filters.join(' AND ')} ORDER BY cursor LIMIT ?`).all(...values, limit + 1);
    const records = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.json), cursor: Number(row.cursor) }));
    return { records, nextCursor: records.at(-1)?.cursor ?? after, hasMore: rows.length > limit };
  }

  importLegacy(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw fail('INVALID_IMPORT_SOURCE', 'legacy directory is required');
    const sourceDirectory = path.resolve(directory);
    const files = new Map();
    for (const name of ['domain-memory.json', 'recording.jsonl', 'workflow.json', 'workflows.json']) {
      try { files.set(name, fs.readFileSync(path.join(sourceDirectory, name))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const counts = { memories: 0, legacyRuns: 0, legacyExecutions: 0, records: 0, drafts: 0 };
    if (!files.size) return { imported: false, fingerprint: null, sourceDirectory, counts, reason: 'NO_LEGACY_FILES' };
    const fingerprintHash = crypto.createHash('sha256');
    for (const [name, bytes] of files) fingerprintHash.update(`${name}\0${bytes.length}\0`).update(bytes);
    const fingerprint = fingerprintHash.digest('hex');
    const existing = this.get('import', fingerprint);
    if (existing) return { ...existing, imported: false, alreadyImported: true };
    const { saved, journal, workflows } = parseLegacy(files);
    const preservedDirectory = path.join(this.directory, 'imports', fingerprint);
    fs.mkdirSync(preservedDirectory, { recursive: true });
    for (const [name, bytes] of files) {
      const destination = path.join(preservedDirectory, name);
      try { fs.writeFileSync(destination, bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.readFileSync(destination).equals(bytes)) throw fail('IMPORT_SNAPSHOT_CONFLICT', 'Preserved legacy file differs from its fingerprint', { file: destination });
      }
    }
    return this.transaction(() => {
      const previous = this.get('import', fingerprint);
      if (previous) return { ...previous, imported: false, alreadyImported: true };
      const importedAt = new Date().toISOString();
      const provenance = { source: 'legacy-recorder', fingerprint, sourceDirectory, preservedDirectory, importedAt };
      const putNew = (kind, id, object) => {
        const old = this.get(kind, id);
        if (old && old.legacyProvenance?.fingerprint !== fingerprint) throw fail('LEGACY_ID_CONFLICT', `Existing ${kind} id ${id} belongs to another import or current data`, { kind, id });
        this.put(kind, id, object);
      };
      const rawCommands = new Set();
      for (const row of journal) {
        const event = row.record.event;
        if (event?.commandId) rawCommands.add(event.commandId);
        const legacyKind = event?.kind;
        const kind = !event ? 'incident' : event.type === 'dom-change' || event.type === 'domChange' || legacyKind === 'dom-change' ? 'dom' :
          legacyKind === 'net' || event.netType || event.requestId ? 'network' : 'execution';
        const context = event ? Object.fromEntries(['sessionId', 'tabId', 'frameId', 'documentId', 'cursor', 'seq'].filter(key => event[key] !== undefined).map(key => [key, event[key]])) : {};
        this.append({ recordId: legacyId(fingerprint, `recording:${row.line}`), runId: event?.memoryRunId ?? null,
          executionId: event?.commandId ?? null, kind, producerId: 'legacy-recorder',
          streamId: `legacy:${fingerprint}:${event?.sessionId || 'journal'}`, seq: event?.seq ?? row.line,
          observedAt: event?.t ?? null, receivedAt: importedAt, source: 'legacy-import',
          legacyContext: context, payload: row.record, legacyProvenance: { ...provenance, file: 'recording.jsonl', line: row.line },
          gaps: [{ kind: 'historical-capture', message: 'Imported journal is a retained historical fragment; completeness and current browser state are unverified.' }] });
        counts.records++;
      }
      for (const run of saved.runs) {
        const unfinished = ['active', 'needs-verification', 'needs_verification'].includes(run.status) || run.commands.some(command => ['pending', 'outcomeUnknown', 'outcome_unknown'].includes(command.status));
        const imported = { ...run, id: run.memoryRunId, runId: run.memoryRunId,
          status: unfinished ? 'needs_verification' : run.status, state: unfinished ? 'needs_verification' : run.status,
          legacyProvenance: { ...provenance, originalStatus: run.status }, verificationScope: 'legacy', automaticResume: false };
        imported.commands = run.commands.map(command => ({ ...command, ...(command.status === 'pending' ? { status: 'outcomeUnknown', code: 'LEGACY_INTERRUPTED' } : {}) }));
        putNew('legacyRun', run.memoryRunId, imported); counts.legacyRuns++;
        for (const [index, command] of run.commands.entries()) {
          const ref = `run:${run.memoryRunId}/command:${command.commandId}`;
          const observationAvailable = Object.hasOwn(command, 'observed');
          const available = observationAvailable || rawCommands.has(command.commandId);
          const execution = { ...command, id: command.commandId, executionId: command.commandId, runId: run.memoryRunId,
            sequence: command.sequence ?? index + 1, ...(command.status === 'pending' ? { status: 'outcomeUnknown', code: 'LEGACY_INTERRUPTED' } : {}),
            legacyReference: ref, legacyProvenance: { ...provenance, originalStatus: command.status }, verificationScope: 'legacy',
            evidenceAvailability: { available, observationAvailable, rawRecordingAvailable: rawCommands.has(command.commandId),
              ...(available ? {} : { reason: 'Historical observation and raw recording were not retained; command metadata only.' }) } };
          const oldExecution = this.get('legacyExecution', command.commandId);
          if (oldExecution && oldExecution.runId !== run.memoryRunId) throw fail('LEGACY_ID_CONFLICT', 'Legacy command id belongs to multiple runs', { executionId: command.commandId });
          putNew('legacyExecution', command.commandId, execution);
          putNew('legacyReference', ref, { id: ref, runId: run.memoryRunId, executionId: command.commandId, available,
            observationAvailable, legacyProvenance: provenance, ...(available ? {} : { reason: execution.evidenceAvailability.reason }) });
          counts.legacyExecutions++;
        }
      }
      for (const entry of saved.entries) {
        const refs = entry.evidence || [];
        const available = [], unavailable = [];
        for (const ref of refs) {
          const resolved = typeof ref === 'string' ? this.get('legacyReference', ref) : null;
          if (resolved?.available) available.push(ref);
          else unavailable.push({ ref, reason: resolved?.reason || 'Historical evidence reference is unavailable in the imported files.' });
        }
        putNew('memory', entry.id, { ...entry, id: entry.id, revision: entry.revision ?? 0,
          legacyProvenance: provenance, verificationScope: 'legacy',
          evidenceAvailability: { state: available.length ? unavailable.length ? 'partial' : 'available' : 'unavailable', available, unavailable,
            ...(!refs.length ? { reason: 'No historical evidence references were retained.' } : {}) } });
        counts.memories++;
        if (entry.workflow !== undefined) {
          const id = legacyId(fingerprint, `memory-workflow:${entry.id}`);
          putNew('draft', id, { id, memoryId: entry.id, state: 'draft', verification: 'unverified',
            recipe: entry.recipe || {}, legacyWorkflow: entry.workflow, legacyProvenance: provenance,
            unresolved: ['Legacy selectors, parameters, and waits require fresh ego observations; this draft cannot be executed directly.'] });
          counts.drafts++;
        }
      }
      for (const row of workflows) {
        const id = typeof row.workflow.id === 'string' && row.workflow.id ? row.workflow.id : legacyId(fingerprint, `${row.file}:${row.index}`);
        putNew('draft', id, { id, state: 'draft', verification: 'unverified', legacyWorkflow: row.workflow,
          legacyProvenance: { ...provenance, file: row.file, index: row.index },
          unresolved: ['Legacy workflow is historical evidence; bind fresh ego targets and verify before use.'] });
        counts.drafts++;
      }
      const manifest = { imported: true, fingerprint, sourceDirectory, preservedDirectory, importedAt,
        files: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })), counts,
        gaps: [{ kind: 'legacy-verification', message: 'Imported verification labels apply to historical Recorder runs, not a new ego verification.' }] };
      this.put('import', fingerprint, manifest);
      const manifestPath = path.join(preservedDirectory, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return manifest;
    });
  }

  close() { this.db.close(); }
}

module.exports = { Store };
