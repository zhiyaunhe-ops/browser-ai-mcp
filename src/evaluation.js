'use strict';

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { callReviewToolkit, resolveDomainTag } = require('./review-toolkit');
const { sessionContext, sessionSearch } = require('./session-context');
const { edition } = require('./service');
const text = z.string().min(1);
const editionField = { domain_tag: text.optional() };
const ids = z.array(text).max(100);
const notes = z.array(text).max(30);
const verdict = z.enum(['pass', 'fail', 'insufficient_evidence']);
const criterionResult = z.object({
  criterionId: text, verdict: z.enum(['met', 'unmet', 'insufficient_evidence']), reason: text, evidenceIds: ids
});
const summary = z.object({ result: text, lessons: notes.default([]), limitations: notes.default([]) });
const memory = z.object({
  ...editionField,
  problem_id: text.describe('Reuse the same identifier for attempts at the same problem.'),
  context: text, rationale: text, prediction: text, metric: text,
  evidence: text.describe('Describe the evidence source or the planned evidence source. Cite Browser observation and record IDs in evidenceIds.'),
  model: text.optional()
});
const sessionSource = z.object({ path: text, sessionId: text, startLine: z.number().int().positive().optional() });
const sessionRefs = z.array(z.object({ path: text, sessionId: text, line: z.number().int().positive(), commit: text.optional() })).max(30);
const assessment = {
  reviewerModel: text, verdict, criterionResults: z.array(criterionResult).max(30), evidenceIds: ids, summary,
  memory: memory.optional()
};
const deliveryHint = 'If the review produced a reusable fix, regression case or documented lesson, open a PR on the authorized repository. Include the problem ID, change rationale, evidence locators and verification result, and return the PR URL. Keep the full session log local.';
const memoryOrigin = z.enum(['run_begin', 'eval_submit']);
const report = z.object({ runId: text, reviewKey: text, reviewId: text, submittedAt: z.number(),
  ...editionField, ...assessment, deliveryHint: text.optional(), sessionRefs: sessionRefs.optional(), memoryOrigin: memoryOrigin.optional() });
const relatedReview = z.object({ attemptId: text, ...editionField, problemId: text.optional(), goal: text.optional(), verdict: verdict.optional() });
const error = (code, message) => Object.assign(new Error(message), { code });

function packet(service, { runId, reviewKey, cursor = 0, limit = 10 }) {
  const run = service.run(runId);
  const reviewState = service.reviewState(run);
  if (reviewState === 'not_ready') throw error('EVAL_NOT_READY', 'Wait for run_finish to hand off the current execution.');
  if ((reviewKey !== undefined || cursor > 0) && reviewKey !== run.feedback.requestId) {
    throw error('EVAL_STALE', 'Use the first page reviewKey to continue reading this handoff.');
  }
  const executions = service.executions(runId).filter(e => e.sequence > cursor);
  const rounds = executions.slice(0, limit).map(e => {
    const { result } = service.executionView(e);
    return { executionId: e.executionId, sequence: e.sequence, purpose: e.purpose, state: e.state,
      businessTool: e.businessTool, observationId: e.observationId, result, error: e.error, networkCapture: e.networkCapture };
  });
  const relatedReviews = (service.recalledForEdition(run)?.reviewLessons ?? []).map(lesson => ({
    attemptId: lesson.reviewId, ...edition(lesson.domain_tag),
    problemId: lesson.problemId, goal: lesson.goal, verdict: lesson.verdict
  }));
  return { schemaVersion: 1, runId, reviewKey: run.feedback.requestId, reviewState,
    ...edition(run.domain_tag), goal: run.goal, url: run.url,
    sessionSearch: sessionSearch(), ...(run.sessionSource ? { sessionSource: run.sessionSource } : {}), criteria: run.criteria, executionOutcome: run.outcome, executionNote: run.feedback.note,
    lastWriteSequence: run.lastWriteSequence ?? 0, verification: run.feedback.verification,
    readbacks: service.criterionReadbacks(run), gaps: service.gaps(runId), relatedReviews,
    ...(run.reviewMemory ? { reviewMemory: run.reviewMemory } : {}),
    rounds, nextCursor: rounds.at(-1)?.sequence ?? cursor, hasMore: executions.length > limit };
}

