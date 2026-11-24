'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const scriptFile = path.join(__dirname, '../scripts/asp-template.mjs');
const revision = createHash('sha256').update(readFileSync(scriptFile)).digest('hex').slice(0, 16);
const script = pathToFileURL(scriptFile).href + '?revision=' + revision;
const workbench = 'https://global.yonyoucloud.com/';

async function updateTemplateField(service, input) {
  const { requestId, templateId, templateName, transactionType, field, changes } = input;
  if (!templateId && !templateName) throw new Error('Provide templateId or templateName');
  const required = changes.required;
  const criteria = [{ id: 'required', path: 'required', equals: required }];
  if (templateId) criteria.push({ id: 'template', path: 'templateId', equals: templateId });
  if (templateName) criteria.push({ id: 'template-name', path: 'templateName', equals: templateName });
  if (transactionType) criteria.push({ id: 'transaction', path: 'transactionType', equals: transactionType });
  const run = service.begin({ requestId: 'asp-template:' + requestId, url: workbench,
    goal: JSON.stringify({ templateId, templateName, transactionType, field, required }), criteria });
  const runId = run.runId;

  async function round(step, purpose, args, pageLabel = 'p1') {
    const code = 'const workflow = await import(' + JSON.stringify(script) + '); return await workflow.' + step + '(task, page, input);';
    let execution = await service.browserRun({ runId, requestId: step, purpose, code, pageLabel, args, timeoutMs: 120000 });
    while (['queued', 'running'].includes(execution.state)) {
      await new Promise(resolve => setTimeout(resolve, 400));
      const state = await service.get({ runId, executionId: execution.executionId, limit: 1 });
      execution = state.executions[0];
    }
    return execution;
  }
  const finish = (outcome, note, verification = []) => service.finish({ runId, requestId: 'finish-' + outcome,
    outcome, decision: 'no-change', note, verification });
  async function interrupted(execution) {
    if (execution.state === 'failed') await finish('failed', execution.error.message);
    return { runId, status: execution.state, error: execution.error, executionId: execution.executionId };
  }

  const lookup = await round('locate', 'observe', { templateId, templateName, transactionType, field });
  if (lookup.state !== 'succeeded') return interrupted(lookup);
  const { designerUrl, pageLabel, ...target } = lookup.result;
  if (target.status) {
    await finish('cancelled', target.status);
    return { runId, ...target };
  }
  const before = target.required;
  const identity = { templateId: target.templateId, templateName: target.templateName,
    transactionType: target.transactionType, field: target.field, fieldName: target.fieldName };
  let write;
  if (before !== required) {
    write = await round('update', 'execute', { ...identity, designerUrl, desired: required }, pageLabel);
    if (write.state === 'outcome_unknown' && !write.executionStopped) return interrupted(write);
  }
  const observed = await round('verify', 'observe', { ...identity, designerUrl });
  if (observed.state !== 'succeeded') return interrupted(observed);
  const actual = observed.result;
  const verified = actual.templateId === target.templateId && actual.field === target.field && actual.required === required;
  const verification = criteria.map(c => ({ criterionId: c.id, observationId: observed.observationId }));
  await finish(verified ? 'succeeded' : 'failed', verified ? 'Reopened template and read the requested header field' :
    'Reopened template did not show the requested property', verified ? verification : []);
  return { runId, ...identity, before, after: actual.required ?? null, verified, observationId: observed.observationId,
    status: verified ? write?.result?.changed ? 'updated' : before === required ? 'already_set' : 'verified' : 'verification_failed',
    ...(write?.error ? { writeError: write.error.message } : {}) };
}
module.exports = { updateTemplateField };
