'use strict';

const { isDeepStrictEqual } = require('node:util');
const { templateScript } = require('./asp-scripts');
const { validateDesignerUrl } = require('./asp-template');
const { edition } = require('./service');

const tool = 'asp_ui_template_verify_batch';
const code = 'const workflow = await import(' + JSON.stringify(templateScript) + '); return await workflow.verifyBatchField(task, page, input);';

function checkWriteSequence(run, lastWriteSequence) {
  if ((run.lastWriteSequence ?? 0) !== lastWriteSequence) {
    throw Object.assign(new Error('A newer write exists in this run. Use a new batch requestId after the write.'), { code: 'BATCH_STALE' });
  }
}

function selectTarget({ templateId, templateName, designerUrl, field, fieldScope, detailEntity, fieldId, fieldNid, expected }) {
  validateDesignerUrl(designerUrl);
  if (detailEntity && fieldScope === 'header') {
    throw Object.assign(new Error('detailEntity selects a detail table; use fieldScope "detail"'), { code: 'INVALID_ARGUMENT' });
  }
  const formula = expected.formula;
  if (Object.hasOwn(expected, 'formula') && formula !== null &&
      (!formula?.expression || typeof formula.expression !== 'string' ||
        (formula.display !== undefined && typeof formula.display !== 'string'))) {
    throw Object.assign(new Error('expected.formula must be an object with an expression or null'), { code: 'INVALID_ARGUMENT' });
  }
  return { templateId, designerUrl, field, fieldScope: fieldScope ?? (detailEntity ? 'detail' : 'header'), expected,
    ...(templateName ? { templateName } : {}), ...(detailEntity ? { detailEntity } : {}),
    ...(fieldId ? { fieldId } : {}), ...(fieldNid ? { fieldNid } : {}) };
}

async function verifyTemplateBatch(service, { runId, requestId, targets }) {
  const selections = targets.map(selectTarget);
  const { lastWriteSequence, hash } = service.store.transaction(() => {
    const request = service.request(tool, runId, { requestId, targets });
    const run = service.run(runId);
    if (run.criteria.some(criterion => criterion.path === 'verifiedTargets' && !isDeepStrictEqual(criterion.equals, targets))) {
      throw Object.assign(new Error('Targets must match the ordered verification scope registered in run_begin'), { code: 'BATCH_SCOPE_MISMATCH' });
    }
    const lastWriteSequence = request.previous?.lastWriteSequence ?? run.lastWriteSequence ?? 0;
    checkWriteSequence(run, lastWriteSequence);
    if (!request.previous) service.saveRequest(request, { runId, lastWriteSequence });
    return { lastWriteSequence, hash: request.hash };
  });

  const rows = [];
  let aggregate;
  for (const [index, target] of selections.entries()) {
    const roundId = `${tool}:${hash}:${index}`;
    const final = index === selections.length - 1;
    // Resume the original dispatch even if the implementation or a prior failed round's state has changed.
    const previous = service.executions(runId).find(item => item.businessTool === tool && item.requestId === roundId);
    const args = previous?.args ?? { index, target, ...(final ? { previousRows: rows.slice(), targets } : {}) };
    const readError = error => ({ ...target, index, actual: null, status: 'read_error', observationId: null, error });
    let execution;
    try {
      execution = await service.browserRun({ runId, requestId: roundId, businessTool: tool,
        purpose: 'observe', code, args, timeoutMs: 120000 }, { lastWriteSequence });
    } catch (error) {
      if (!['OUTCOME_UNKNOWN', 'USER_ACTION_REQUIRED'].includes(error.code)) throw error;
      rows.push(readError({ code: error.code, message: error.message }));
      continue;
    }
    while (['queued', 'running'].includes(execution.state)) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const state = await service.get({ runId, executionId: execution.executionId, limit: 1 });
      execution = state.executions[0];
    }
    const observation = execution.observationId && service.store.get('observation', execution.observationId);
    const valid = observation && observation.runId === runId && observation.executionId === execution.executionId &&
      observation.sequence === execution.sequence && observation.sequence > lastWriteSequence;
    const observed = valid ? observation.value : null;
    const row = final ? observed?.rows?.[index] : observed?.row;
    if (row?.index !== index || !row.status) {
      rows.push(readError(execution.error ?? { message: 'No fresh field observation was recorded' }));
      continue;
    }
    if (final && observed.rows.length === selections.length && isDeepStrictEqual(observed.rows.slice(0, -1), rows)) {
      aggregate = observation;
    }
    rows.push({ ...target, ...row, observationId: observation.observationId });
  }

  return service.store.transaction(() => {
    const run = service.run(runId);
    checkWriteSequence(run, lastWriteSequence);
    const allSelectedFieldsMatch = aggregate?.value.allSelectedFieldsMatch === true &&
      isDeepStrictEqual(aggregate.value.verifiedTargets, targets) &&
      rows.every(row => row.status === 'matched' && row.observationId);
    const verification = allSelectedFieldsMatch ? run.criteria.filter(c =>
      ['allSelectedFieldsMatch', 'verifiedTargets'].includes(c.path) && isDeepStrictEqual(aggregate.value[c.path], c.equals))
      .map(c => ({ criterionId: c.id, observationId: aggregate.observationId })) : [];
    return { runId, ...edition(run.domain_tag), rows, allSelectedFieldsMatch,
      ...(aggregate ? { observationId: aggregate.observationId } : {}), verification };
  });
}

module.exports = { verifyTemplateBatch };
