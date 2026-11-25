'use strict';

const { z } = require('zod');
const text = z.string().min(1);
const ids = z.array(text).max(100);
const notes = z.array(text).max(30);
const verdict = z.enum(['pass', 'fail', 'insufficient_evidence']);
const criterionResult = z.object({
  criterionId: text, verdict: z.enum(['met', 'unmet', 'insufficient_evidence']), reason: text, evidenceIds: ids
});
const summary = z.object({ result: text, lessons: notes.default([]), limitations: notes.default([]) });
const assessment = {
  reviewerModel: text, verdict, criterionResults: z.array(criterionResult).max(30), evidenceIds: ids, summary
};
const report = z.object({ runId: text, reviewKey: text, reviewId: text, submittedAt: z.number(), ...assessment });
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
  return { schemaVersion: 1, runId, reviewKey: run.feedback.requestId, reviewState,
    goal: run.goal, criteria: run.criteria, executionOutcome: run.outcome, executionNote: run.feedback.note,
    lastWriteSequence: run.lastWriteSequence ?? 0, verification: run.feedback.verification,
    readbacks: service.criterionReadbacks(run), gaps: service.gaps(runId),
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
    const results = assessment.criterionResults;
    const expected = new Set(run.criteria.map(c => c.id));
    if (results.length !== expected.size || results.some(r => !expected.delete(r.criterionId))) {
      throw error('EVAL_CRITERIA', 'Report each declared criterion exactly once.');
    }
    const references = new Set(assessment.evidenceIds);
    for (const row of results) {
      if (row.verdict !== 'insufficient_evidence' && !row.evidenceIds.length) {
        throw error('EVAL_EVIDENCE', 'Cite evidence for each met or unmet criterion.');
      }
      for (const id of row.evidenceIds) references.add(id);
    }
    if (assessment.verdict !== 'insufficient_evidence' && !references.size) {
      throw error('EVAL_EVIDENCE', 'Cite evidence from the run for a conclusive review.');
    }
    if (assessment.verdict === 'pass' && results.some(row => row.verdict !== 'met')) {
      throw error('EVAL_CRITERIA', 'A passing review requires all declared criteria to be met.');
    }
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
    const reviewId = service.id();
    const review = { runId, reviewKey, reviewId, submittedAt: service.now(), ...assessment };
    service.store.put('evaluation', reviewId, review);
    run.reviewId = reviewId;
    service.store.put('run', runId, run);
    service.saveRequest(request, { reviewId });
    return review;
  });
}

function registerEvaluationTools(register, service) {
  const runId = { runId: text };
  const page = { cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() };
  const pagination = { nextCursor: z.number(), hasMore: z.boolean() };
  const state = z.enum(['not_ready', 'pending', 'reviewed']);
  register('eval_pending', '独立评估模型读取已交接、待评估的任务，按 nextCursor 翻页。', page,
    args => service.store.pendingReviews(args.cursor ?? 0, args.limit ?? 20),
    z.object({ runs: z.array(z.object({ ...runId, goal: text, outcome: text, reviewKey: text })), ...pagination }));
  register('eval_packet', '评估模型读取任务目标、验收条件、执行结果、独立回读和采集缺口。用 evidence_query 补读记录与请求，翻页和提交时沿用首页的 reviewKey。', { ...runId, ...page, reviewKey: text.optional() },
    args => service.store.transaction(() => packet(service, args)),
    z.object({ schemaVersion: z.literal(1), ...runId, reviewKey: text, reviewState: state, goal: text,
      criteria: z.array(z.object({ id: text, path: z.string(), equals: z.unknown() })), executionOutcome: text,
      executionNote: z.string(), verification: z.array(z.object({ criterionId: text, observationId: text })),
      readbacks: z.array(z.object({ criterionId: text, found: z.boolean(), observationId: text.optional(),
        afterLastWrite: z.boolean().optional(), matchesExpected: z.boolean().optional(), actual: z.unknown().optional() })),
      lastWriteSequence: z.number(), rounds: z.array(z.object({ executionId: text, sequence: z.number(),
        purpose: text, state: text, observationId: text.optional(), businessTool: text.optional(),
        result: z.unknown(), error: z.unknown(), networkCapture: z.unknown() })), gaps: z.array(z.record(z.unknown())), ...pagination }));
  register('eval_submit', '独立评估模型提交逐条判定、同一任务的证据引用与总结。证据不足可明确标记 insufficient_evidence。重试沿用 requestId。', {
    ...runId, requestId: text, reviewKey: text, ...assessment
  }, args => submit(service, args), report);
  register('run_summary', '读取运行结果、评估进度及独立模型已提交的结构化总结。', runId, args => {
    const run = service.run(args.runId);
    const reviewState = service.reviewState(run);
    return { runId: run.runId, goal: run.goal, executionOutcome: run.outcome ?? null, reviewState,
      review: reviewState === 'reviewed' ? service.store.get('evaluation', run.reviewId) : null };
  }, z.object({ ...runId, goal: text, executionOutcome: text.nullable(), reviewState: state, review: report.nullable() }));
}

module.exports = { registerEvaluationTools };
