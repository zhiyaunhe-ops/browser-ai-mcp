'use strict';

const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { applyArtifact } = require('./improvement-artifacts');

const text = z.string().trim().min(1);
const states = z.enum(['planned', 'applied', 'verified']);
const proposal = z.object({ kind: z.enum(['code', 'script', 'memory', 'request']), problemId: text,
  change: text, criterion: z.object({ id: text, path: z.string(), equals: z.unknown() }) });
const link = z.object({ improvementId: text, version: text });
const instructions = {
  code: 'Edit the affected code and add a regression case in the authorized repository. Commit the change and supply the changed file to review_apply.',
  script: 'Create or revise the reusable script and its invocation example. Commit it and supply the script file to review_apply.',
  memory: 'Use review_apply with a memoryUpdate containing entry or memoryId and patch, plus baseRevision. Check the saved revision with memory_get.',
  request: 'Inspect the original captured request and response using evidence_query. Implement the parameterized request builder and independent result check, commit the builder, then supply its changed file and captured request evidenceId to review_apply.'
};
const fail = message => Object.assign(new Error(message), { code: 'IMPROVEMENT_INVALID' });

function getItem(service, id) {
  const item = service.store.get('improvement', id);
  if (!item) throw fail('Unknown improvementId.');
  return item;
}

function plan(service, args) {
  return service.store.transaction(() => {
    const request = service.request('review_improve', args.reviewId, args);
    if (request.previous) return getItem(service, request.previous.improvementId);
    const review = service.store.get('evaluation', args.reviewId);
    if (!review) throw fail('Submit the source evaluation before planning its improvement.');
    if (review.memory && review.memory.problem_id !== args.problemId) throw fail('Use the problem_id of the source evaluation.');
    if (!Object.hasOwn(args.criterion, 'equals')) throw fail('Specify the expected value in criterion.equals.');
    const item = { improvementId: service.id(), reviewId: review.reviewId, runId: review.runId,
      problemId: args.problemId, kind: args.kind, change: args.change, criterion: args.criterion,
      state: 'planned', createdAt: service.now(), deliveries: [], attempts: [], nextAction: instructions[args.kind] };
    if (item.kind === 'request') item.requestEvidence = service.recipeRequestEvidence(item.runId);
    service.store.put('improvement', item.improvementId, item);
    service.saveRequest(request, { improvementId: item.improvementId });
    return item;
  });
}

function apply(service, args) {
  return service.store.transaction(() => {
    const request = service.request('review_apply', args.improvementId, args);
    const item = getItem(service, args.improvementId);
    if (request.previous) return item;
    if (item.state === 'verified') throw fail('Plan a new change for further work on a verified improvement.');
    if (item.artifact && args.expectedVersion !== item.artifact.version) {
      throw fail('Supply expectedVersion matching the current delivery before replacing it.');
    }
    const artifact = applyArtifact(service, item, args.artifact);
    item.artifact = artifact;
    item.deliveries.push({ artifact, appliedAt: service.now() });
    item.state = 'applied';
    item.nextAction = 'Start a fresh run with improvementId, version and the planned criterion. Exercise the delivered change and independently read back the result. For memory cite the used memory ID at finish; for file changes return improvementVersion from the installed or loaded artifact alongside the business value.';
    service.store.put('improvement', item.improvementId, item);
    service.saveRequest(request, { improvementId: item.improvementId });
    return item;
  });
}

function bindImprovement(service, args, domainTag) {
  const ref = args.improvement;
  if (!ref) return {};
  const item = getItem(service, ref.improvementId);
  if (item.state !== 'applied' || ref.version !== item.artifact.version) throw fail('Start verification with the current applied version.');
  if (service.run(item.runId).domain_tag !== domainTag) throw fail('Verify the source product edition.');
  if (!args.criteria.some(c => isDeepStrictEqual(c, item.criterion))) throw fail('Include the planned criterion unchanged in this verification run.');
  if (item.kind === 'memory' && service.getMemory({ memoryId: item.artifact.memoryId }).revision !== item.artifact.revision) {
    throw fail('The memory revision has changed since delivery.');
  }
  return { improvement: { ...ref, delivery: item.deliveries.length } };
}

