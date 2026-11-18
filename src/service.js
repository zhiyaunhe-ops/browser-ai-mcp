'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const { Store } = require('./storage');
const { Memory } = require('./memory');
const { EgoAdapter } = require('./ego');
const { MEMO_SHORT } = require('./memo');
const { assertProgram } = require('./program-contract');

const problem = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const json = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const finishBody = args => ({ outcome: args.outcome, decision: args.decision, note: args.note,
  verification: args.verification || [], usedMemoryIds: args.usedMemoryIds || [],
  updates: args.updates || [], keepPages: args.keepPages || [] });
function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw problem('INVALID_ARGUMENT', `${field} is required`);
  return value;
}
function small(value, limit = 14000) {
  const text = JSON.stringify(value);
  return text && text.length > limit ? { truncated: true, preview: text.slice(0, limit) } : value;
}
function valueAt(value, field) {
  for (const key of field ? field.split('.') : []) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false };
    value = value[key];
  }
  return { found: value !== undefined, value };
}

// Recovery is an instruction for the next observation, never an automatic replay.
function recoveryFor(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`;
  if (!error) return null;
  if (/unknown ref|stale ref/i.test(text)) return { kind: 'refresh-snapshot',
    next: 'Take a fresh page.snapshot() on the observed Page; choose refs from that snapshot before acting.' };
  if (/page.*label.*not found|no page.*label|page.*not found/i.test(text)) return { kind: 'inspect-pages',
    next: 'Read await task.pages() and await task.tabs(); use an observed label or adopt the intended unmanaged tab.' };
  if (/task space.*not found|TASK_SPACE_(NOT_FOUND|UNAVAILABLE|INACTIVE)|target.*closed|inspected target/i.test(text)) return { kind: 'inspect-space',
    next: 'Inspect current Space and Page ownership and saved execution outcome before explicitly reconnecting. Do not replay a business write.' };
  if (/timeout|timed.out|unresponsive/i.test(text)) return { kind: 'observe-current-state',
    next: 'Query run_get first. Once executionStopped is confirmed, observe the current URL and business state before deciding whether another action is needed.' };
  return null;
}

class BrowserService {
  constructor(options = {}) {
    this.store = options.store || new Store(options.dataDir || process.env.BROWSER_AI_DATA_DIR || path.join(os.homedir(), '.browser-ai'));
    this.memory = new Memory(this.store);
    this.ego = options.egoAdapter || new EgoAdapter();
    this.clock = options.clock || Date.now;
    this.id = options.idFactory || crypto.randomUUID;
    this.waitMs = options.waitMs ?? 100;
    this.ownerId = crypto.randomUUID();
    this.pending = new Map();
    this.closed = false;
  }

  now() { return this.clock(); }
  run(id) {
    const run = this.store.get('run', required(id, 'runId'));
    if (!run) throw problem('RUN_NOT_FOUND', 'Unknown runId');
    return run;
  }
  request(tool, runId, args) {
    required(args.requestId, 'requestId');
    const key = `${tool}:${runId || ''}:${args.requestId}`;
    const hash = fingerprint(args);
    const previous = this.store.get('request', key);
    if (previous && previous.hash !== hash) throw problem('REQUEST_CONFLICT', 'requestId already has a different payload');
    return { key, hash, previous };
  }
  saveRequest(request, result) {
    this.store.put('request', request.key, { id: request.key, hash: request.hash, ...result });
  }
  record(runId, executionId, kind, payload) {
    return this.store.append({ recordId: this.id(), runId, executionId: executionId || null,
      kind, producerId: 'browser-ai-mcp', streamId: runId, source: 'mcp',
      observedAt: this.now(), receivedAt: this.now(), payload });
  }

  begin(args) {
    return this.store.transaction(() => {
      const request = this.request('run_begin', null, args);
      if (request.previous) return Object.assign(this.run(request.previous.runId), { memo: MEMO_SHORT });
      required(args.goal, 'goal');
      const url = new URL(required(args.url, 'url'));
      if (!['http:', 'https:'].includes(url.protocol)) throw problem('INVALID_ARGUMENT', 'url must use HTTP(S)');
      const criteria = args.criteria || [];
      if (!Array.isArray(criteria) || criteria.some(c => !c || typeof c.id !== 'string' || typeof c.path !== 'string' || !Object.hasOwn(c, 'equals')) ||
        new Set(criteria.map(c => c.id)).size !== criteria.length) throw problem('INVALID_ARGUMENT', 'criteria require unique id, path and equals');
      const recalledMemory = this.memory.search({ url: url.href, goal: args.goal });
      for (const memoryId of args.recipeIds || []) this.memory.get(memoryId);
      const runId = this.id();
      const run = { runId, goal: args.goal, url: url.href, criteria: json(criteria),
        state: 'active', createdAt: this.now(), updatedAt: this.now(), sequence: 0,
        spaceId: null, pageLabel: 'p1', name: `browser-ai:${runId}`,
        recalledMemory, cleanup: { state: 'not_requested' } };
      this.store.put('run', runId, run);
      this.saveRequest(request, { runId });
      this.record(runId, null, 'incident', { type: 'run-begin', goal: run.goal });
      return Object.assign(run, { memo: MEMO_SHORT });
    });
  }

  executions(runId) { return this.store.list('execution').filter(e => e.runId === runId).sort((a, b) => a.sequence - b.sequence); }
  async refresh(runId) {
    const executions = this.executions(runId);
    for (const execution of executions) {
      if (!['queued', 'running', 'outcome_unknown'].includes(execution.state) || this.pending.has(execution.executionId)) continue;
      if (execution.state === 'queued') {
        let ownerAlive = false;
        if (execution.ownerPid) try { process.kill(execution.ownerPid, 0); ownerAlive = true; } catch { /* owner exited */ }
        if (!ownerAlive) this.complete(execution.executionId, { state: 'failed', executionStopped: true,
          error: { code: 'DISPATCH_NOT_STARTED', message: 'The owner exited before claiming this queued execution', executionStarted: false } });
        continue;
      }
      if (!this.ego.recover) continue;
      const result = await this.ego.recover(execution);
      if (result && result.state !== 'running') this.complete(execution.executionId, result);
      else if (result?.spaceId) this.store.transaction(() => {
        const run = this.run(runId); run.spaceId = result.spaceId; this.store.put('run', runId, run);
      });
    }
    let run = this.run(runId);
    if (run.cleanup.state === 'pending') this.launchCleanup(run);
    else if (['running', 'outcome_unknown'].includes(run.cleanup.state) && !this.pending.has(run.cleanup.executionId) && this.ego.recover) {
      const result = await this.ego.recover(run.cleanup);
      if (result && result.state !== 'running') this.completeCleanup(runId, result);
    }
    return this.run(runId);
  }

  async browserRun(args) {
    await this.refresh(args.runId);
    const execution = this.store.transaction(() => {
      const request = this.request('browser_run', args.runId, args);
      if (request.previous) return this.store.get('execution', request.previous.executionId);
      const run = this.run(args.runId);
      if (run.feedback && run.feedback.outcome !== 'unknown' || !['active', 'needs_verification', 'awaiting_user'].includes(run.state)) throw problem('RUN_CLOSED', 'This run is already finishing or closed');
      if (run.state === 'awaiting_user' && !args.resumeAfterUserAction) throw problem('USER_ACTION_REQUIRED', 'Complete the requested browser action, then resumeAfterUserAction after user confirmation');
      required(args.code, 'code');
      if (!['execute', 'observe'].includes(args.purpose)) throw problem('INVALID_ARGUMENT', 'purpose must be execute or observe');
      if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 120000)) throw problem('INVALID_ARGUMENT', 'timeoutMs must be between 1000 and 120000');
      const previous = this.executions(run.runId);
      if (previous.some(e => ['queued', 'running'].includes(e.state))) throw problem('RUN_BUSY', 'An execution is already running; query run_get');
      for (const resolution of args.resolutions || []) {
        const execution = previous.find(e => e.executionId === resolution.executionId);
        const observation = this.store.get('observation', resolution.observationId);
        if (!execution || execution.state !== 'outcome_unknown' || !execution.executionStopped ||
          !observation || observation.runId !== run.runId || observation.sequence <= execution.sequence) throw problem('INVALID_RESOLUTION', 'Resolve a stopped unknown execution using a later same-run observation');
        required(resolution.note, 'resolution.note');
        const value = { observationId: resolution.observationId, note: resolution.note };
        if (execution.resolution && !isDeepStrictEqual(execution.resolution, value)) throw problem('REQUEST_CONFLICT', 'The unknown execution already has a different resolution');
        execution.resolution = value;
        this.store.put('execution', execution.executionId, execution);
        this.record(run.runId, execution.executionId, 'incident', { type: 'outcome-resolution', ...value });
      }
      const unknown = previous.filter(e => e.state === 'outcome_unknown' && !e.resolution);
      if (unknown.some(e => !e.executionStopped) || unknown.length && args.purpose !== 'observe') throw problem('OUTCOME_UNKNOWN', 'Resolve the prior execution before another write; query run_get and capture a later observation once stopped');
      // Reject definite SDK/context mistakes before dispatch or write sequencing.
      // Request deduplication above still returns an existing invocation unchanged.
      const programCheck = assertProgram(args.code);
      const executionId = this.id();
      const execution = { executionId, runId: run.runId, requestId: args.requestId, state: 'queued',
        sequence: ++run.sequence, purpose: args.purpose, code: args.code, args: args.args ?? null,
        timeoutMs: args.timeoutMs || 30000, spaceId: run.spaceId, name: run.name,
        pageLabel: args.pageLabel || run.pageLabel, resumeAfterUserAction: args.resumeAfterUserAction === true,
        memo: args.memo !== false,
        programWarnings: programCheck.warnings,
        directory: path.join(this.store.directory, 'executions', executionId),
        ownerId: this.ownerId, ownerPid: process.pid, startedAt: this.now(), executionStopped: false };
      if (args.purpose === 'execute') run.lastWriteSequence = execution.sequence;
      run.state = 'active'; run.updatedAt = this.now();
      this.store.put('run', run.runId, run);
      this.store.put('execution', executionId, execution);
      this.saveRequest(request, { runId: run.runId, executionId });
      this.record(run.runId, executionId, 'execution', { phase: 'intent', sequence: execution.sequence, purpose: execution.purpose });
      return execution;
    });
    if (execution.state === 'queued' && execution.ownerId === this.ownerId && !this.pending.has(execution.executionId)) this.launchExecution(execution);
    await this.wait(this.pending.get(execution.executionId));
    return this.executionView(this.store.get('execution', execution.executionId));
  }

  launchExecution(execution) {
    const claimed = this.store.transaction(() => {
      const current = this.store.get('execution', execution.executionId);
      if (current.state !== 'queued' || current.ownerId !== this.ownerId) return false;
      current.state = 'running'; this.store.put('execution', current.executionId, current);
      return true;
    });
    if (!claimed) return;
    const pending = (async () => {
      let result;
      try { result = await this.ego.run(execution); }
      catch (error) { result = { state: 'outcome_unknown', executionStopped: false,
        error: { code: error.code || 'EGO_ADAPTER_FAILED', message: error.message } }; }
      if (!this.closed) this.complete(execution.executionId, result);
    })().finally(() => this.pending.delete(execution.executionId));
    this.pending.set(execution.executionId, pending);
    pending.catch(error => process.stderr.write(`Execution persistence failed: ${error.message}\n`));
  }

  complete(executionId, result) {
    return this.store.transaction(() => {
      const execution = this.store.get('execution', executionId);
      if (!execution || ['succeeded', 'failed'].includes(execution.state)) return;
      if (!result || !['succeeded', 'failed', 'outcome_unknown'].includes(result.state)) throw problem('EGO_RESULT_INVALID', 'Adapter returned an invalid execution state');
      if (execution.state === 'outcome_unknown' && result.state === execution.state &&
        execution.executionStopped === (result.executionStopped === true) &&
        isDeepStrictEqual(execution.error, result.error || null) &&
        (result.spaceId == null || result.spaceId === execution.spaceId) &&
        isDeepStrictEqual(execution.observationTrace ?? null, result.observationTrace ?? null)) return;
      const run = this.run(execution.runId);
      Object.assign(execution, { state: result.state, result: result.result ?? null,
        error: result.error || null, executionStopped: result.executionStopped === true,
        memoStats: typeof result.memo === 'string' ? result.memo : null,
        observationTrace: result.observationTrace ?? null,
        recovery: recoveryFor(result.error),
        finishedAt: this.now() });
      if (result.spaceId != null) { execution.spaceId = result.spaceId; run.spaceId = result.spaceId; }
      if (result.state === 'succeeded' && execution.purpose === 'observe' && !execution.observationId) {
        const observationId = this.id();
        execution.observationId = observationId;
        const observation = { observationId, runId: run.runId, executionId,
          sequence: execution.sequence, observedAt: this.now(), value: result.result ?? null };
        this.store.put('observation', observationId, observation);
        this.record(run.runId, executionId, 'observation', observation);
      }
      if (Array.isArray(result.result?.evidence)) for (const item of result.result.evidence) {
        if (item && ['network', 'dom'].includes(item.kind)) this.record(run.runId, executionId, item.kind, item.payload || item);
      }
      if (result.state === 'outcome_unknown') run.state = 'needs_verification';
      if (/USER_IN_CONTROL|TASK_SPACE_INACTIVE|TASK_SPACE_UNAVAILABLE/.test(result.error?.code || '')) run.state = 'awaiting_user';
      run.updatedAt = this.now();
      this.store.put('execution', executionId, execution);
      this.store.put('run', run.runId, run);
      this.record(run.runId, executionId, 'execution', { phase: 'result', state: execution.state,
        sequence: execution.sequence, observationId: execution.observationId, error: execution.error });
      return execution;
    });
  }

  executionView(execution) {
    const { code, args, result, ...view } = execution;
    return { ...view, result: small(result), resultArtifact: path.join(execution.directory, 'result.json') };
  }
  async wait(pending) {
    if (!pending || this.waitMs <= 0) return;
    let timer;
    await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, this.waitMs); })]);
    clearTimeout(timer);
  }
  async get(args) {
    const run = await this.refresh(args.runId);
    let executions = this.executions(run.runId);
    const executionCount = executions.length;
    if (args.executionId) {
      executions = executions.filter(e => e.executionId === args.executionId);
      if (!executions.length) throw problem('EXECUTION_NOT_FOUND', 'Execution does not belong to this run');
    } else executions = executions.slice(-(args.limit || 30));
    const records = this.store.query({ runId: run.runId, after: args.cursor || 0, limit: args.limit || 30 });
    const { finishArguments, ...publicRun } = run;
    return { ...publicRun, executionCount, executions: executions.map(e => this.executionView(e)),
      ...records, records: records.records.map(r => ({ ...r, payload: small(r.payload) })), gaps: this.gaps(run.runId) };
  }

  async finish(args) {
    await this.refresh(args.runId);
    const run = this.store.transaction(() => {
      const request = this.request('run_finish', args.runId, args);
      if (request.previous) return this.run(args.runId);
      const run = this.run(args.runId);
      if (run.feedback && run.feedback.outcome !== 'unknown') {
        if (!args.retryCleanup || !isDeepStrictEqual(finishBody(args), run.finishArguments)) throw problem('RUN_CLOSED', 'Feedback is frozen; only a matching explicit cleanup retry can follow');
        // A cleanup whose recorded error provably had no effects may be replayed even
        // when the runtime was asked for a finish: the request was refused outright.
        const replayable = run.cleanup.finishDispatched === false || run.cleanup.error?.mayHaveLateEffects !== true;
        if (run.cleanup.state !== 'failed' || !run.cleanup.executionStopped || !replayable) throw problem('CLEANUP_OUTCOME_UNKNOWN', 'Cleanup may already have been dispatched; inspect the original result instead of repeating finish');
        const executionId = this.id();
        const { attempts, ...previous } = run.cleanup;
        run.cleanup = { executionId, runId: run.runId, spaceId: run.spaceId, name: run.name,
          state: 'pending', keep: args.keepPages || [], directory: path.join(this.store.directory, 'executions', executionId),
          requestedAt: this.now(), executionStopped: false, attempts: [...(attempts || []), previous] };
        run.state = 'finishing';
        this.store.put('run', run.runId, run);
        this.saveRequest(request, { runId: run.runId });
        this.record(run.runId, null, 'incident', { type: 'cleanup-retry', previousExecutionId: previous.executionId });
        return run;
      }
      if (!['succeeded', 'failed', 'unknown', 'cancelled'].includes(args.outcome)) throw problem('INVALID_ARGUMENT', 'Invalid outcome');
      if (!['confirmed', 'corrected', 'learned', 'no-change'].includes(args.decision)) throw problem('INVALID_ARGUMENT', 'Invalid memory decision');
      required(args.note, 'note');
      const executions = this.executions(run.runId);
      if (executions.some(e => ['queued', 'running'].includes(e.state)) || executions.some(e => e.state === 'outcome_unknown' && !e.executionStopped)) throw problem('RUN_BUSY', 'An execution has not been confirmed stopped');
      const verification = args.verification || [];
      const evidenceIds = [];
      if (args.outcome === 'succeeded') {
        if (!run.criteria.length) throw problem('VERIFICATION_REQUIRED', 'Successful completion requires declared criteria');
        for (const criterion of run.criteria) {
          const reference = verification.find(v => v.criterionId === criterion.id);
          const observation = reference && this.store.get('observation', reference.observationId);
          if (!observation || observation.runId !== run.runId || observation.sequence <= (run.lastWriteSequence || 0)) throw problem('VERIFICATION_REQUIRED', 'Provide an independent observation after the last execute round for each criterion');
          const observed = valueAt(observation.value, criterion.path);
          if (!observed.found || !isDeepStrictEqual(observed.value, criterion.equals)) throw problem('VERIFICATION_FAILED', `Observed value does not satisfy ${criterion.id}`);
          evidenceIds.push(observation.observationId);
        }
      } else if (args.outcome !== 'unknown') evidenceIds.push(...executions.map(e => e.executionId));
      const used = args.usedMemoryIds || [];
      const recalled = [...(run.recalledMemory.domainRules || []), ...(run.recalledMemory.matches || [])].map(m => m.id);
      for (const id of used) {
        const memory = this.memory.get(id);
        if (memory.domain !== new URL(run.url).hostname) throw problem('INVALID_MEMORY', 'Used memory must match the task domain');
      }
      if (args.decision === 'confirmed' && !used.length) throw problem('INVALID_MEMORY', 'confirmed requires usedMemoryIds');
      const updates = args.updates || [];
      if (['corrected', 'learned'].includes(args.decision) !== (updates.length > 0)) throw problem('INVALID_MEMORY', 'learned/corrected require updates; confirmed/no-change do not accept them');
      for (const update of updates) if (update.memoryId && !used.includes(update.memoryId)) throw problem('INVALID_MEMORY', 'Corrections must identify the used memory');
      const changedMemoryIds = this.memory.applyUpdates(run, updates, evidenceIds, args.outcome);
      if (run.feedback) run.feedbackHistory = [...(run.feedbackHistory || []), run.feedback];
      run.feedback = { requestId: args.requestId, outcome: args.outcome, decision: args.decision,
        verification, note: args.note, usedMemoryIds: used, recalledMemoryIds: recalled,
        changedMemoryIds, resolvedUnknownExecutions: args.outcome === 'succeeded' ? executions.filter(e => e.state === 'outcome_unknown').map(e => e.executionId) : [],
        submittedAt: this.now() };
      run.outcome = args.outcome;
      run.finishArguments = finishBody(args);
      if (args.outcome === 'unknown') {
        run.state = 'needs_verification'; run.cleanup = { state: 'not_requested' };
      } else if (run.spaceId == null) {
        run.state = args.outcome === 'succeeded' ? 'completed' : args.outcome;
        run.cleanup = { state: 'not_needed' };
      } else {
        run.state = 'finishing';
        const executionId = this.id();
        run.cleanup = { executionId, runId: run.runId, spaceId: run.spaceId, name: run.name,
          state: 'pending', keep: args.keepPages || [], directory: path.join(this.store.directory, 'executions', executionId),
          requestedAt: this.now(), executionStopped: false };
      }
      run.updatedAt = this.now();
      this.store.put('run', run.runId, run);
      this.saveRequest(request, { runId: run.runId });
      this.record(run.runId, null, 'incident', { type: 'run-feedback', ...run.feedback });
      return run;
    });
    if (run.cleanup.state === 'pending') this.launchCleanup(run);
    await this.wait(this.pending.get(this.run(run.runId).cleanup.executionId));
    return this.get({ runId: run.runId });
  }

  launchCleanup(run) {
    const cleanup = this.store.transaction(() => {
      const current = this.run(run.runId);
      if (current.cleanup.state !== 'pending') return null;
      current.cleanup.state = 'running'; current.cleanup.ownerId = this.ownerId;
      current.cleanup.dispatchedAt = this.now();
      this.store.put('run', run.runId, current);
      return current.cleanup;
    });
    if (!cleanup) return;
    const pending = (async () => {
      let result;
      try { result = await this.ego.finish(cleanup); }
      catch (error) { result = { state: 'outcome_unknown', executionStopped: false,
        error: { code: error.code || 'EGO_CLEANUP_FAILED', message: error.message } }; }
      if (!this.closed) this.completeCleanup(run.runId, result);
    })().finally(() => this.pending.delete(cleanup.executionId));
    this.pending.set(cleanup.executionId, pending);
    pending.catch(error => process.stderr.write(`Cleanup persistence failed: ${error.message}\n`));
  }
  completeCleanup(runId, result) {
    this.store.transaction(() => {
      const run = this.run(runId);
      if (run.cleanup.state === 'succeeded') return;
      Object.assign(run.cleanup, { state: result.state, error: result.error || null,
        executionStopped: result.executionStopped === true, finishDispatched: result.finishDispatched,
        finishedAt: this.now() });
      // 'skipped' is a settled cleanup: the space was already gone, or the user now owns
      // it, so there is nothing left to clean up and nothing left to verify.
      if (result.state === 'succeeded' || result.state === 'skipped') run.state = run.outcome === 'succeeded' ? 'completed' : run.outcome;
      else run.state = 'needs_verification';
      this.store.put('run', runId, run);
      this.record(runId, run.cleanup.executionId, 'incident', { type: 'space-cleanup', state: result.state, error: result.error });
    });
  }

  searchMemory(args) { return this.memory.search(args); }
  getMemory(args) { return this.memory.get(args.memoryId); }
  gaps(runId) {
    const network = this.store.query({ runId, kind: 'network', limit: 1 }).records;
    return [{ kind: 'per-action-not-captured', message: 'Executions record script rounds, not every inner click' },
      { kind: 'human-actions-not-captured' },
      ...(!network.length ? [{ kind: 'network-not-captured' }] : [{ kind: 'network-partial', message: 'Only explicitly returned network evidence was captured' }])];
  }
  queryEvidence(args) {
    this.run(args.runId);
    if (args.view && !['records', 'trace', 'api'].includes(args.view)) throw problem('INVALID_ARGUMENT', 'view must be records, trace or api');
    const page = this.store.query({ runId: args.runId, after: args.cursor || 0, limit: args.limit || 30, executionId: args.executionId });
    const records = page.records.map(r => ({ ...r, payload: small(r.payload) }));
    if (!args.view || args.view === 'records') return { ...page, records, gaps: this.gaps(args.runId) };
    // Correlation and endpoint inference operate only on explicit observations.
    const { buildTrace, discoverAPI } = require('./trace-engine');
    const rows = page.records.filter(r => ['network', 'dom'].includes(r.kind) || r.kind === 'execution' && r.payload.phase === 'intent').map(r => ({ ...r.payload,
      eventId: r.recordId, cursor: r.cursor, kind: r.kind === 'network' ? 'net' : 'user',
      ...(r.kind === 'dom' ? { type: 'dom-change' } : {}),
      ...(r.kind === 'execution' ? { type: 'action-start', action: 'script-round', actor: 'agent' } : {}),
      sessionId: r.runId, commandId: r.executionId, seq: r.cursor, t: r.payload.t ?? r.observedAt }));
    return { ...page, records, projection: args.view === 'api' ? discoverAPI(rows) : buildTrace(rows),
      gaps: [...this.gaps(args.runId), ...((args.cursor || page.hasMore) ? [{ kind: 'projection-window', message: 'This projection covers one evidence page; related records may be on another page' }] : [])] };
  }
  draftRecipe(args) {
    return this.store.transaction(() => {
      const request = this.request('recipe_draft', args.runId, args);
      if (request.previous) return this.store.get('draft', request.previous.draftId);
      const run = this.run(args.runId);
      required(args.name, 'name');
      const executions = this.executions(run.runId);
      const draftId = this.id();
      const recipe = args.proposedRecipe || { goal: run.goal, parameters: {}, preconditions: [],
        steps: executions.filter(e => e.purpose === 'execute').map(e => ({ intent: 'Review recorded script intent', executionId: e.executionId })),
        verify: run.criteria, traps: [] };
      const draft = { draftId, runId: run.runId, name: args.name, state: 'draft', recipe: json(recipe),
        evidence: executions.map(e => e.observationId).filter(Boolean),
        unresolved: ['Review step intent and parameters; a draft is not verified knowledge'], createdAt: this.now() };
      this.store.put('draft', draftId, draft);
      this.saveRequest(request, { runId: run.runId, draftId });
      return draft;
    });
  }
  close() { this.closed = true; this.store.close(); }
}

function createService(options) { return new BrowserService(options); }
module.exports = { BrowserService, createService, problem };