function submit(service, input) {
  return service.store.transaction(() => {
    const { runId, reviewKey, domain_tag, sessionRefs, requestId: _requestId, ...assessment } = input;
    const request = service.request('eval_submit', runId, input);
    if (request.previous) return service.store.get('evaluation', request.previous.reviewId);
    const run = service.run(runId);
    if (service.reviewState(run) === 'not_ready' || run.feedback.requestId !== reviewKey) {
      throw error('EVAL_STALE', 'Retrieve the current handoff with eval_packet.');
    }
    if (run.reviewId) throw error('EVAL_ALREADY_SUBMITTED', 'A review for this handoff is available in run_summary.');
    for (const tag of [domain_tag, assessment.memory?.domain_tag]) {
      if (tag !== undefined && resolveDomainTag({ domain_tag: tag }) !== run.domain_tag) {
        throw error('DOMAIN_TAG_MISMATCH', 'Use the product edition shown in eval_packet.');
      }
    }
    if (run.reviewMemory) assessment.memory ??= run.reviewMemory;
    if (assessment.memory && run.domain_tag) assessment.memory = { ...assessment.memory, domain_tag: run.domain_tag };
    const results = assessment.criterionResults;
    const references = new Set([...assessment.evidenceIds, ...results.flatMap(row => row.evidenceIds)]);
    const readbacks = new Set();
    for (const id of references) {
      const observation = service.store.get('observation', id);
      const record = observation?.runId === runId ? null : service.store.evidenceById(id, runId);
      if (observation?.runId !== runId && !record) {
        throw error('EVAL_EVIDENCE', 'Evidence references must be observationId or recordId values from this run.');
      }
      const sequence = observation?.runId === runId ? observation.sequence :
        record.kind === 'observation' ? record.payload.sequence : null;
      if (sequence > (run.lastWriteSequence || 0)) readbacks.add(id);
    }
    if ((assessment.verdict === 'pass' && !readbacks.size) ||
        results.some(row => row.verdict === 'met' && !row.evidenceIds.some(id => readbacks.has(id)))) {
      throw error('EVAL_EVIDENCE', 'Cite a post-action observation for a passing review and for each met criterion.');
    }
    const { assessment: evaluated } = callReviewToolkit('evaluate', {
      criteria: run.criteria, assessment: { ...assessment, ...edition(run.domain_tag) }
    });
    if (evaluated.domain_tag !== run.domain_tag) throw error('DOMAIN_TAG_MISMATCH', 'Use the product edition shown in eval_packet.');
    if (run.reviewMemory && !isDeepStrictEqual(evaluated.memory, { ...run.reviewMemory, ...edition(run.domain_tag) })) {
      throw error('EVAL_MEMORY_CONFLICT', 'Keep the reviewMemory preregistered in run_begin.');
    }
    const reviewId = service.id();
    const review = { runId, reviewKey, reviewId, submittedAt: service.now(), ...evaluated, deliveryHint, ...(sessionRefs ? { sessionRefs } : {}),
      ...edition(run.domain_tag),
      ...(evaluated.memory ? { memoryOrigin: run.reviewMemory ? 'run_begin' : 'eval_submit' } : {}) };
    service.store.put('evaluation', reviewId, review);
    run.reviewId = reviewId;
    service.store.put('run', runId, run);
    service.saveRequest(request, { reviewId });
    return review;
  });
}

function history(service, filters) {
  const browserDb = path.join(service.store.directory, 'browser-ai.sqlite');
  return callReviewToolkit('history', filters, ['--browser-db', browserDb]);
}

