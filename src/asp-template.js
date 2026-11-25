'use strict';

const { templateScript: script } = require('./asp-scripts');
const { edition } = require('./service');
const workbench = 'https://global.yonyoucloud.com/';

function validateDesignerUrl(designerUrl) {
  const url = URL.parse(designerUrl);
  if (!url || url.origin !== new URL(workbench).origin ||
      url.pathname !== '/iuap-yonbuilder-designer/ucf-wh/designer/apps/quickdev/index.html' ||
      !/^#\/onepage\/design\/[^/?#]+\/PT\d+\/ysmdd(?:\?|$)/.test(url.hash)) {
    throw Object.assign(new Error('Provide a PC bill designer URL from the selected workbench row'), { code: 'INVALID_ARGUMENT' });
  }
}

async function updateTemplateField(service, input) {
  const { requestId, templateId, templateName, transactionType, field, changes, designerUrl: directUrl } = input;
  const { documentName, documentPath, pageType, fieldScope, detailEntity, fieldId, fieldNid } = input;
  const selection = { documentName, documentPath, pageType, fieldScope: fieldScope ?? (detailEntity ? 'detail' : undefined),
    detailEntity, fieldId, fieldNid };
  if (!templateId && !templateName) throw new Error('Provide templateId or templateName');
  if (documentName && documentPath && documentPath.at(-1) !== documentName) throw new Error('documentPath must end with documentName');
  if (detailEntity && fieldScope === 'header') throw new Error('detailEntity selects a detail table; use fieldScope "detail"');
  if (directUrl) {
    validateDesignerUrl(directUrl);
    if (!templateId || transactionType) throw new Error('Direct designer access requires templateId. Omit designerUrl to match transactionType in the workbench.');
    if (documentName || documentPath || pageType) throw new Error('Omit designerUrl to select a workbench document or page type');
  }
  const required = changes.required;
  const useModel = Boolean(directUrl) || Object.keys(changes).length !== 1 || required === undefined;
  const desired = { ...changes.properties };
  for (const [alias, key] of Object.entries({ required: 'UI#required', visible: 'bShowIt', editable: 'bCanModify', caption: 'UI#cShowCaption' })) {
    if (!Object.hasOwn(changes, alias)) continue;
    if (Object.hasOwn(desired, key)) throw new Error('Supply ' + alias + ' or properties.' + key + ' once');
    desired[key] = changes[alias];
  }
  if (Object.hasOwn(desired, 'formula')) throw new Error('Use changes.formula to set or clear a calculation formula');
  if (Object.hasOwn(changes, 'formula')) {
    const value = changes.formula;
    desired.formula = typeof value === 'string' ? { expression: value, display: '' } :
      value && { expression: value.expression, display: value.display ?? '' };
  }
  const criteria = useModel ? [{ id: 'properties', path: 'matches', equals: true }]
    : [{ id: 'required', path: 'required', equals: required }];
  if (templateId) criteria.push({ id: 'template', path: 'templateId', equals: templateId });
  if (templateName) criteria.push({ id: 'template-name', path: 'templateName', equals: templateName });
  if (transactionType && !useModel) criteria.push({ id: 'transaction', path: 'transactionType', equals: transactionType });
  const run = service.begin({ requestId: 'asp-template:' + requestId, url: workbench,
    ...edition(input.domain_tag),
    goal: JSON.stringify(useModel ? { templateId, templateName, transactionType, field, directUrl, desired, ...selection }
      : { templateId, templateName, transactionType, field, required, ...selection }), criteria },
  { business_tool: 'asp_ui_template_update_field', document_name: documentName, document_path: documentPath });
  const runId = run.runId;
  const runScope = { runId, ...edition(run.domain_tag) };

  async function round(step, purpose, args, pageLabel = 'p1') {
    const code = 'const workflow = await import(' + JSON.stringify(script) + '); return await workflow.' + step + '(task, page, input);';
    // A retry may load a newer script revision. Resume the round already
    // attached to this business request instead of submitting a changed script.
    const previous = run.sequence && service.executions(runId).find(item => item.requestId === step);
    let execution = previous
      ? (await service.get({ runId, executionId: previous.executionId, limit: 1 })).executions[0]
      : await service.browserRun({ runId, requestId: step, purpose, code, pageLabel, args, timeoutMs: 120000 });
    while (['queued', 'running'].includes(execution.state)) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const state = await service.get({ runId, executionId: execution.executionId, limit: 1 });
      execution = state.executions[0];
    }
    // The public execution view shortens large results. Field inspection needs
    // the full catalog, including options for every property on this control.
    if (execution.result?.truncated === true) {
      return service.store.get('execution', execution.executionId);
    }
    return execution;
  }
  const finish = (outcome, note, verification = []) => service.finish({ runId, requestId: 'finish-' + outcome,
    outcome, decision: 'no-change', note, verification });
  async function interrupted(execution) {
    if (execution.state === 'failed') await finish('failed', execution.error.message);
    return { ...runScope, status: execution.state, error: execution.error, executionId: execution.executionId };
  }

  if (useModel) {
    const lookup = await round('locateModel', 'observe', { templateId, templateName, transactionType, field, designerUrl: directUrl, desired, ...selection });
    if (lookup.state !== 'succeeded') return interrupted(lookup);
    const { designerUrl, pageLabel, values: before, properties: _properties, matches, ...identity } = lookup.result;
    if (identity.status) {
      await finish('cancelled', identity.status);
      return { ...runScope, ...identity };
    }
    const target = { ...identity, designerUrl, desired, fieldNid };
    let write;
    if (!matches) {
      write = await round('updateModel', 'execute', target, pageLabel);
      if (write.state === 'outcome_unknown' && !write.executionStopped) return interrupted(write);
    }
    const observed = await round('verifyModel', 'observe', target);
    if (observed.state !== 'succeeded') return interrupted(observed);
    const actual = observed.result;
    const verified = sameField(actual, identity, fieldNid) && actual.matches === true;
    const verification = criteria.map(c => ({ criterionId: c.id, observationId: observed.observationId }));
    await finish(verified ? 'succeeded' : 'failed', verified ? 'Read the field model in a fresh designer' :
      'Reopened designer did not show the requested properties', verified ? verification : []);
    return { ...runScope, ...identity, designerUrl, before, after: actual.values, properties: actual.properties,
      verified, observationId: observed.observationId,
      status: verified ? write?.result?.changed ? 'updated' : write ? 'verified' :
        Object.keys(desired).length ? 'already_set' : 'inspected' : 'verification_failed',
      ...(write?.result?.savePost ? { savePost: write.result.savePost } : {}),
      ...(write?.error ? { writeError: write.error.message } : {}) };
  }

  const lookup = await round('locate', 'observe', { templateId, templateName, transactionType, field, ...selection });
  if (lookup.state !== 'succeeded') return interrupted(lookup);
  const { designerUrl, pageLabel, required: before, ...identity } = lookup.result;
  if (identity.status) {
    await finish('cancelled', identity.status);
    return { ...runScope, ...identity };
  }
  const target = { ...identity, designerUrl, fieldNid };
  let write;
  if (before !== required) {
    write = await round('update', 'execute', { ...target, desired: required }, pageLabel);
    if (write.state === 'outcome_unknown' && !write.executionStopped) return interrupted(write);
  }
  const observed = await round('verify', 'observe', target);
  if (observed.state !== 'succeeded') return interrupted(observed);
  const actual = observed.result;
  const verified = sameField(actual, identity, fieldNid) && actual.required === required;
  const verification = criteria.map(c => ({ criterionId: c.id, observationId: observed.observationId }));
  await finish(verified ? 'succeeded' : 'failed', verified ? 'Reopened template and read the requested field' :
    'Reopened template did not show the requested property', verified ? verification : []);
  return { ...runScope, ...identity, designerUrl, before, after: actual.required ?? null, verified, observationId: observed.observationId,
    status: verified ? write?.result?.changed ? 'updated' : before === required ? 'already_set' : 'verified' : 'verification_failed',
    ...(write?.result?.savePost ? { savePost: write.result.savePost } : {}),
    ...(write?.error ? { writeError: write.error.message } : {}) };
}
function sameField(observed, selected, fieldNid) {
  // Some designers allocate fresh node IDs when reopened. Their persisted
  // field ID or a unique exact field code in the scoped entity can identify it.
  if (fieldNid && observed.nid !== fieldNid) return false;
  const idKey = selected.fieldId ? 'fieldId' : 'nid';
  const matchedId = selected[idKey] === undefined || observed[idKey] === selected[idKey] ||
    (!selected.fieldId && !fieldNid && observed.reopenedByFieldCode === true);
  return matchedId && ['templateId', 'field', 'billNo', 'fieldScope', 'entityCode'].every(key =>
    selected[key] === undefined || observed[key] === selected[key]);
}
module.exports = { updateTemplateField, validateDesignerUrl };
