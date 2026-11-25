'use strict';

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { z } = require('zod');
const { callReviewToolkit } = require('./review-toolkit');
const text = z.string().min(1);
const ids = z.array(text).max(100);
const notes = z.array(text).max(30);
const verdict = z.enum(['pass', 'fail', 'insufficient_evidence']);
const criterionResult = z.object({
  criterionId: text, verdict: z.enum(['met', 'unmet', 'insufficient_evidence']), reason: text, evidenceIds: ids
});
const summary = z.object({ result: text, lessons: notes.default([]), limitations: notes.default([]) });
const memory = z.object({
  problem_id: text.describe('Reuse the same identifier for attempts at the same problem.'),
  context: text, rationale: text, prediction: text, metric: text,
  evidence: text.describe('Describe the evidence source or the planned evidence source. Cite Browser observation and record IDs in evidenceIds.'),
  model: text.optional()
});
const assessment = {
  reviewerModel: text, verdict, criterionResults: z.array(criterionResult).max(30), evidenceIds: ids, summary,
  memory: memory.optional()
};
const memoryOrigin = z.enum(['run_begin', 'eval_submit']);
const report = z.object({ runId: text, reviewKey: text, reviewId: text, submittedAt: z.number(),
  ...assessment, memoryOrigin: memoryOrigin.optional() });
const relatedReview = z.object({ attemptId: text, problemId: text.optional(), goal: text, verdict });
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
  const relatedReviews = (run.recalledMemory?.reviewLessons ?? []).map(lesson => ({
    attemptId: lesson.reviewId, problemId: lesson.problemId, goal: lesson.goal, verdict: lesson.verdict
  }));
  return { schemaVersion: 1, runId, reviewKey: run.feedback.requestId, reviewState,
    goal: run.goal, criteria: run.criteria, executionOutcome: run.outcome, executionNote: run.feedback.note,
    lastWriteSequence: run.lastWriteSequence ?? 0, verification: run.feedback.verification,
    readbacks: service.criterionReadbacks(run), gaps: service.gaps(runId), relatedReviews,
    ...(run.reviewMemory ? { reviewMemory: run.reviewMemory } : {}),
    rounds, nextCursor: rounds.at(-1)?.sequence ?? cursor, hasMore: executions.length > limit };
}

function submit(service, input) {
  return service.store.transaction(() => {
    const { runId, requestId, reviewKey, ...assessment } = input;
    const request = service.request('eval_submit', runId, input);
    if (request.previous) return service.store.get('evaluation', request.previous.reviewId);
    const run = service.run(runId);
    if (service.reviewState(run) === 'not_ready' || run.feedback.requestId !== reviewKey) {
      throw error('EVAL_STALE', 'Retrieve the current handoff with eval_packet.');
    }
    if (run.reviewId) throw error('EVAL_ALREADY_SUBMITTED', 'A review for this handoff is available in run_summary.');
    if (run.reviewMemory) assessment.memory ??= run.reviewMemory;
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
    const { assessment: evaluated } = callReviewToolkit('evaluate', { criteria: run.criteria, assessment });
    if (run.reviewMemory && !isDeepStrictEqual(evaluated.memory, run.reviewMemory)) {
      throw error('EVAL_MEMORY_CONFLICT', 'Keep the reviewMemory preregistered in run_begin.');
    }
    const reviewId = service.id();
    const review = { runId, reviewKey, reviewId, submittedAt: service.now(), ...evaluated,
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
  register('eval_pending', '独立评估模型读取已交接、待评估的任务，按 nextCursor 翻页。', page,
    args => service.store.pendingReviews(args.cursor ?? 0, args.limit ?? 20),
    z.object({ runs: z.array(z.object({ ...runId, goal: text, outcome: text, reviewKey: text })), ...pagination }));
  register('eval_packet', '评估模型读取任务目标、验收条件、执行结果、独立回读和采集缺口。用 evidence_query 补读记录与请求。将 relatedReviews 中的 attemptId 填入 review_history 的 attempt_id 查询往期评估。同一问题的后续尝试沿用 problem_id，翻页和提交沿用首页的 reviewKey。', { ...runId, ...page, reviewKey: text.optional() },
    args => service.store.transaction(() => packet(service, args)),
    z.object({ schemaVersion: z.literal(1), ...runId, reviewKey: text, reviewState: state, goal: text,
      criteria: z.array(z.object({ id: text, path: z.string(), equals: z.unknown() })), executionOutcome: text,
      executionNote: z.string(), verification: z.array(z.object({ criterionId: text, observationId: text })),
      readbacks: z.array(z.object({ criterionId: text, found: z.boolean(), observationId: text.optional(),
        afterLastWrite: z.boolean().optional(), matchesExpected: z.boolean().optional(), actual: z.unknown().optional() })),
      lastWriteSequence: z.number(), relatedReviews: z.array(relatedReview), reviewMemory: memory.optional(),
      rounds: z.array(z.object({ executionId: text, sequence: z.number(),
        purpose: text, state: text, observationId: text.optional(), businessTool: text.optional(),
        result: z.unknown(), error: z.unknown(), networkCapture: z.unknown() })), gaps: z.array(z.record(z.unknown())), ...pagination }));
  register('eval_submit', '独立评估模型提交逐条判定、同一任务的证据引用与总结。证据不足可明确标记 insufficient_evidence。自动沿用 run_begin 预登记的 reviewMemory；未预登记时可补填 memory。Toolkit 按 problem_id 关联多次尝试。重试沿用 requestId。', {
    ...runId, requestId: text, reviewKey: text, ...assessment
  }, args => submit(service, args), report);
  register('run_summary', '读取运行结果、评估进度及独立模型已提交的结构化总结。', runId, args => {
    const run = service.run(args.runId);
    const reviewState = service.reviewState(run);
    return { runId: run.runId, goal: run.goal, executionOutcome: run.outcome ?? null, reviewState,
      review: reviewState === 'reviewed' ? service.store.get('evaluation', run.reviewId) : null };
  }, z.object({ ...runId, goal: text, executionOutcome: text.nullable(), reviewState: state, review: report.nullable() }));
  register('review_history', '读取 Toolkit 汇总的独立评估、决策和后续观察。按 problem_id、attempt_id 或来源筛选。Browser 的 attempt_id 对应 reviewId。', {
    problem_id: text.optional(), attempt_id: text.optional(), source: z.enum(['browser', 'telegram']).optional()
  }, args => history(service, args));
}

module.exports = { registerEvaluationTools, reviewMemorySchema: memory };