function registerEvaluationTools(register, service) {
  const runId = { runId: text };
  const page = { cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() };
  const pagination = { nextCursor: z.number(), hasMore: z.boolean() };
  const state = z.enum(['not_ready', 'pending', 'reviewed']);
  register('eval_pending', '读取已交接、待评估的任务，可按产品版本 domain_tag 筛选，按 nextCursor 翻页。', { ...page, ...editionField },
    args => service.store.pendingReviews(args.cursor ?? 0, args.limit ?? 20,
      args.domain_tag === undefined ? undefined : resolveDomainTag({ domain_tag: args.domain_tag })),
    z.object({ runs: z.array(z.object({ ...runId, ...editionField, goal: text, outcome: text, reviewKey: text })), ...pagination }));
  register('eval_packet', '评估模型读取任务目标、验收条件、执行结果、独立回读和采集缺口。用 evidence_query 补读记录与请求。将 relatedReviews 中的 attemptId 填入 review_history 的 attempt_id 查询往期评估。同一问题的后续尝试沿用 problem_id，翻页和提交沿用首页的 reviewKey。', { ...runId, ...page, reviewKey: text.optional() },
    args => service.store.transaction(() => packet(service, args)),
    z.object({ schemaVersion: z.literal(1), ...runId, ...editionField, reviewKey: text, reviewState: state, goal: text, url: text, sessionSource: sessionSource.optional(),
      sessionSearch: z.object({ roots: z.array(z.object({ client: text, path: text })), instructions: text }),
      criteria: z.array(z.object({ id: text, path: z.string(), equals: z.unknown() })), executionOutcome: text,
      executionNote: z.string(), verification: z.array(z.object({ criterionId: text, observationId: text })),
      readbacks: z.array(z.object({ criterionId: text, found: z.boolean(), observationId: text.optional(),
        afterLastWrite: z.boolean().optional(), matchesExpected: z.boolean().optional(), actual: z.unknown().optional() })),
      lastWriteSequence: z.number(), relatedReviews: z.array(relatedReview), reviewMemory: memory.optional(),
      rounds: z.array(z.object({ executionId: text, sequence: z.number(),
        purpose: text, state: text, observationId: text.optional(), businessTool: text.optional(),
        result: z.unknown(), error: z.unknown(), networkCapture: z.unknown() })), gaps: z.array(z.record(z.unknown())), ...pagination }));
  register('eval_submit', '独立评估模型提交逐条判定、同一任务的证据引用与总结。证据不足可标记 insufficient_evidence。填写可跨环境使用的经验和适用限制，环境与业务参数留在源运行证据。沿用 run_begin 预登记的 reviewMemory，也可补填 memory。Toolkit 按 problem_id 关联多次尝试。重试沿用 requestId。', {
    ...runId, ...editionField, requestId: text, reviewKey: text, ...assessment, sessionRefs: sessionRefs.optional()
  }, args => submit(service, args), report);
  register('run_summary', '读取运行结果、评估进度及独立模型已提交的结构化总结。', runId, args => {
    const run = service.run(args.runId);
    const reviewState = service.reviewState(run);
    const review = reviewState === 'reviewed' ? service.store.get('evaluation', run.reviewId) : null;
    return { runId: run.runId, ...edition(run.domain_tag), goal: run.goal, url: run.url,
      executionOutcome: run.outcome ?? null, reviewState,
      review: review ? { ...edition(run.domain_tag), ...review } : null };
  }, z.object({ ...runId, ...editionField, goal: text, url: text, executionOutcome: text.nullable(), reviewState: state, review: report.nullable() }));
  register('eval_session_context', 'Read the original local harness JSONL by absolute path and physical line number. Compare the user request, corrections, tool output and final answer. Continue at nextLine. A truncated or missing record leaves that evidence incomplete.', {
    path: text, startLine: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).optional()
  }, sessionContext);
  register('review_observe', 'Record a later measurement for a local Browser reviewId. Use the deployed commit for version when known. Supply baseline for directional findings and observed_at with offset on the submission day. Identical measurements are idempotent.', {
    attempt_id: text, observation: z.object({
      day: text, version: text.nullable(), eligible: z.number().int().nonnegative().nullable(),
      affected: z.number().int().nonnegative().nullable(), evidence: text,
      finding: z.enum(['unknown', 'no_sample', 'observed', 'improved', 'unchanged', 'regressed']),
      baseline: z.object({ eligible: z.number().int().positive(), affected: z.number().int().nonnegative(), evidence: text }).optional(),
      observed_at: text.optional(), exposure_evidence: text.optional(), supersedes: text.optional()
    })
  }, args => callReviewToolkit('observe', { ...args, source: 'browser' }, ['--browser-db', path.join(service.store.directory, 'browser-ai.sqlite')]));
  register('review_history', '读取 Toolkit 汇总的独立评估、决策和后续观察。按 problem_id、attempt_id 或来源筛选。Browser 的 attempt_id 对应 reviewId。', {
    ...editionField, problem_id: text.optional(), attempt_id: text.optional(), source: z.enum(['browser', 'telegram']).optional()
  }, args => history(service, args));
}

module.exports = { registerEvaluationTools, reviewMemorySchema: memory, sessionSource };