function matchingRequest(service, runId, expected) {
  let cursor = 0;
  while (true) {
    const page = service.store.query({ runId, after: cursor, kind: 'network', limit: 500 });
    const match = page.records.find(record => {
      const actual = record.payload;
      return record.captureSource === 'ego-page' && actual.netType === 'request' &&
        actual.method === expected.method && actual.url === expected.url &&
        isDeepStrictEqual([...(actual.queryKeys || [])].sort(), [...(expected.queryKeys || [])].sort());
    });
    if (match) return match.recordId;
    if (!page.hasMore) return null;
    cursor = page.nextCursor;
  }
}

function recordVerification(service, run, review) {
  if (!run.improvement) return;
  const item = getItem(service, run.improvement.improvementId);
  const artifact = item.deliveries[run.improvement.delivery - 1].artifact;
  const result = review.criterionResults.find(r => r.criterionId === item.criterion.id);
  const readback = service.criterionReadbacks(run).find(r => r.criterionId === item.criterion.id);
  const observed = readback?.observationId && service.store.get('observation', readback.observationId);
  const cited = observed && result?.evidenceIds.some(id => {
    if (id === observed.observationId) return true;
    const record = service.store.evidenceById(id, run.runId);
    return record?.kind === 'observation' && record.payload.observationId === observed.observationId;
  });
  const requestRecordId = item.kind === 'request' && matchingRequest(service, run.runId, artifact.request);
  const exposed = item.kind === 'memory' ? run.feedback.usedMemoryIds.includes(artifact.memoryId) &&
    service.getMemory({ memoryId: artifact.memoryId }).revision === artifact.revision :
    observed?.value?.improvementVersion === artifact.version;
  const gaps = [];
  if (run.improvement.delivery !== item.deliveries.length) gaps.push('delivery_replaced');
  if (run.outcome !== 'succeeded' || review.verdict !== 'pass') gaps.push('run_or_review_not_passed');
  if (result?.verdict !== 'met' || !cited || !readback?.afterLastWrite || !readback?.matchesExpected) {
    gaps.push('missing_matching_independent_readback');
  }
  if (!exposed) gaps.push('version_not_observed');
  if (item.kind === 'request' && !requestRecordId) gaps.push('matching_request_not_captured');
  const accepted = gaps.length === 0;
  item.attempts.push({ runId: run.runId, reviewId: review.reviewId, version: artifact.version, delivery: run.improvement.delivery,
    verdict: review.verdict, ...(requestRecordId ? { requestRecordId } : {}), exposureConfirmed: Boolean(exposed), accepted, gaps, observationId: readback?.observationId ?? null });
  if (accepted) {
    item.state = 'verified';
    item.nextAction = 'Deliver the reusable change by PR and include its version, source review and verification run. Use review_observe to measure later cases.';
  }
  service.store.put('improvement', item.improvementId, item);
  return { improvementId: item.improvementId, state: item.state, accepted, gaps, nextAction: item.nextAction };
}

function registerImprovementTools(register, service) {
  register('review_improve', 'Plan one concrete improvement from a submitted local review. Track separate changes independently; keep the source problem ID and define an observable acceptance criterion.', {
    reviewId: text, requestId: text, ...proposal.shape
  }, args => plan(service, args));
  register('review_apply', 'Apply a memory revision or validate a committed code, script or request-builder file. Request builders need the native request record ID. Replacing a delivery requires its current expectedVersion.', {
    improvementId: text, requestId: text, expectedVersion: text.optional(),
    artifact: z.union([z.object({ memoryUpdate: z.record(z.unknown()) }).strict(),
      z.object({ repository: text, commit: text, file: text, prUrl: z.string().url().optional(), evidenceId: text.optional() }).strict()])
  }, args => apply(service, args));
  register('review_improvements', 'Resume local improvements. Inspect nextAction, deliveries and verification attempts; filter by the source review, problem or current state.', {
    reviewId: text.optional(), problemId: text.optional(), state: states.optional(), cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25)
  }, ({ reviewId, problemId, state, cursor, limit }) => {
    const all = service.store.list('improvement').filter(i => (!reviewId || i.reviewId === reviewId) &&
      (!problemId || i.problemId === problemId) && (!state || i.state === state));
    return { items: all.slice(cursor, cursor + limit), nextCursor: cursor + limit < all.length ? cursor + limit : null };
  });
}

module.exports = { registerImprovementTools, bindImprovement, recordVerification, link, proposal, plan };
